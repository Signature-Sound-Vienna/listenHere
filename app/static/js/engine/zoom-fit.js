// engine/zoom-fit.js
//
// The one piece of zoom arithmetic two consumers must agree on: the px/sec that
// makes a waveform fit its container WITHOUT the one-pixel overflow that leaves
// a renderer permanently scrolled (the spec 28.3 bug). Extracted verbatim from
// zoom-scroll.js so the exhibit can import the fix instead of copying it —
// zoom-scroll.js itself is coupled to listen.js and stays that way, but this
// function only ever read its own arguments.
//
// No imports, no module state, no DOM. Keep it that way: the exhibit reaches
// this file through the spec 33 boundary test, which fails the build if
// anything here ever leads back to listen.js.

/**
 * pxPerSec that makes a waveform fit its container exactly at zoom 1.
 *
 * Two durations are in play and they are not the same number. `ws.getDuration()`
 * reports `media.duration`, read from the MP3 container header, but WaveSurfer's
 * renderer sizes the wrapper from the DECODED buffer:
 * `Math.ceil(decodedData.duration * minPxPerSec)`, treating anything wider than
 * the container as scrollable. Fitting against the header duration therefore
 * overshoots whenever the decoded audio is even microseconds longer — measured
 * on the test fixtures, +9µs on audio-a and audio-b and +5µs on audio-short,
 * enough for the ceil to round up to `containerWidth + 1`. The row then
 * overflows by one pixel, becomes scrollable with a maxScroll of 1, and holds a
 * stale `scrollLeft` of 1 that the redrawcomplete clamp cannot heal because 1 IS
 * the maximum. Files whose decoded duration matches or undershoots the header
 * (the synthesised score, audio-c) were unaffected — hence "some but not all".
 *
 * So fit against the duration the renderer will actually use. The half-pixel
 * fallback then guards the residual case where that product still ceils high in
 * floating point. Below the overflow threshold the row is not scrollable, so
 * fillParent draws it to the container's full width with no gap either side.
 *
 * The same trap bites peaks-only renderers (the exhibit's strips): their mock
 * decoded buffer's duration is float arithmetic over the peaks length, so the
 * naive `containerWidth / duration` reproduced the exact 997-over-996 overflow
 * on the first zoom-out probe.
 */
export function fitPxPerSec(containerWidth, ws) {
  // The renderer's own duration, not the media header's.
  const duration = ws.decodedData?.duration || ws.getDuration();
  if (!(containerWidth > 0) || !(duration > 0)) return 0;
  const exact = containerWidth / duration;
  return Math.ceil(duration * exact) > containerWidth
    ? (containerWidth - 0.5) / duration
    : exact;
}
