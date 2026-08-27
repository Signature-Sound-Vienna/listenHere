// exhibit/marker.js
//
// The listening marker (?marker=glass — the week-4 "simplified close
// listening", ruled 2026-08-27 after the §4.4 design round). One marker per
// viewport, anchored as an ALIGNMENT INDEX so it names a musical moment on
// every strip at once — the same semantic as listen.js's mark button, whose
// production behaviour (a switch in close-listening mode lands on the active
// marker) is the precedent for the exhibit's "your bare switches land on your
// marker" rule. The arithmetic is align-core's, injected as `ixFor`/`timeFor`;
// this module owns only the PHYSICAL OBJECT.
//
// The object is a magnifying glass that RESTS on a hook beside the waveforms
// when unplaced (sketch B, ruled over long-tap placement): every marker
// gesture starts ON the glass, so the strips keep their one shipped meaning —
// tap = seek/switch — and there is no long-press recognizer, no Remove
// pop-over, and no string to translate. Placement and removal are the same
// physical gesture, in two forms:
//
//   DRAG   — pull the glass from its hook onto a waveform to place the marker,
//            drag it to move, pull it off the waveforms to remove it.
//   TAP    — tap the glass (or, under ?tapMode=direct with a marker standing,
//            any waveform — main.js routes that; the strap owns switching
//            there, so the glass mediates seeking while it is up) and it
//            LIFTS into expect-placement: the glass floats over the
//            waveforms, the strip stack pulses, and the next waveform tap
//            places it there. A lift is CANCEL-SAFE — the marker survives,
//            and a tap anywhere else settles the glass back onto it (or onto
//            the hook when none stands) while that tap still does its own
//            job: observed at capture, never stolen. Removal by tap is the
//            HOOK, tapped while the glass is in hand ("put it away").
//
// The other viewport's marker appears here as a MIRRORED GHOST (rotated 180°,
// translucent — their glass seen from across the table). Dropping or tapping
// my glass onto the ghost ADOPTS their moment: merge is snap-assisted
// placement, not a persistent merged object (ruled — joint ownership questions
// for no visitor-visible gain).
//
// Projected TICKS on every strip make the anchored moment visible where a
// switch would land. Their salience is a lifecycle (user, 2026-08-27): salient
// while the glass is in hand (lifted or dragging, tracking the hover live),
// briefly prominent at placement, then settled-subtle — visible but quiet.
//
// EVERYTHING RENDERS FROM STATE, IDEMPOTENTLY (the listen.js markers.js
// pattern, and the 37.4 lesson): positions are recomputed from the stored
// index on every scroll/zoom/resize, never trusted to DOM that a re-render may
// rebuild. Semantic state (which index, routed where) lives in main.js — the
// callbacks report what the visitor DID; main.js answers with setMarker.
//
// POINTER MAPPING: rendering needs no transform awareness (the glass is
// positioned in the strips container's local coordinates, and the ancestors'
// rotations apply to it like everything else), but a DRAG tracks client
// coordinates, which do NOT come pre-mapped the way offsetX does (the 34.8
// lesson). The exhibit's transforms are known — the viewport's 0/180 plus the
// stage's 0/90/270 — so the inverse is the four right-angle cases below.
// Exotic angles fall back to 0° with a warning rather than guessing.

/** How far a pointer may wander and still count as a tap, in px. */
const TAP_SLOP_PX = 6;
/** Drop-snap radius onto the ghost (adopt) and the hook (rest), in px. */
const SNAP_PX = 32;
/** A drop this close above/below a strip row still lands on it, in px. */
const ROW_TOLERANCE_PX = 12;
/** How long a fresh placement's ticks stay prominent before settling, ms. */
const FRESH_MS = 1400;

// The glass: a brass-ringed lens with a well-defined cursor point — the
// hairline through the lens centre is the anchor, extended past the ring so it
// reads as pointing INTO the waveform. Classed paths take theme tokens, the
// strap-arrow precedent; the dashed ring inside the rim is the stitching
// language. The chunky handle is the grip the whole design asks a finger to
// take. The anchor point is (32, 30) in this viewBox.
// The handle is ASSEMBLED like the tool it plays: a grip between a brass
// ferrule at the ring and a brass end cap, with one highlight and one shade
// strip faking the cylinder (plain alpha layers, so every theme gets the
// rounding) and a spiral of thread lines as the leather wrap — the wrap takes
// the stitching token, so it exists only where the stitching does. Layer
// paint, not SVG gradients: gradient defs need document-unique ids and this
// markup is instantiated four times per screen (two glasses, two ghosts).
//
// The lens is an OVAL (second iteration round, 2026-08-27): sized so that a
// placed, vertical glass covers one strip top-to-bottom — the layer scales the
// whole rendering so the lens's vertical diameter equals the strip height.
const GLASS_SVG =
  "<svg viewBox='0 0 64 90' aria-hidden='true'>" +
  "<ellipse class='glass-lens' cx='32' cy='28' rx='17' ry='26'/>" +
  "<rect class='glass-handle' x='25.5' y='53' width='13' height='33' rx='6'/>" +
  "<rect class='glass-handle-hl' x='27' y='59' width='3.5' height='20' rx='1.75'/>" +
  "<rect class='glass-handle-sh' x='34.5' y='59' width='2.8' height='20' rx='1.4'/>" +
  "<path class='glass-handle-wrap' d='M25.5 62 L38.5 66 M25.5 66.5 L38.5 70.5 " +
  "M25.5 71 L38.5 75 M25.5 75.5 L38.5 79.5'/>" +
  "<rect class='glass-ferrule' x='24.5' y='52' width='15' height='6.5' rx='3'/>" +
  "<rect class='glass-ferrule' x='24.5' y='80.5' width='15' height='6.5' rx='3'/>" +
  "<ellipse class='glass-ring' cx='32' cy='28' rx='17' ry='26'/>" +
  "<ellipse class='glass-stitch' cx='32' cy='28' rx='13.5' ry='22.5'/>" +
  "</svg>";
const GLASS_ANCHOR = { x: 32, y: 28 };
const LENS = { rx: 17, ry: 26 };
// The box follows the paint: a placed glass overhangs its row's neighbours,
// and an INVISIBLE overhang would keep stealing their taps after the visible
// one stopped covering them (the handle was trimmed 25% for exactly that).
const GLASS_VIEW = { w: 64, h: 90 };
/** How much bigger the lens shows the waveform under it (the magnifier). */
const MAG = 4;

/**
 * Mount one viewport's marker layer.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.stripsEl        the viewport's `.strips` container
 * @param {Map<string, object>} opts.strips  file -> Strip (strips.js)
 * @param {{glass: string, ghost: string}} [opts.labels]  accessible names
 * @param {number} [opts.stripHeight]        CSS px; sizes the lens to the row
 * @param {(file: string) => number[]|undefined} [opts.peaksFor]  the payload's
 *   peaks, for the lens's magnified view; absent = no magnifier
 * @param {string} [opts.lensWave]           the magnified waveform's colour
 * @param {(file: string, time: number) => number} opts.ixFor      align-core
 * @param {(file: string, ix: number) => number|undefined} opts.timeFor
 * @param {() => number} opts.rotationOf     total rotation of this viewport's
 *   painted box in screen space (viewport + stage), degrees
 * @param {(file: string, time: number) => void} opts.onPlace  visitor placed or
 *   moved the glass; main.js converts to an index, echoes via setMarker, and
 *   routes the jump (placement IS the reader's own seek, ruled)
 * @param {() => void} opts.onAdopt          dropped/tapped onto the ghost
 * @param {() => void} opts.onRemove         pulled off the waveforms, or
 *   rested via the hook — a LIFT no longer removes (see lift below)
 * @returns {{el: HTMLElement, setMarker(ix: number|null, file: string|null): void,
 *   setGhost(ix: number|null, file: string|null): void, lifted: boolean,
 *   lift(): void, reset(): void, reposition(): void, state(): object,
 *   destroy(): void}}
 */
export function createMarkerLayer({
  stripsEl,
  strips,
  ixFor,
  timeFor,
  rotationOf,
  onPlace,
  onAdopt,
  onRemove,
  labels = {},
  stripHeight = 48,
  peaksFor,
  lensWave = "#8fb8e8",
}) {
  // The rendering scales so the oval lens spans exactly one strip: rendered
  // lens height = stripHeight, everything else follows the viewBox ratio.
  const glassW = Math.round((stripHeight * GLASS_VIEW.w) / (2 * LENS.ry));
  const glassH = Math.round((glassW * GLASS_VIEW.h) / GLASS_VIEW.w);
  const scale = glassW / GLASS_VIEW.w;
  // Display state. `ix`/`homeFile` mirror main.js's semantic state via
  // setMarker; `hoverIx` exists only mid-drag, for the live tick projection.
  let ix = null;
  let homeFile = null;
  let lifted = false;
  let ghost = null; // { ix, file } — the OTHER viewport's marker
  let drag = null; // { pointerId, startX, startY, moved }
  let freshTimer = 0;

  const layer = document.createElement("div");
  layer.className = "marker-layer";

  // The rail: the reserved left column's marker furniture — just the hook.
  // Under ?tapMode=direct the switch strap's leather already owns the column
  // and the hook sits below its bottom arrow (exhibit.css positions it per
  // mode); in aligned mode the rail is the column's only tenant.
  const rail = document.createElement("div");
  rail.className = "marker-rail";
  const hook = document.createElement("div");
  hook.className = "marker-hook";
  rail.appendChild(hook);
  layer.appendChild(rail);

  // One tick per strip, from birth: rendering toggles them rather than
  // rebuilding, so a re-render can never race a rebuild (the 37.4 class).
  const ticks = new Map();
  for (const [file, strip] of strips) {
    const tick = document.createElement("div");
    tick.className = "marker-tick";
    tick.hidden = true;
    strip.el.appendChild(tick);
    ticks.set(file, tick);
  }

  // The ghost: the other side's glass, mirrored. Interactive only while my
  // own glass is in hand (CSS gates pointer-events on the layer's state), so
  // a resting visitor cannot "press" the other side's marker by accident.
  const ghostEl = document.createElement("div");
  ghostEl.className = "marker-ghost";
  ghostEl.innerHTML = GLASS_SVG;
  ghostEl.hidden = true;
  ghostEl.style.width = `${glassW}px`;
  ghostEl.style.height = `${glassH}px`;
  ghostEl.setAttribute("aria-label", labels.ghost || "");
  stripsEl.appendChild(ghostEl);

  const glass = document.createElement("div");
  glass.className = "marker-glass";
  glass.innerHTML = GLASS_SVG;
  glass.style.width = `${glassW}px`;
  glass.style.height = `${glassH}px`;
  glass.setAttribute("role", "button");
  glass.setAttribute("tabindex", "0");
  glass.setAttribute("aria-label", labels.glass || "");

  // The magnifier: a small canvas under the SVG, clipped to the lens oval,
  // showing the waveform beneath the glass at MAG× — drawn from the payload's
  // own peaks, so it costs no renderer access and works mid-drag. The SVG's
  // translucent lens tint paints OVER it: aged glass, with something behind it.
  const mag = document.createElement("canvas");
  mag.className = "marker-mag";
  {
    const rx = LENS.rx * scale;
    const ry = LENS.ry * scale;
    mag.style.width = `${2 * rx}px`;
    mag.style.height = `${2 * ry}px`;
    mag.style.left = `${glassW / 2 - rx}px`;
    mag.style.top = `${GLASS_ANCHOR.y * scale - ry}px`;
    const dpr = window.devicePixelRatio || 1;
    mag.width = Math.round(2 * rx * dpr);
    mag.height = Math.round(2 * ry * dpr);
  }
  glass.insertBefore(mag, glass.firstChild);
  stripsEl.appendChild(glass);
  stripsEl.appendChild(layer);

  // ---- geometry -------------------------------------------------------------

  /** x of `time` within `strip`'s visible box, local px; null when scrolled out. */
  const xOn = (strip, time) => {
    const wrapper = strip.ws.getWrapper?.();
    const full = wrapper?.clientWidth || strip.host.clientWidth;
    if (!full || !Number.isFinite(time)) return null;
    const x = (time / strip.duration) * full - (strip.ws.getScroll?.() || 0);
    return x >= 0 && x <= strip.host.clientWidth ? x : null;
  };

  /** Local anchor for the hook's centre — offsets, so transforms are moot. */
  const hookAnchor = () => ({
    x: rail.offsetLeft + hook.offsetLeft + hook.offsetWidth / 2,
    y: rail.offsetTop + hook.offsetTop + hook.offsetHeight / 2,
  });

  /** Local anchor for the lifted float: hovering OVER the waveform area,
   * upright, inside the pulsing outline that says where a tap places it —
   * deliberately not the rail column, whose medallions it would sit on under
   * ?tapMode=direct (user, 2026-08-27). */
  const floatAnchor = () => ({
    x: stripsEl.clientWidth / 2,
    y: stripsEl.clientHeight / 2,
  });

  /** Local anchor for (file, time) — the strip row's centre at that moment. */
  const stripAnchor = (file, time) => {
    const strip = strips.get(file);
    if (!strip) return null;
    const x = xOn(strip, time);
    if (x == null) return null;
    return {
      x: strip.el.offsetLeft + x,
      y: strip.el.offsetTop + strip.el.offsetHeight / 2,
    };
  };

  /**
   * Client → strips-local, through the composed right-angle rotation. The
   * bounding rect is the PAINTED box; which of its corners is the local origin
   * depends on the rotation.
   */
  const toLocal = (cx, cy) => {
    const r = stripsEl.getBoundingClientRect();
    const raw = Number(rotationOf()) || 0;
    if (raw % 90 !== 0) {
      console.warn(`exhibit marker: rotation ${raw}° is not a right angle — mapping as 0°`);
    }
    const rot = ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
    switch (rot) {
      case 180:
        return { x: r.right - cx, y: r.bottom - cy };
      case 90:
        return { x: cy - r.top, y: r.right - cx };
      case 270:
        return { x: r.bottom - cy, y: cx - r.left };
      default:
        return { x: cx - r.left, y: cy - r.top };
    }
  };

  /** The strip row at local y, tolerant of the 2px gaps and near misses. */
  const rowAt = (ly) => {
    let best = null;
    for (const [file, strip] of strips) {
      const top = strip.el.offsetTop;
      const bottom = top + strip.el.offsetHeight;
      const d = ly < top ? top - ly : ly > bottom ? ly - bottom : 0;
      if (d <= ROW_TOLERANCE_PX && (!best || d < best.d)) best = { file, strip, d };
    }
    return best;
  };

  /** (file, time) under a local point, or null when off the waveforms. */
  const spotAt = (lx, ly) => {
    const row = rowAt(ly);
    if (!row) return null;
    const { strip, file } = row;
    const x = lx - strip.el.offsetLeft;
    if (x < 0 || x > strip.host.clientWidth) return null;
    const wrapper = strip.ws.getWrapper?.();
    const full = wrapper?.clientWidth || strip.host.clientWidth;
    if (!full) return null;
    const rel = ((strip.ws.getScroll?.() || 0) + x) / full;
    return { file, time: Math.max(0, Math.min(1, rel)) * strip.duration };
  };

  // ---- rendering ------------------------------------------------------------

  const anchorPx = {
    x: GLASS_ANCHOR.x * scale,
    y: GLASS_ANCHOR.y * scale,
  };
  const moveGlass = (p) => {
    glass.style.left = `${p.x - anchorPx.x}px`;
    glass.style.top = `${p.y - anchorPx.y}px`;
  };

  /** Paint ticks for `index` (or hide them all when null). */
  const paintTicks = (index) => {
    for (const [file, tick] of ticks) {
      const strip = strips.get(file);
      const x = index == null ? null : xOn(strip, timeFor(file, index));
      tick.hidden = x == null;
      if (x != null) tick.style.left = `${x}px`;
    }
  };

  const paintGhost = () => {
    if (!ghost) {
      ghostEl.hidden = true;
      return;
    }
    const p = stripAnchor(ghost.file, timeFor(ghost.file, ghost.ix));
    ghostEl.hidden = p == null;
    if (p) {
      ghostEl.style.left = `${p.x - anchorPx.x}px`;
      ghostEl.style.top = `${p.y - anchorPx.y}px`;
    }
  };

  // ---- the magnifier ----------------------------------------------------------

  const magCtx = mag.getContext("2d");
  const clearMag = () => magCtx.clearRect(0, 0, mag.width, mag.height);
  /** The lens shows its own width's worth of strip, at MAG×, from the peaks. */
  const drawMag = (file, time) => {
    clearMag();
    const strip = strips.get(file);
    const peaks = peaksFor?.(file);
    if (!strip || !Array.isArray(peaks) || !peaks.length || !Number.isFinite(time)) return;
    const wrapper = strip.ws.getWrapper?.();
    const full = wrapper?.clientWidth || strip.host.clientWidth;
    if (!full) return;
    const pxPerSec = full / strip.duration;
    const windowSec = (2 * LENS.rx * scale) / (pxPerSec * MAG);
    const t0 = time - windowSec / 2;
    const w = mag.width;
    const h = mag.height;
    const mid = h / 2;
    magCtx.fillStyle = lensWave;
    magCtx.globalAlpha = 0.65;
    for (let x = 0; x < w; x++) {
      const t = t0 + (x / w) * windowSec;
      if (t < 0 || t > strip.duration) continue;
      const i = Math.min(
        peaks.length - 1,
        Math.max(0, Math.floor((t / strip.duration) * peaks.length)),
      );
      const v = Math.min(1, Math.abs(peaks[i] || 0));
      const bar = Math.max(h * 0.02, v * mid * 0.9);
      magCtx.fillRect(x, mid - bar, 1, bar * 2);
    }
    magCtx.globalAlpha = 1;
  };

  /** Recompute every position from state — THE one rendering entry point. */
  const reposition = () => {
    if (drag) {
      // Mid-drag the glass is under the finger; only the projections move.
      paintTicks(drag.hoverIx ?? ix);
      paintGhost();
      if (drag.spot) drawMag(drag.spot.file, drag.spot.time);
      else clearMag();
      return;
    }
    if (lifted) {
      moveGlass(floatAnchor());
      clearMag();
    } else if (ix != null && homeFile) {
      const p = stripAnchor(homeFile, timeFor(homeFile, ix));
      // A placed glass whose moment is scrolled out of view hides honestly
      // rather than pinning to an edge it is not at; the ticks already do.
      glass.classList.toggle("is-offview", p == null);
      if (p) moveGlass(p);
      drawMag(homeFile, timeFor(homeFile, ix));
    } else {
      glass.classList.remove("is-offview");
      moveGlass(hookAnchor());
      clearMag();
    }
    paintTicks(ix);
    paintGhost();
  };

  const setEngaged = (on) => {
    layer.classList.toggle("is-engaged", on);
    glass.classList.toggle("is-engaged", on);
    ghostEl.classList.toggle("is-engaged", on);
    for (const tick of ticks.values()) tick.classList.toggle("is-salient", on);
    // The strip stack pulses whenever the glass is IN HAND — lifted OR
    // dragged (second iteration round: drags pulse too).
    stripsEl.classList.toggle("marker-expect", on);
  };

  const markFresh = () => {
    clearTimeout(freshTimer);
    for (const tick of ticks.values()) tick.classList.add("is-fresh");
    freshTimer = setTimeout(() => {
      for (const tick of ticks.values()) tick.classList.remove("is-fresh");
    }, FRESH_MS);
  };

  // ---- gestures ---------------------------------------------------------------

  // A lift is CANCEL-SAFE (second iteration round, 2026-08-27, revising the
  // first build): the marker survives the glass being picked up, so a stray
  // tap can never cost a visitor their moment. Settle puts the glass back on
  // whatever is true — the marker, or the hook. Removal is a deliberate act
  // with its own gestures: drag the glass off the waveforms, or tap the HOOK
  // while the glass is in hand ("put it away").
  const lift = () => {
    if (lifted) return;
    lifted = true;
    glass.classList.add("is-lifted");
    glass.classList.remove("is-resting", "is-placed");
    setEngaged(true);
    reposition();
  };

  const settle = () => {
    lifted = false;
    glass.classList.remove("is-lifted");
    glass.classList.toggle("is-placed", ix != null);
    glass.classList.toggle("is-resting", ix == null);
    setEngaged(false);
    reposition();
  };

  glass.addEventListener("pointerdown", (e) => {
    if (drag) return;
    e.preventDefault();
    try {
      glass.setPointerCapture(e.pointerId);
    } catch (_) {
      // A capture that cannot be taken (Safari has thrown NotFoundError on
      // odd pointer timing) must not cost the tap — the drag then just
      // depends on the pointer staying over the glass, which a tap does.
    }
    drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
  });

  glass.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (dx * dx + dy * dy < TAP_SLOP_PX * TAP_SLOP_PX) return;
      drag.moved = true;
      glass.classList.add("is-dragging");
      glass.classList.remove("is-resting", "is-placed", "is-lifted", "is-offview");
      stripsEl.classList.remove("marker-expect");
      setEngaged(true);
    }
    const p = toLocal(e.clientX, e.clientY);
    moveGlass(p);
    // Live feedback: the ticks track the hovered moment, salient (user,
    // 2026-08-27); the ghost brightens as a drop target and SNAPS the verdict
    // classes on for the last few pixels.
    const spot = spotAt(p.x, p.y);
    const g = ghost && !ghostEl.hidden ? nearGhost(p) : false;
    glass.classList.toggle("will-adopt", g);
    glass.classList.toggle("will-remove", !g && !spot);
    drag.hoverIx = g ? ghost.ix : spot ? ixFor(spot.file, spot.time) : null;
    drag.spot = spot;
    drag.adopt = g;
    paintTicks(drag.hoverIx);
  });

  const nearGhost = (p) => {
    const gp = stripAnchor(ghost.file, timeFor(ghost.file, ghost.ix));
    if (!gp) return false;
    const dx = gp.x - p.x;
    const dy = gp.y - p.y;
    return dx * dx + dy * dy <= SNAP_PX * SNAP_PX;
  };

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    glass.classList.remove("is-dragging", "will-adopt", "will-remove");
    if (!d.moved) {
      // A tap on the glass toggles the lift; both directions preserve the
      // marker — removal has its own gestures (drag off, or the hook).
      if (lifted) settle();
      else lift();
      return;
    }
    setEngaged(false);
    lifted = false;
    glass.classList.remove("is-lifted");
    if (d.adopt) onAdopt();
    else if (d.spot) onPlace(d.spot.file, d.spot.time);
    else {
      // Dragged off the waveforms: the one drag that DOES remove.
      if (ix != null) onRemove();
      settle();
    }
    // setMarker (main.js's echo) repaints the placement branches.
  };
  glass.addEventListener("pointerup", endDrag);
  glass.addEventListener("pointercancel", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    glass.classList.remove("is-dragging", "will-adopt", "will-remove");
    setEngaged(lifted);
    reposition();
  });

  // Expect-placement's other half: while lifted, a tap on a waveform places
  // (main.js intercepts the strip's own onSelect — the tap→time mapping the
  // strips already own, transform-proof via offsetX), a tap on the ghost
  // adopts, a tap on the HOOK puts the glass away (removing any marker), and
  // a tap ANYWHERE ELSE settles the glass back onto whatever is true — the
  // marker, or the hook — while the tap proceeds untouched: observed at
  // capture, never blocked, so no control can be deadened by a floating glass.
  const onDocPointerDown = (e) => {
    if (!lifted || drag) return;
    const path = e.composedPath();
    if (path.includes(glass) || path.includes(ghostEl) || path.includes(hook)) return;
    for (const strip of strips.values()) {
      if (path.includes(strip.el)) return; // the strip tap will place
    }
    // The HYBRID cancel (user, 2026-08-27, third round): a tap still within
    // the waveform world — the strips container's gaps, the rail, or the
    // strap's switch buttons, all DOM children of stripsEl — keeps the marker
    // and settles the glass back onto it (a strap switch even carries the
    // glass along, via the ride-the-audible-strip hop). A tap BEYOND that
    // world reads as walking away: the glass returns to its hook and the
    // marker goes with it, as the first build had it. Either way the tap
    // itself proceeds untouched.
    if (path.includes(stripsEl)) {
      settle();
      return;
    }
    if (ix != null) onRemove();
    settle();
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);

  // "Put it away": the empty hook is the removal target while the glass is in
  // hand — tappable only then (CSS gates pointer-events on the layer state).
  hook.addEventListener("click", () => {
    if (!lifted) return;
    if (ix != null) onRemove();
    settle();
  });

  ghostEl.addEventListener("click", () => {
    if (!lifted) return;
    onAdopt();
    // The echo (setMarker) normally lands the glass; if the adopt no-opped
    // (the ghost's owner pulled their glass mid-gesture), settle honestly.
    if (lifted) settle();
  });

  // Keyboard fallback for the role="button": Enter/Space toggles the lift, so
  // the glass is at least reachable without a pointer. Placement stays a
  // pointer gesture — this is a museum table, not a form.
  glass.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (lifted) settle();
    else lift();
  });

  // Scroll and resize move the projections under the glass: reposition from
  // state, rAF-coalesced — momentum panning emits bursts per frame.
  let repositionQueued = false;
  const queueReposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      reposition();
    });
  };
  for (const strip of strips.values()) {
    strip.ws.on?.("scroll", queueReposition);
    strip.ws.on?.("resize", queueReposition);
  }

  // First paint: the glass starts at rest on its hook.
  glass.classList.add("is-resting");
  reposition();

  return {
    el: layer,
    /** main.js's echo of semantic state; THE authoritative repaint. */
    setMarker(index, file) {
      const placing = index != null && ix == null;
      const moving = index != null && ix != null && index !== ix;
      ix = index;
      homeFile = index == null ? null : file;
      if (index != null) {
        lifted = false;
        glass.classList.remove("is-lifted", "is-resting");
        glass.classList.add("is-placed");
        setEngaged(false);
        if (placing || moving) markFresh();
      } else {
        glass.classList.remove("is-placed");
        if (!lifted) glass.classList.add("is-resting");
      }
      reposition();
    },
    setGhost(index, file) {
      ghost = index == null ? null : { ix: index, file };
      paintGhost();
    },
    get lifted() {
      return lifted;
    },
    /** Enter expect-placement (the direct-mode waveform-tap path; main.js). */
    lift,
    /** The attract loop's sweep: everything back to rest, no callbacks. */
    reset() {
      ix = null;
      homeFile = null;
      lifted = false;
      drag = null;
      glass.classList.remove(
        "is-lifted", "is-placed", "is-dragging", "will-adopt", "will-remove", "is-offview",
      );
      glass.classList.add("is-resting");
      setEngaged(false);
      reposition();
    },
    reposition: queueReposition,
    /** For the specs: the layer's display state, all of it. */
    state() {
      return { ix, homeFile, lifted, ghost: ghost ? { ...ghost } : null };
    },
    destroy() {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      clearTimeout(freshTimer);
      for (const tick of ticks.values()) tick.remove();
      ghostEl.remove();
      glass.remove();
      layer.remove();
    },
  };
}
