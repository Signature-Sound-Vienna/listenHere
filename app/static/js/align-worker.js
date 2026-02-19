/*
 * align-worker.js
 * Web Worker for in-browser audio alignment using Pyodide (numpy + scipy).
 * Computes chroma features via STFT, aligns recordings using DTW.
 *
 * Architecture:
 *   Main thread: decodes audio to Float32Array @ 22050 Hz (Web Audio API)
 *   This worker: receives PCM arrays, runs Python alignment via Pyodide
 *   Output: alignment JSON (same format as the SSV alignment workflow)
 *
 * Performance notes (10 Hz chroma, full DTW):
 *   5 min audio (~3000 frames): ~5-15 sec/pair
 *   10 min audio (~6000 frames): ~20-60 sec/pair
 *   15 min audio (~9000 frames): ~45-120 sec/pair
 *
 * Score-to-audio alignment (synthesis approach):
 *   MIDI → additive sine-wave synthesis (SR = 22050 Hz)
 *   Same STFT chroma pipeline as real audio → comparable feature spaces
 *   SCORE_FEATURE_RATE = 16 Hz; Sakoe-Chiba band keeps DTW memory bounded
 *   Anti-diagonal vectorised DTW (~100× faster than pure-Python loop)
 *   Typical wall time for a 5-10 min piece: 10-40 sec
 */

importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

/* Post progress updates to the main thread */
function reportProgress(message, pct) {
  self.postMessage({
    type: "progress",
    message: String(message),
    pct: pct !== undefined && pct !== null ? Number(pct) : -1,
  });
}

/* Post structured step updates for the progress list */
function reportStep(phase, step, file, index, total, elapsed) {
  self.postMessage({
    type: "step",
    phase: String(phase),
    step: String(step),
    file: file != null ? String(file) : null,
    index: index != null ? Number(index) : null,
    total: total != null ? Number(total) : null,
    elapsed: elapsed != null ? Number(elapsed) : null,
  });
}

const PYTHON_CODE = `
import numpy as np
from scipy.interpolate import interp1d
from js import reportProgress, reportStep
import time as _time

SR = 22050
FEATURE_RATE = 10        # Hz — audio-to-audio alignment
HOP = SR // FEATURE_RATE  # 2205 samples
N_FFT = 4096
ANNOTATION_STEP = 0.02   # seconds (50 Hz output grid)

# Score-to-audio alignment
# Uses the same feature rate as audio-to-audio (lower memory, still adequate).
# A two-level scheme: features are pooled by SCORE_DOWNSAMPLE for a cheap
# unconstrained coarse DTW that captures global structure; notes are then
# mapped through the coarse warping path via interpolation.
SCORE_FEATURE_RATE = 10  # Hz (HOP = 2205 samples)
SCORE_HOP  = SR // SCORE_FEATURE_RATE
SCORE_N_FFT = 4096
SCORE_DOWNSAMPLE = 2     # pool by this factor => coarse at 5 Hz
ONSET_N_FFT = 1024       # short window (46 ms) for sharp onset detection
ONSET_WEIGHT = 2.0       # chroma scale-up factor at detected onsets


def _stft_mag(audio, n_fft, hop):
    """Memory-efficient chunked magnitude STFT in float32.
    Processes CHUNK frames at a time so peak transient memory is
    ~CHUNK * n_fft * 8 bytes regardless of audio length.
    Returns shape (n_fft//2+1, n_frames), dtype float32.
    """
    audio = np.asarray(audio, dtype=np.float32)
    # Pad so every frame is fully contained
    audio_pad = np.concatenate([audio, np.zeros(n_fft, dtype=np.float32)])
    window = np.hanning(n_fft).astype(np.float32)
    n_frames = max(1, (len(audio) - n_fft) // hop + 1)
    mag = np.zeros((n_fft // 2 + 1, n_frames), dtype=np.float32)
    CHUNK = 256   # ~4 MB windowed + ~4 MB spec at N_FFT=4096
    s = audio_pad.strides[0]
    for cs in range(0, n_frames, CHUNK):
        ce = min(n_frames, cs + CHUNK)
        frames = np.lib.stride_tricks.as_strided(
            audio_pad[cs * hop:],
            shape=(ce - cs, n_fft),
            strides=(s * hop, s)
        )
        windowed = frames * window
        spec = np.fft.rfft(windowed, axis=1)
        mag[:, cs:ce] = np.abs(spec).astype(np.float32).T
        del windowed, spec
    return mag


def _mag_to_chroma(mag, n_fft):
    """Fold a magnitude STFT (n_fft//2+1, n_frames) into 12-bin L2-norm chroma (float32)."""
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / SR)  # Hz per bin
    valid = freqs > 50
    freqs_v = freqs[valid]
    mag_v = mag[valid, :]
    midi_f = 69.0 + 12.0 * np.log2(np.maximum(freqs_v, 1e-9) / 440.0)
    pitch_class = np.round(midi_f).astype(int) % 12
    chroma = np.zeros((12, mag_v.shape[1]), dtype=np.float32)
    for pc in range(12):
        mask = pitch_class == pc
        if np.any(mask):
            chroma[pc] = mag_v[mask].sum(axis=0)
    del mag_v
    norms = np.linalg.norm(chroma, axis=0, keepdims=True)
    norms[norms < 1e-8] = 1.0
    chroma /= norms
    return chroma  # (12, n_frames), float32


def compute_chroma(audio):
    """12-bin chroma features from audio (audio-to-audio alignment rate)."""
    mag = _stft_mag(audio, N_FFT, HOP)
    chroma = _mag_to_chroma(mag, N_FFT)
    del mag
    return chroma  # (12, n_frames)


def compute_chroma_score(audio):
    """12-bin chroma at SCORE_HOP resolution for score-to-audio alignment."""
    mag = _stft_mag(audio, SCORE_N_FFT, SCORE_HOP)
    chroma = _mag_to_chroma(mag, SCORE_N_FFT)
    del mag
    return chroma  # (12, n_frames)


def compute_onset_strength(audio):
    """Spectral-flux onset strength, same temporal grid as compute_chroma_score.
    Uses a short ONSET_N_FFT window for fine temporal resolution.
    Returns (n_frames,) float32, normalised to [0, 1].
    """
    mag = _stft_mag(audio, ONSET_N_FFT, SCORE_HOP)  # (bins, n_frames)
    # Half-wave rectified spectral difference averaged across bins
    flux = np.maximum(np.float32(0.0), mag[:, 1:] - mag[:, :-1]).mean(axis=0)
    del mag
    flux = np.concatenate([[np.float32(0.0)], flux.astype(np.float32)])
    # Smooth with a 5-tap boxcar to suppress single-bin noise
    kernel = np.ones(5, dtype=np.float32) / np.float32(5.0)
    flux = np.convolve(flux, kernel, mode='same')
    mx = flux.max()
    if mx > 1e-8:
        flux /= mx
    return flux  # (n_frames,)


def build_score_features(chroma, onset):
    """Onset-weighted chroma: scale each frame by (1 + ONSET_WEIGHT * onset),
    then L2-renormalise.  Amplifies attack moments in both score and real audio
    so DTW strongly prefers aligning them together (approximates DLNCO).
    """
    scale = (np.float32(1.0) + np.float32(ONSET_WEIGHT) * onset)  # (n_frames,)
    weighted = chroma * scale[np.newaxis, :]
    norms = np.linalg.norm(weighted, axis=0, keepdims=True)
    norms[norms < 1e-8] = np.float32(1.0)
    return (weighted / norms).astype(np.float32)


def _pool_features(feat, factor):
    """Mean-pool feature matrix along time by integer factor, then L2-renormalise."""
    D, T = feat.shape
    T_c = T // factor
    if T_c == 0:
        return feat
    pooled = feat[:, :T_c * factor].reshape(D, T_c, factor).mean(axis=2)
    norms = np.linalg.norm(pooled, axis=0, keepdims=True)
    norms[norms < 1e-8] = np.float32(1.0)
    return (pooled / norms).astype(np.float32)


def synth_midi_audio(notes, tpq, tcs, duration):
    """Render MIDI notes to a mono PCM array via additive sine-wave synthesis.
    Uses the first 4 harmonics with 1/k amplitude weighting (sawtooth-like
    timbre) to spread energy across pitch classes, matching real audio spectra
    better than pure sinusoids.
    """
    n_samples = int(np.ceil(duration * SR))
    audio = np.zeros(n_samples, dtype=np.float32)
    t = np.arange(n_samples, dtype=np.float32) / SR
    nyquist = SR / 2.0
    N_HARMONICS = 6
    # Amplitude envelope: 10 ms attack, 20 ms release per note (cheap ADSR)
    ATK = int(0.010 * SR)
    REL = int(0.020 * SR)
    for st, et, pitch, vel in notes:
        ts = _tick_to_sec(st, tpq, tcs)
        te = _tick_to_sec(et, tpq, tcs)
        i0 = int(ts * SR)
        i1 = min(n_samples, int(te * SR) + REL)
        if i0 >= n_samples or i1 <= i0:
            continue
        amp = (vel / 127.0) * 0.15  # keep overall level modest
        f0  = 440.0 * 2.0 ** ((pitch - 69) / 12.0)
        seg = np.zeros(i1 - i0, dtype=np.float32)
        for k in range(1, N_HARMONICS + 1):
            fk = f0 * k
            if fk >= nyquist:
                break
            seg += np.float32(amp / k) * np.sin(np.float32(2.0 * np.pi * fk) * t[i0:i1])
        # Simple envelope
        env = np.ones(len(seg))
        atk_end = min(ATK, len(seg))
        env[:atk_end] = np.linspace(0.0, 1.0, atk_end)
        note_len = min(int((te - ts) * SR), len(seg))
        rel_start = max(0, note_len - REL)
        rel_end   = min(len(seg), note_len)
        if rel_end > rel_start:
            env[rel_start:rel_end] = np.linspace(1.0, 0.0, rel_end - rel_start)
        if note_len < len(seg):
            env[note_len:] = 0.0
        audio[i0:i1] += seg * env
    # Peak-normalise
    peak = np.max(np.abs(audio))
    if peak > 1e-6:
        audio /= peak
    return audio.astype(np.float32)


def dtw_band(C, band):
    """DTW with Sakoe-Chiba band using anti-diagonal vectorisation.
    C: (N, M) float32 cost matrix (will be modified in place).
    band: integer half-bandwidth in frames.
    Returns warping path ndarray (2, L).
    """
    N, M = C.shape
    D = np.full((N, M), np.inf, dtype=np.float32)
    D[0, 0] = C[0, 0]

    report_every = max(1, (N + M) // 20)
    # Anti-diagonal sweep: d = i + j ranges from 0 to N+M-2
    for d in range(1, N + M - 1):
        if d % report_every == 0:
            reportProgress(f"  DTW progress: {100 * d // (N + M)}%")
        # Row range for this anti-diagonal
        i_lo = max(0, d - M + 1)
        i_hi = min(N - 1, d)
        # Apply Sakoe-Chiba: |i - j| = |i - (d-i)| = |2i - d| <= band
        half = band
        i_lo = max(i_lo, (d - half + 1) // 1)  # j = d - i <= i + band => i >= (d-band)/2
        i_lo = max(i_lo, (d - half))             # i >= d - band (j <= band)
        i_hi = min(i_hi, d + half)               # i <= d + band (j >= -band)
        # Convert to integer range and clamp
        i_lo = int(max(i_lo, 0))
        i_hi = int(min(i_hi, N - 1))
        if i_lo > i_hi:
            continue
        rows = np.arange(i_lo, i_hi + 1, dtype=np.int32)
        cols = d - rows  # j = d - i
        # Clamp cols that may fall outside [0, M-1] due to rounding
        valid = (cols >= 0) & (cols < M)
        rows = rows[valid]
        cols = cols[valid]
        if len(rows) == 0:
            continue

        # Three predecessors: (i-1,j-1), (i-1,j), (i,j-1)
        prev_diag = np.where((rows > 0) & (cols > 0),
                             D[rows - 1, cols - 1], np.inf)
        prev_vert = np.where(rows > 0, D[rows - 1, cols], np.inf)
        prev_horiz = np.where(cols > 0, D[rows, cols - 1], np.inf)
        best = np.minimum(np.minimum(prev_diag, prev_vert), prev_horiz)
        D[rows, cols] = C[rows, cols] + best

    # Backtrack
    i, j = N - 1, M - 1
    path_i, path_j = [i], [j]
    while i > 0 or j > 0:
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            d_diag  = D[i-1, j-1]
            d_vert  = D[i-1, j]
            d_horiz = D[i, j-1]
            if d_diag <= d_vert and d_diag <= d_horiz:
                i -= 1; j -= 1
            elif d_vert <= d_horiz:
                i -= 1
            else:
                j -= 1
        path_i.append(i)
        path_j.append(j)
    path_i.reverse()
    path_j.reverse()
    return np.array([path_i, path_j])


def dtw(C):
    """Standard DTW on cost matrix C (N x M). Returns warping path (2, L)."""
    N, M = C.shape
    D = np.full((N, M), np.inf, dtype=np.float64)
    D[0, 0] = C[0, 0]

    # First row
    for j in range(1, M):
        D[0, j] = D[0, j - 1] + C[0, j]
    # First column
    for i in range(1, N):
        D[i, 0] = D[i - 1, 0] + C[i, 0]

    # Fill matrix
    report_every = max(1, N // 20)
    for i in range(1, N):
        if i % report_every == 0:
            reportProgress(f"  DTW progress: {100 * i // N}%")
        for j in range(1, M):
            D[i, j] = C[i, j] + min(D[i-1, j-1], D[i-1, j], D[i, j-1])

    # Backtrack (prefer diagonal moves for temporal consistency)
    i, j = N - 1, M - 1
    path_i, path_j = [i], [j]
    while i > 0 or j > 0:
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            d = D[i-1, j-1]
            v = D[i-1, j]
            h = D[i, j-1]
            if d <= v and d <= h:
                i -= 1; j -= 1
            elif v <= h:
                i -= 1
            else:
                j -= 1
        path_i.append(i)
        path_j.append(j)

    path_i.reverse()
    path_j.reverse()
    return np.array([path_i, path_j])


def make_monotonic(wp):
    """Make warping path strictly monotonic."""
    # Keep last occurrence of each unique row index
    last_for_i = {}
    for k in range(wp.shape[1]):
        last_for_i[int(wp[0, k])] = k
    keep = sorted(last_for_i.values())
    wp = wp[:, keep]

    # Keep last occurrence of each unique column index
    last_for_j = {}
    for k in range(wp.shape[1]):
        last_for_j[int(wp[1, k])] = k
    keep = sorted(last_for_j.values())
    return wp[:, keep]


def align_pair(ref_chroma, other_chroma, ref_duration, other_duration):
    """Align two recordings via chroma DTW. Returns transferred annotations."""
    # Cost matrix: cosine distance (= 1 - dot product for L2-normalized vectors)
    C = 1.0 - ref_chroma.T @ other_chroma
    np.clip(C, 0, 2, out=C)
    C = C.astype(np.float32)

    # DTW
    wp = dtw(C)
    del C   # free memory before backtrack result is used
    wp = make_monotonic(wp)

    # Convert frame indices to times
    n_ref = ref_chroma.shape[1]
    n_other = other_chroma.shape[1]
    ref_times = wp[0].astype(np.float64) * ref_duration / max(n_ref - 1, 1)
    other_times = wp[1].astype(np.float64) * other_duration / max(n_other - 1, 1)

    # Transfer isochronous reference annotations to other recording
    ref_grid = np.arange(0, ref_duration, ANNOTATION_STEP)
    transferred = interp1d(
        ref_times, other_times, kind='linear', fill_value='extrapolate'
    )(ref_grid)
    return transferred.tolist()


def bulk_align(audio_dict, ref_name):
    """
    Align multiple recordings to a reference.
    audio_dict: {filename: np.array of float32 samples at 22050 Hz}
    ref_name: filename of the reference recording
    Returns: alignment JSON structure
    """
    filenames = list(audio_dict.keys())
    n = len(filenames)

    # Extract chroma features
    chromas = {}
    durations = {}
    for i, name in enumerate(filenames):
        reportStep("features", "start", name, i + 1, n, None)
        reportProgress(f"Extracting features: {name} ({i+1}/{n})",
                       int(10 + 20 * i / n))
        t0 = _time.time()
        audio = audio_dict[name]
        chromas[name] = compute_chroma(audio)
        durations[name] = len(audio) / SR
        elapsed = _time.time() - t0
        reportStep("features", "done", name, i + 1, n, elapsed)

    # Free raw audio to save memory
    del audio_dict

    # Reference isochronous grid
    ref_duration = durations[ref_name]
    ref_grid = np.arange(0, ref_duration, ANNOTATION_STEP)

    # Align each recording to the reference
    result = {}
    pair_count = 0
    total_pairs = max(1, n - 1)
    for name in filenames:
        if name == ref_name:
            result[name] = ref_grid.tolist()
        else:
            pair_count += 1
            reportStep("align", "start", name, pair_count, total_pairs, None)
            reportProgress(
                f"Aligning: {name} ({pair_count}/{total_pairs})",
                int(30 + 65 * pair_count / total_pairs)
            )
            t0 = _time.time()
            result[name] = align_pair(
                chromas[ref_name], chromas[name],
                ref_duration, durations[name]
            )
            elapsed = _time.time() - t0
            reportStep("align", "done", name, pair_count, total_pairs, elapsed)

    reportProgress("Done!", 100)
    return {
        "header": {"ref": ref_name},
        "body": {"audio": result}
    }


# --- MIDI parsing and score alignment ---

def _read_varlen(data, pos):
    val = 0
    while True:
        b = data[pos]; pos += 1
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80):
            break
    return val, pos

def parse_midi(midi_bytes):
    """Parse a Standard MIDI File. Returns (tpq, tempo_changes, notes).
    notes: [(start_tick, end_tick, pitch, velocity), ...]
    tempo_changes: [(tick, microseconds_per_beat), ...]
    """
    import struct
    pos = 0
    if midi_bytes[pos:pos+4] != b'MThd':
        raise ValueError("Not a MIDI file")
    pos += 4
    hlen = struct.unpack('>I', midi_bytes[pos:pos+4])[0]; pos += 4
    pos += 2  # format
    n_tr = struct.unpack('>H', midi_bytes[pos:pos+2])[0]; pos += 2
    tpq  = struct.unpack('>H', midi_bytes[pos:pos+2])[0]; pos += 2
    pos  = 8 + hlen

    tempo_changes = [(0, 500000)]  # default 120 BPM
    notes = []

    for _ in range(n_tr):
        if midi_bytes[pos:pos+4] != b'MTrk':
            break
        pos += 4
        tlen = struct.unpack('>I', midi_bytes[pos:pos+4])[0]; pos += 4
        end  = pos + tlen
        tick = 0; rs = 0
        active = {}

        while pos < end:
            delta, pos = _read_varlen(midi_bytes, pos)
            tick += delta
            b = midi_bytes[pos]
            if b == 0xFF:                      # meta event
                pos += 1
                mtype = midi_bytes[pos]; pos += 1
                mlen, pos = _read_varlen(midi_bytes, pos)
                if mtype == 0x51 and mlen == 3:
                    uspb = struct.unpack('>I', b'\\x00' + bytes(midi_bytes[pos:pos+3]))[0]
                    tempo_changes.append((tick, uspb))
                pos += mlen
            elif b in (0xF0, 0xF7):            # sysex
                pos += 1
                slen, pos = _read_varlen(midi_bytes, pos)
                pos += slen
            else:
                if b & 0x80: rs = b; pos += 1
                kind = rs >> 4; ch = rs & 0xF
                if kind == 0x9:
                    p = midi_bytes[pos]; pos += 1
                    v = midi_bytes[pos]; pos += 1
                    if v > 0:
                        active[(ch, p)] = (tick, v)
                    else:
                        if (ch, p) in active:
                            st, sv = active.pop((ch, p))
                            notes.append((st, tick, p, sv))
                elif kind == 0x8:
                    p = midi_bytes[pos]; pos += 1
                    pos += 1  # velocity ignored for note-off
                    if (ch, p) in active:
                        st, sv = active.pop((ch, p))
                        notes.append((st, tick, p, sv))
                elif kind in (0xA, 0xB, 0xE): pos += 2
                elif kind in (0xC, 0xD):      pos += 1

        # Close notes still open at end of track
        for (ch, p), (st, sv) in active.items():
            notes.append((st, tick, p, sv))
        pos = end

    tempo_changes.sort()
    notes.sort()
    return tpq, tempo_changes, notes

def _tick_to_sec(tick, tpq, tcs):
    secs = 0.0; pt = 0; pu = 500000
    for ct, cu in tcs:
        if ct >= tick: break
        secs += (ct - pt) / tpq * pu / 1e6
        pt = ct; pu = cu
    return secs + (tick - pt) / tpq * pu / 1e6

def score_align(midi_bytes_py, ref_audio, mei_uri):
    """
    Align MIDI score to reference audio via multi-resolution chroma DTW.

    Pipeline:
      1. Parse SMF MIDI → notes + complete tempo map
      2. Synthesise to mono PCM (additive sine harmonics) — puts synth and
         real audio in the same STFT feature space
      3. Extract STFT chroma (SCORE_N_FFT) and spectral-flux onset strength
         (ONSET_N_FFT, finer window) for both synth and reference
      4. Scale each chroma frame by (1 + ONSET_WEIGHT * onset), renormalise
         → attack moments dominate the cost matrix, stabilising alignment
         for ensemble music (approximates DLNCO onset weighting)
      5. Coarse DTW: pool features by SCORE_DOWNSAMPLE (=> ~5 Hz),
         run fully unconstrained DTW on the small matrix.  This captures
         global structure — the essential fix for the 'random' failure mode
         that plagued a single-level SC-band approach.
      6. Map each deduplicated note onset/offset through the coarse warping
         path via linear interpolation → final score-to-audio alignment.

    Returns dict: score_onset, ref_onset, score_offset, ref_offset
    (score times in quarter-notes; ref times in seconds).
    """
    t0_total = _time.time()
    reportStep("score", "start", "Score alignment", None, None, None)

    reportProgress("Score alignment: parsing MIDI...", None)
    tpq, tcs, notes = parse_midi(midi_bytes_py)
    if not notes:
        reportStep("score", "done", "Score alignment", None, None, 0.0)
        return None

    max_tick = max(n[1] for n in notes)
    midi_dur = _tick_to_sec(max_tick, tpq, tcs) + 0.5
    ref_dur  = len(ref_audio) / SR

    reportProgress("Score alignment: synthesising MIDI audio...", None)
    synth_audio = synth_midi_audio(notes, tpq, tcs, midi_dur)

    reportProgress("Score alignment: extracting chroma features...", None)
    sc = compute_chroma_score(synth_audio)
    rc = compute_chroma_score(ref_audio)

    reportProgress("Score alignment: extracting onset features...", None)
    sc_onset = compute_onset_strength(synth_audio)
    del synth_audio
    rc_onset = compute_onset_strength(ref_audio)

    # Trim/pad onset arrays to match chroma frame count
    n_sc = sc.shape[1];  n_rc = rc.shape[1]
    sc_onset = sc_onset[:n_sc] if len(sc_onset) >= n_sc else np.pad(sc_onset, (0, n_sc - len(sc_onset)))
    rc_onset = rc_onset[:n_rc] if len(rc_onset) >= n_rc else np.pad(rc_onset, (0, n_rc - len(rc_onset)))

    # Onset-weighted chroma features
    sc_feat = build_score_features(sc, sc_onset)
    rc_feat = build_score_features(rc, rc_onset)
    del sc, rc, sc_onset, rc_onset

    # --- Coarse DTW (unconstrained) on downsampled features ---
    reportProgress("Score alignment: coarse DTW...", None)
    sc_c = _pool_features(sc_feat, SCORE_DOWNSAMPLE)
    rc_c = _pool_features(rc_feat, SCORE_DOWNSAMPLE)
    del sc_feat, rc_feat   # no fine-DTW pass needed
    n_sc_c = sc_c.shape[1]
    n_rc_c = rc_c.shape[1]

    C_c = (np.float32(1.0) - sc_c.T @ rc_c).astype(np.float32)
    np.clip(C_c, 0, 2, out=C_c)
    del sc_c, rc_c
    # Pass band=max(shape) to dtw_band → effectively unconstrained
    wp_c = make_monotonic(dtw_band(C_c, max(C_c.shape)))
    del C_c

    # Coarse path → time mapping (each frame spans SCORE_DOWNSAMPLE * SCORE_HOP seconds)
    sc_times_c = wp_c[0].astype(np.float64) * midi_dur / max(n_sc_c - 1, 1)
    rc_times_c = wp_c[1].astype(np.float64) * ref_dur  / max(n_rc_c - 1, 1)
    del wp_c
    wf = interp1d(sc_times_c, rc_times_c, kind='linear', fill_value='extrapolate')

    # Deduplicate chord notes: one entry per unique (onset_tick, offset_tick)
    seen = {}
    for st, et, pitch, vel in sorted(notes, key=lambda x: (x[0], x[1])):
        if (st, et) not in seen:
            seen[(st, et)] = vel

    s_on = []; r_on = []; s_off = []; r_off = []; s_on_sec = []; s_off_sec = []
    for (st, et), vel in sorted(seen.items()):
        t_on  = _tick_to_sec(st, tpq, tcs)
        t_off = _tick_to_sec(et, tpq, tcs)
        s_on.append(st  / tpq)
        s_off.append(et / tpq)
        s_on_sec.append(t_on)   # MIDI-derived seconds = position in synthesised audio
        s_off_sec.append(t_off)
        r_on.append(float(np.clip(wf(t_on),  0.0, ref_dur)))
        r_off.append(float(np.clip(wf(t_off), 0.0, ref_dur)))

    elapsed = _time.time() - t0_total
    reportStep("score", "done", "Score alignment", None, None, elapsed)
    return {
        "score_onset":  s_on,
        "ref_onset":    r_on,
        "score_offset": s_off,
        "ref_offset":   r_off,
        "synth_onset":  s_on_sec,   # listen.js uses these to build the synth waveform’s alignment grid
        "synth_offset": s_off_sec,
    }
`;

/* --- Pyodide lifecycle --- */

let pyodideReady = null;

async function initPyodide() {
  reportProgress("Loading Python runtime...", 0);
  const pyodide = await loadPyodide();
  reportProgress(
    "Installing numpy and scipy (first load may take a moment)...",
    3,
  );
  await pyodide.loadPackage(["numpy", "scipy"]);
  reportProgress("Initializing alignment engine...", 8);
  await pyodide.runPythonAsync(PYTHON_CODE);
  return pyodide;
}

/* --- Message handler --- */

self.onmessage = async function (e) {
  if (e.data.type === "align") {
    try {
      if (!pyodideReady) pyodideReady = initPyodide();
      const pyodide = await pyodideReady;

      const { audios, refName, meiMidi, meiUri } = e.data;
      // audios: [{name: string, samples: Float32Array}, ...]

      // Pass each audio buffer to Python globals
      for (let i = 0; i < audios.length; i++) {
        pyodide.globals.set("_audio_name_" + i, audios[i].name);
        pyodide.globals.set("_audio_data_" + i, audios[i].samples);
      }
      pyodide.globals.set("_n_audios", audios.length);
      pyodide.globals.set("_ref_name", refName);
      pyodide.globals.set("_has_mei", !!(meiMidi && meiMidi.length > 0));
      if (meiMidi && meiMidi.length > 0) {
        pyodide.globals.set("_midi_bytes", meiMidi);
        pyodide.globals.set("_mei_uri", meiUri || "");
      }

      // Run alignment in Python (audio + optional score)
      const resultJson = await pyodide.runPythonAsync(`
import json
import numpy as np

# Build audio dict from JS globals
audio_dict = {}
for i in range(int(_n_audios)):
    name = str(globals()[f'_audio_name_{i}'])
    data_proxy = globals()[f'_audio_data_{i}']
    audio_dict[name] = np.frombuffer(data_proxy.to_py(), dtype=np.float32).copy()
    del globals()[f'_audio_name_{i}']
    del globals()[f'_audio_data_{i}']

# Keep a copy of the reference audio for optional score alignment
ref_audio_copy = audio_dict[str(_ref_name)].copy() if bool(_has_mei) else None

result = bulk_align(audio_dict, str(_ref_name))
del audio_dict

# Score alignment if MEI MIDI was provided
if bool(_has_mei) and ref_audio_copy is not None:
    midi_bytes_py = bytes(_midi_bytes.to_py())
    score_data = score_align(midi_bytes_py, ref_audio_copy, str(_mei_uri))
    del ref_audio_copy, midi_bytes_py
    if score_data:
        result["body"]["score"] = score_data
        result["header"]["meiUri"] = str(_mei_uri)
elif ref_audio_copy is not None:
    del ref_audio_copy

json.dumps(result)
`);

      self.postMessage({
        type: "result",
        alignment: JSON.parse(resultJson),
      });
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err.toString(),
      });
    }
  }
};
