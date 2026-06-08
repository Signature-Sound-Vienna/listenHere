// audio-seek-index.js
//
// Builds an in-memory time<->byte seek index for "frame-stream" audio formats
// (VBR MP3, ADTS AAC) whose HTML <audio> seeking is inaccurate because the
// browser must estimate byte position from time. The index lets a Web-Audio
// player decode exact byte ranges for sample-accurate seeking.
//
// Everything here is a cheap linear scan of frame *headers* (no decoding).
//
// Public API:
//   analyzeAudio(arrayBuffer) -> AudioAnalysis | null
//     Returns null for formats that seek fine natively (CBR MP3, WAV, Ogg,
//     FLAC, MP4/M4A, …) — caller should leave those on the default path.
//     Otherwise returns an index describing a format that needs accurate seek.
//
// AudioAnalysis = {
//   format: 'mp3' | 'aac-adts',
//   vbr: boolean,
//   sampleRate, channels, samplesPerFrame,
//   frameCount, totalSamples, duration,
//   frameOffsets: Int32Array,   // byte offset of each frame's first byte
//   lookup(timeSec) -> { frameIndex, byteOffset, frameStartSample, sampleOffset }
// }

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1];
const MP3_SR = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};
const AAC_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Skip a leading ID3v2 tag if present; return the byte offset of audio data. */
function skipId3v2(bytes) {
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // ID3 size is a 28-bit syncsafe integer in bytes 6..9
    const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    return 10 + size;
  }
  return 0;
}

function attachLookup(idx) {
  const { frameOffsets, samplesPerFrame, sampleRate, frameCount, totalSamples } = idx;
  idx.lookup = (timeSec) => {
    const targetSample = Math.max(0, Math.min(totalSamples - 1, Math.round(timeSec * sampleRate)));
    let frameIndex = Math.floor(targetSample / samplesPerFrame);
    if (frameIndex >= frameCount) frameIndex = frameCount - 1;
    const frameStartSample = frameIndex * samplesPerFrame;
    return {
      frameIndex,
      byteOffset: frameOffsets[frameIndex],
      frameStartSample,
      sampleOffset: targetSample - frameStartSample,
    };
  };
  return idx;
}

/** Parse an MP3 frame stream. Returns analysis or null if it doesn't look like MP3. */
function analyzeMp3(bytes, start) {
  let pos = start;
  const offsets = [];
  let samplesPerFrame = 0;
  let sampleRate = 0;
  let channels = 0;
  const bitrateSet = new Set();
  let sawXing = false;
  let sawInfo = false;

  // Find the first valid frame within a small window.
  const scanLimit = Math.min(bytes.length - 4, start + 200000);
  while (pos < scanLimit) {
    if (bytes[pos] === 0xff && (bytes[pos + 1] & 0xe0) === 0xe0) break;
    pos++;
  }

  while (pos + 4 <= bytes.length) {
    const b0 = bytes[pos], b1 = bytes[pos + 1], b2 = bytes[pos + 2], b3 = bytes[pos + 3];
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) break; // lost sync -> end of contiguous stream

    const versionBits = (b1 >> 3) & 0x3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
    const layerBits = (b1 >> 1) & 0x3; // 1 = Layer III
    if (versionBits === 1 || layerBits !== 1) break; // only Layer III supported here

    const brIndex = (b2 >> 4) & 0xf;
    const srIndex = (b2 >> 2) & 0x3;
    const padding = (b2 >> 1) & 0x1;
    if (brIndex === 0 || brIndex === 15 || srIndex === 3) break; // free/invalid -> bail

    const isV1 = versionBits === 3;
    const bitrate = (isV1 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[brIndex] * 1000;
    const sr = MP3_SR[versionBits][srIndex];
    const spf = isV1 ? 1152 : 576;
    const coeff = isV1 ? 144 : 72;
    const frameLen = Math.floor((coeff * bitrate) / sr) + padding;
    if (frameLen < 4) break;

    if (!samplesPerFrame) {
      samplesPerFrame = spf;
      sampleRate = sr;
      const chanMode = (b3 >> 6) & 0x3;
      channels = chanMode === 3 ? 1 : 2;

      // Detect Xing/Info tag in the first frame (corroborates VBR vs CBR).
      const sideInfo = isV1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
      const tagPos = pos + 4 + sideInfo;
      const tag = String.fromCharCode(bytes[tagPos], bytes[tagPos + 1], bytes[tagPos + 2], bytes[tagPos + 3]);
      if (tag === "Xing") sawXing = true;
      else if (tag === "Info") sawInfo = true;
    }

    offsets.push(pos);
    bitrateSet.add(brIndex);
    pos += frameLen;
  }

  if (offsets.length < 2 || !sampleRate) return null;

  // VBR if bitrate varied across frames, or a Xing (not Info) tag is present.
  // The first frame may be a Xing/Info header frame; ignore single-frame noise.
  const vbr = bitrateSet.size > 1 || (sawXing && !sawInfo);

  const frameCount = offsets.length;
  const totalSamples = frameCount * samplesPerFrame;
  return attachLookup({
    format: "mp3",
    vbr,
    sampleRate,
    channels,
    samplesPerFrame,
    frameCount,
    totalSamples,
    duration: totalSamples / sampleRate,
    frameOffsets: Int32Array.from(offsets),
    _sawXing: sawXing,
    _sawInfo: sawInfo,
  });
}

/** Parse an ADTS AAC frame stream. Returns analysis or null. */
function analyzeAdtsAac(bytes, start) {
  let pos = start;
  const offsets = [];
  let sampleRate = 0;
  let channels = 0;
  let samplesPerFrame = 0; // ADTS raw block = 1024 samples
  const lenSet = new Set();

  // ADTS sync = 12 bits set; layer (2 bits) must be 0.
  const isSync = (p) => bytes[p] === 0xff && (bytes[p + 1] & 0xf6) === 0xf0;

  const scanLimit = Math.min(bytes.length - 7, start + 200000);
  while (pos < scanLimit && !isSync(pos)) pos++;

  while (pos + 7 <= bytes.length) {
    if (!isSync(pos)) break;
    const b2 = bytes[pos + 2], b3 = bytes[pos + 3], b4 = bytes[pos + 4], b5 = bytes[pos + 5], b6 = bytes[pos + 6];
    const srIndex = (b2 >> 2) & 0xf;
    if (srIndex >= AAC_SR.length) break;
    const chanCfg = ((b2 & 0x1) << 2) | ((b3 >> 6) & 0x3);
    const frameLen = ((b3 & 0x3) << 11) | (b4 << 3) | ((b5 >> 5) & 0x7);
    const rawBlocks = (b6 & 0x3) + 1;
    if (frameLen < 7) break;

    if (!sampleRate) {
      sampleRate = AAC_SR[srIndex];
      channels = chanCfg || 2;
      samplesPerFrame = 1024 * rawBlocks;
    }
    offsets.push(pos);
    lenSet.add(frameLen);
    pos += frameLen;
  }

  if (offsets.length < 2 || !sampleRate) return null;

  const frameCount = offsets.length;
  const totalSamples = frameCount * samplesPerFrame;
  return attachLookup({
    format: "aac-adts",
    vbr: lenSet.size > 1, // ADTS AAC is effectively always VBR
    sampleRate,
    channels,
    samplesPerFrame,
    frameCount,
    totalSamples,
    duration: totalSamples / sampleRate,
    frameOffsets: Int32Array.from(offsets),
  });
}

/**
 * Analyze an audio file. Returns an AudioAnalysis only for frame-stream formats
 * that need accurate-seek handling (VBR MP3 / ADTS AAC); otherwise null.
 */
export function analyzeAudio(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  if (bytes.length < 16) return null;

  const audioStart = skipId3v2(bytes);

  // Reject obvious container formats up front (they seek fine natively).
  const magic4 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic4 === "RIFF" || magic4 === "OggS" || magic4 === "fLaC") return null;
  // MP4/M4A: '....ftyp'
  if (String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp") return null;

  // ADTS AAC first (raw .aac) — sync 0xFFFx with layer 0.
  if (bytes[audioStart] === 0xff && (bytes[audioStart + 1] & 0xf6) === 0xf0) {
    const aac = analyzeAdtsAac(bytes, audioStart);
    if (aac) return aac.vbr ? aac : null;
  }

  // MP3 (Layer III) — only needs special handling when VBR.
  const mp3 = analyzeMp3(bytes, audioStart);
  if (mp3) return mp3.vbr ? mp3 : null;

  return null;
}

/** Convenience: does this file need the accurate-seek (windowed) playback path? */
export function needsAccurateSeek(arrayBuffer) {
  return analyzeAudio(arrayBuffer) !== null;
}
