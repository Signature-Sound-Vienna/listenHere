// engine/time-axis.js
//
// Time-axis tick rendering for the waveform overlay canvases. Pure drawing over
// its arguments — no shared module state, no DOM, no WaveSurfer access — so it
// carries no imports back to listen.js.
//
// Extracted from listen.js (Phase 1 refactor, increment 4). Behaviour-preserving.

const _NICE_INTERVALS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600,
];

/** Format seconds for tick labels. */
function _formatTickTime(t) {
  if (t < 60) {
    // Show sub-second decimals only for small intervals
    return t % 1 === 0 ? String(t) : t.toFixed(1);
  }
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}

/**
 * Draw subtle time ticks at the top edge of a waveform overlay canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} viewW  visible viewport width in px
 * @param {number} h      canvas height
 * @param {number} fullW  full zoomed width of the waveform in px
 * @param {number} dur    duration in seconds
 * @param {number} scrollLeft  current scroll offset in px
 */
export function drawTimeTicks(ctx, viewW, h, fullW, dur, scrollLeft, bgColor, textColor, tickColor) {
  if (dur <= 0 || fullW <= 0) return;
  const pxPerSec = fullW / dur;
  const visibleSec = viewW / pxPerSec;

  // Choose a "nice" interval so we get roughly 60 ticks in the viewport
  const rawInterval = visibleSec / 60;
  const interval =
    _NICE_INTERVALS.find((n) => n >= rawInterval) ||
    _NICE_INTERVALS[_NICE_INTERVALS.length - 1];

  // Label every 2nd tick
  const labelEvery = 2;

  const startTime = (scrollLeft / fullW) * dur;
  const endTime = ((scrollLeft + viewW) / fullW) * dur;
  const firstTick = Math.ceil(startTime / interval) * interval;

  ctx.save();
  ctx.lineWidth = 1;

  for (let t = firstTick; t <= endTime + interval * 0.01; t += interval) {
    const x = Math.round((t / dur) * fullW - scrollLeft) + 0.5;
    if (x < -1 || x > viewW + 1) continue;

    // Label every 2nd tick
    const tickIndex = Math.round(t / interval);
    const isLabelled = tickIndex % labelEvery === 0;
    const tickH = isLabelled ? 7 : 4;

    ctx.strokeStyle = tickColor || "#505050";
    ctx.globalAlpha = isLabelled ? 0.75 : 0.35;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, tickH);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (isLabelled) {
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      const text = _formatTickTime(t);
      const tw = ctx.measureText(text).width;
      const pad = 1;
      ctx.fillStyle = bgColor || "rgba(255, 255, 255, 0.7)";
      ctx.fillRect(x - tw / 2 - pad, tickH, tw + pad * 2, 10);
      ctx.fillStyle = textColor || "rgba(60, 60, 60, 0.7)";
      ctx.fillText(text, x, tickH + 9);
    }
  }
  ctx.restore();
}
