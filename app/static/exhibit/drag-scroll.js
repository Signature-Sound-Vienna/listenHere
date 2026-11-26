// exhibit/drag-scroll.js
//
// A vertical scroller driven by the finger itself, for boxes inside the
// rotated stage (roadmap 29, the card in the side slot; user, 2026-11-25).
//
// WHY NOT NATIVE SCROLL: spike A (2026-11-19) measured that Chromium routes NO
// touch scroll through a `rotate(90deg)` — the box simply does not move — and
// the museum table turns its screen in CSS (`stageRotation`, ruled to stay so).
// So a card that is taller than its slot would be unreadable past its first
// screen. The spike's ruled fallback, mechanical paging, is what the timeline
// will use; this is its vertical, unpaged sibling: the content follows the
// finger 1:1 along the box's OWN vertical axis, then coasts on the release
// velocity and stops.
//
// Mouse wheels keep working natively (the spike: wheel deltas arrive in local
// axes), and a mouse drag scrolls too, which the kiosk never sees but a desk does.
//
// THE TRAP THE SPIKE PAID FOR: on touch the browser implicitly captures the
// pointer to the element under the finger (a button in the card, say), and
// taking the capture to the box makes that element fire `lostpointercapture`,
// which BUBBLES here. Only the box's own capture loss ends a drag.

/** Movement before a press becomes a drag; below it, a tap stays a tap. */
const DRAG_SLOP = 8;
/** Coasting: per-millisecond velocity decay, and the speed it stops under. */
const FRICTION = 0.0035;
const MIN_SPEED = 0.02; // px/ms

/**
 * Client delta → the box's local vertical, through the composed right-angle
 * rotation (main.js's marker rule, marker.js toLocal, as a delta).
 */
function localDy(dx, dy, rotation) {
  const rot = ((Math.round((Number(rotation) || 0) / 90) * 90) % 360 + 360) % 360;
  if (rot === 90) return -dx;
  if (rot === 180) return -dy;
  if (rot === 270) return dx;
  return dy;
}

/**
 * @param {HTMLElement} el            the scrolling box (overflow-y: auto)
 * @param {() => number} rotationOf   the box's total rotation on screen, degrees
 * @returns {() => void} detach
 */
export function attachDragScroll(el, rotationOf) {
  el.dataset.dragScroll = "1";
  let press = null; // { id, x, y, top, dragging, lastY, lastT, v }
  let coast = 0;
  let swallowClick = false;

  const stopCoast = () => {
    cancelAnimationFrame(coast);
    coast = 0;
  };

  const onDown = (e) => {
    if (e.button !== 0 || press) return;
    stopCoast();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, top: el.scrollTop, dragging: false, lastY: 0, lastT: e.timeStamp, v: 0 };
  };

  const onMove = (e) => {
    if (!press || e.pointerId !== press.id) return;
    const d = localDy(e.clientX - press.x, e.clientY - press.y, rotationOf());
    if (!press.dragging) {
      if (Math.abs(d) < DRAG_SLOP) return;
      press.dragging = true;
      // Measured from where the drag STARTED moving the content, so the slop
      // does not show up as a jump.
      press.y0 = d;
      press.lastY = d;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {
        /* the pointer may already be gone */
      }
    }
    el.scrollTop = press.top - (d - press.y0);
    const dt = e.timeStamp - press.lastT;
    if (dt > 0) {
      // A short smoothing, so one jittery last sample does not decide the coast.
      press.v = 0.7 * ((d - press.lastY) / dt) + 0.3 * press.v;
      press.lastY = d;
      press.lastT = e.timeStamp;
    }
    e.preventDefault();
  };

  const end = (e, coastOn) => {
    if (!press || e.pointerId !== press.id) return;
    const { dragging, v } = press;
    press = null;
    if (!dragging) return;
    // The click that ends a drag is not a tap on whatever lay under the finger.
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    if (!coastOn || Math.abs(v) < MIN_SPEED) return;
    let speed = v;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(32, now - last);
      last = now;
      el.scrollTop -= speed * dt;
      speed *= Math.exp(-FRICTION * dt);
      const atEnd = el.scrollTop <= 0 || el.scrollTop >= el.scrollHeight - el.clientHeight;
      coast = Math.abs(speed) < MIN_SPEED || atEnd ? 0 : requestAnimationFrame(step);
    };
    coast = requestAnimationFrame(step);
  };
  const onUp = (e) => end(e, true);
  const onCancel = (e) => end(e, false);
  const onLost = (e) => {
    if (e.target === el) end(e, true);
  };
  const onClick = (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove, { passive: false });
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("lostpointercapture", onLost);
  el.addEventListener("click", onClick, true);
  return () => {
    stopCoast();
    delete el.dataset.dragScroll;
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("lostpointercapture", onLost);
    el.removeEventListener("click", onClick, true);
  };
}
