// tour.js — a LIVE TOUR over a real interface.
//
// Shared by the exhibit and, later, the listen view, the alignment wizard, and
// fix mode (roadmap item 27). ZERO IMPORTS by rule: the exhibit may not import
// listen.js through any chain (tests/e2e/33-exhibit-boundary.spec.ts), and a
// module both consumers import must stand on its own. The host supplies the
// root to mount in, the text resolver (language and register are the host's
// business), and the steps as DATA; the tour draws, positions, and advances.
//
// The rulings it encodes (user, 2026-09-22/23):
//   · INTERACTIVE — a step completes on the visitor's own action: a SIGNAL the
//     host raises by name ("switched", "audience", …), or a PREDICATE polled
//     while the step is up. "next" is for orientation steps. Next is always
//     offered as the escape, Skip always ends the tour.
//   · NON-BLOCKING — the layer never swallows a tap: everything but the card is
//     pointer-events: none, so a confused visitor's tap anywhere still does what
//     it always did, and the tour simply waits for its condition.
//   · TWO ATTENTION STYLES, for the A/B: "mask" dims everything but the target;
//     "loop" is a HAND-DRAWN LOOP round it in the switch cue's line, with a sure
//     hand — it draws itself once and a sixth round the area, stays `loopHoldMs` (6 s),
//     then undraws and redraws while the step is still up, and undraws before
//     the next step's loop draws. Dash offsets stay POSITIVE throughout, because
//     iOS WebKit paints a negative dash phase wrongly (project_demo_setup).
//   · The loop paints TOP-MOST: given a `skyRoot`, it lives in its own layer
//     beside the host's root — mirroring the root's box and transform — so a
//     sibling painted above the root (the exhibit's band) cannot cover it.
//   · A step with no progress for `idleMs` folds the tour away quietly.
//   · Reduced motion: no drawing in or out, no redraw cycle; loop and card
//     simply appear.
//
// GEOMETRY IS LAYOUT GEOMETRY (offsetLeft/offsetTop up to the root), not painted
// rects: the exhibit's far half is rotated 180° and the layers turn with it, so
// the tour turns with its reader for free, where painted rects would be upside
// down. A target outside the root (the exhibit's shared band) gets no hole —
// the card sits at the nearest edge and points at it.
//
// STEP SHAPE:
//   {
//     id: "switch",                    // stable; tests and events name it
//     fragment: ["arrival", "listening"],  // which tours it belongs to
//     target: () => Element | null,    // or a selector; null = a centred card;
//                                      // a function returning null = SKIP the step
//     title: "tour.x.title",           // optional text key
//     body: "tour.x",                  // text key; {vars} substituted
//     vars: () => ({ name: "…" }),     // optional
//     complete: "next" | { signal: "switched", when?: (payload) => boolean }
//               | { predicate: () => boolean },
//     variants: { requested: "tour.x.requested" }, // a signal that only changes the words
//     loopBox: ({ rectOf }) => ({ left, top, width, height }) | null,
//                                      // optional: the box the LOOP circles, in the
//                                      // root's layout space (rectOf(el) gives an
//                                      // element's); the default is the target's box,
//                                      // capped and centred (LOOP_MAX_W × LOOP_MAX_H)
//   }

const STYLE_ID = "tour-style";
const DRAW_MS = 900; // the loop drawing itself, once and a sixth round
const UNDRAW_MS = 380; // the loop leaving
const REDRAW_PAUSE_MS = 350; // the beat between a cycle's undraw and its redraw
const HOLD_MS = 6000; // how long a drawn loop stays before it cycles (user, 2026-09-23: 6 s)
// A loop never grows beyond this box: round a target that fills the half (the
// strips) it circles a somewhat-big patch in the target's middle instead of the
// whole half (user, 2026-09-23).
const LOOP_MAX_W = 520;
const LOOP_MAX_H = 320;

/** The box a loop goes round: the target's, capped and centred on it. */
function loopBox(hole) {
  const width = Math.min(hole.width, LOOP_MAX_W);
  const height = Math.min(hole.height, LOOP_MAX_H);
  return {
    left: hole.left + (hole.width - width) / 2,
    top: hole.top + (hole.height - height) / 2,
    width,
    height,
  };
}

const CSS = `
.tour-layer{position:absolute;inset:0;z-index:6;pointer-events:none;overflow:visible;font-family:var(--tour-font,system-ui,sans-serif)}
.tour-sky{position:absolute;z-index:10;pointer-events:none;overflow:visible}
.tour-mask{position:absolute;background:var(--tour-dim,rgba(0,0,0,.45));transition:left .25s ease,top .25s ease,width .25s ease,height .25s ease}
.tour-hole{position:absolute;border-radius:12px;box-shadow:0 0 0 2px var(--tour-accent,#d3a95a);transition:left .25s ease,top .25s ease,width .25s ease,height .25s ease}
.tour-layer[data-reduced] .tour-mask,.tour-layer[data-reduced] .tour-hole{transition:none}
.tour-layer[data-style="loop"] .tour-mask,.tour-layer[data-style="loop"] .tour-hole{display:none}
.tour-layer[data-style="mask"] .tour-loop{display:none}
.tour-loop{position:absolute;left:0;top:0;overflow:visible}
.tour-loop path{fill:none;stroke-linecap:round;stroke-linejoin:round}
.tour-loop .tour-loop-halo{stroke:var(--tour-cue-halo,rgba(255,252,245,.9));stroke-width:5.5}
.tour-loop .tour-loop-line{stroke:var(--tour-cue,#f07f1a);stroke-width:3.5}
.tour-card{position:absolute;pointer-events:auto;box-sizing:border-box;width:max-content;max-width:min(440px,calc(100% - 16px));padding:12px 14px 10px;border-radius:12px;background:var(--tour-bg,#1c2433);color:var(--tour-text,#f2ead8);border:1px solid var(--tour-border,#4a5568);box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:15px;line-height:1.4}
.tour-card::before{content:"";position:absolute;width:14px;height:14px;background:inherit;border:inherit;transform:rotate(45deg);left:calc(var(--tour-pointer-x,50%) - 7px)}
.tour-card.is-below::before{top:-8px;border-right:none;border-bottom:none}
.tour-card.is-above::before{bottom:-8px;border-left:none;border-top:none}
.tour-card.is-centered::before,.tour-card.is-inside::before{display:none}
.tour-card.is-leaving{visibility:hidden}
.tour-title{margin:0 0 4px;font-weight:600}
.tour-body{margin:0 0 10px}
.tour-row{display:flex;align-items:center;gap:10px}
.tour-dots{display:flex;gap:5px;flex:1;min-width:40px}
.tour-dot{width:7px;height:7px;border-radius:50%;background:var(--tour-border,#4a5568)}
.tour-dot.is-on{background:var(--tour-accent,#d3a95a)}
.tour-dot.is-done{background:var(--tour-soft,#9aa3b2)}
.tour-skip,.tour-next{min-height:44px;padding:6px 14px;border-radius:10px;border:1px solid var(--tour-border,#4a5568);background:transparent;color:inherit;font:inherit;cursor:pointer}
.tour-next{background:var(--tour-accent,#d3a95a);color:var(--tour-on-accent,#1a1408);border-color:var(--tour-accent,#d3a95a);font-weight:600}
`;

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

const SVG = "http://www.w3.org/2000/svg";

/** The root's own rotation in degrees (0, 90, 180, 270), from its computed transform. */
function rotationOf(elm) {
  const tf = getComputedStyle(elm).transform;
  if (!tf || tf === "none") return 0;
  const m = /matrix\(([^)]+)\)/.exec(tf);
  if (!m) return 0;
  const [a, b] = m[1].split(",").map(Number);
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A hand-drawn loop round a box, with a sure hand: a rounded shape (a
 * superellipse, so it hugs a wide box's corners better than an ellipse would)
 * drawn once round AND A SIXTH MORE, with a slight wobble, a few pixels of
 * outward drift, and the frame TURNING a little as the pen goes round — so the
 * overrun sits just outside the first pass at a slightly different angle and
 * reads as a second line (user, 2026-09-23). The way a pen circles something
 * on paper without shaking. Deterministic for a given box, so a test sees the
 * same loop every time.
 */
function loopPath(hole) {
  const cx = hole.left + hole.width / 2;
  const cy = hole.top + hole.height / 2;
  const rx0 = hole.width / 2 + 10;
  const ry0 = hole.height / 2 + 10;
  const seed = (hole.left * 7 + hole.top * 13) % 97;
  const loops = 7 / 6; // once round and a sixth more (user, 2026-09-23), the overrun a little outside
  const N = Math.round(96 * loops);
  const n = 3; // superellipse exponent: 2 = ellipse, higher = squarer
  const turn = 0.09; // ~5° of frame rotation from the pen's first touch to its last
  const pts = [];
  const start = -Math.PI * 0.72; // the pen sets down at the upper left
  for (let i = 0; i <= N; i++) {
    const k = i / N;
    const t = start + k * loops * 2 * Math.PI;
    const wobble = 0.5 * Math.sin(3.1 * t + seed) + 0.3 * Math.sin(7.3 * t - seed * 0.5);
    const drift = 4 * k; // the overrun sits a little outside the first pass
    const rx = rx0 + wobble + drift;
    const ry = ry0 + wobble * 0.8 + drift * 0.7;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const X = rx * Math.sign(c) * Math.abs(c) ** (2 / n) + 0.2 * Math.sin(2 * t + seed);
    const Y = ry * Math.sign(s) * Math.abs(s) ** (2 / n) + 0.15 * Math.cos(3 * t - seed);
    const rot = turn * k;
    const x = cx + X * Math.cos(rot) - Y * Math.sin(rot);
    const y = cy + X * Math.sin(rot) + Y * Math.cos(rot);
    pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return "M" + pts.join(" L");
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root         mounts inside this element (positioned)
 * @param {HTMLElement} [opts.skyRoot]    the root's PARENT (or another ancestor
 *   sharing its containing block): the loop paints there, top-most, mirroring
 *   the root's box and transform. Without it the loop paints inside the root.
 * @param {Array<object>} opts.steps      see STEP SHAPE above
 * @param {(key: string, vars?: object) => string} opts.text   the host's resolver
 * @param {"mask"|"loop"} [opts.style]
 * @param {boolean} [opts.reducedMotion]
 * @param {number} [opts.idleMs]          0 = never fold away
 * @param {number} [opts.loopHoldMs]      the drawn loop's stay before it cycles; 0 = never
 * @param {(ev: object) => void} [opts.onEvent]
 * @param {() => number} [opts.now]
 */
export function createTour({
  root,
  skyRoot = null,
  steps = [],
  text = (key) => key,
  style = "mask",
  reducedMotion = false,
  idleMs = 45000,
  loopHoldMs = HOLD_MS,
  onEvent = () => {},
  now = () => Date.now(),
}) {
  if (!root) throw new Error("createTour: a root element is required");
  injectStyle();
  const styleName = style === "loop" ? "loop" : "mask";

  let active = null; // the fragment's name while a tour runs
  let list = []; // the fragment's steps
  let index = -1;
  let layer = null;
  let sky = null;
  let masks = {};
  let holeEl = null;
  let loopSvg = null;
  let loopHalo = null;
  let loopLine = null;
  let loopLen = 0;
  let loopDrawn = false;
  let card = null;
  let titleEl = null;
  let bodyEl = null;
  let dotsEl = null;
  let nextBtn = null;
  let frame = 0;
  let lastProgress = 0;
  let currentTarget = null;
  let lastHoleKey = "";
  let bodyKey = null; // the text key the card shows now: the step's body, or a variant's
  let leaving = false; // a step change's undraw runs; Next, Skip, and signals wait for it
  let undrawing = false; // any undraw runs (a cycle's too); a change asked meanwhile queues
  let afterUndraw = [];
  let cycleTimer = 0;
  let cycleToken = 0;
  const events = []; // every emitted event, for tests

  function emit(kind, extra = {}) {
    const ev = { kind, fragment: active, step: list[index]?.id ?? null, at: now(), ...extra };
    events.push(ev);
    try {
      onEvent(ev);
    } catch (e) {
      console.warn("tour: onEvent threw", e);
    }
  }

  function build() {
    layer = el("div", "tour-layer");
    layer.dataset.style = styleName;
    if (reducedMotion) layer.dataset.reduced = "1";
    masks = {};
    for (const side of ["top", "bottom", "left", "right"]) {
      masks[side] = el("div", `tour-mask tour-mask-${side}`);
      layer.appendChild(masks[side]);
    }
    holeEl = el("div", "tour-hole");
    layer.appendChild(holeEl);
    loopSvg = document.createElementNS(SVG, "svg");
    loopSvg.setAttribute("class", "tour-loop");
    loopHalo = document.createElementNS(SVG, "path");
    loopHalo.setAttribute("class", "tour-loop-halo");
    loopLine = document.createElementNS(SVG, "path");
    loopLine.setAttribute("class", "tour-loop-line");
    loopSvg.append(loopHalo, loopLine);
    if (styleName === "loop" && skyRoot) {
      // Top-most: its own layer beside the root, in the root's coordinate space.
      sky = el("div", "tour-sky");
      sky.dataset.style = styleName;
      if (reducedMotion) sky.dataset.reduced = "1";
      sky.appendChild(loopSvg);
      skyRoot.appendChild(sky);
      placeSky();
    } else {
      layer.appendChild(loopSvg);
    }
    card = el("div", "tour-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    titleEl = el("p", "tour-title");
    bodyEl = el("p", "tour-body");
    dotsEl = el("div", "tour-dots");
    const row = el("div", "tour-row");
    const skipBtn = el("button", "tour-skip");
    skipBtn.type = "button";
    skipBtn.textContent = text("tour.skip");
    skipBtn.addEventListener("click", () => end("skipped"));
    nextBtn = el("button", "tour-next");
    nextBtn.type = "button";
    nextBtn.textContent = text("tour.next");
    nextBtn.addEventListener("click", () => advance("next"));
    row.append(dotsEl, skipBtn, nextBtn);
    card.append(titleEl, bodyEl, row);
    layer.appendChild(card);
    root.appendChild(layer);
  }

  /** The sky mirrors the root's box and transform, so loop coordinates are the root's own. */
  function placeSky() {
    if (!sky) return;
    sky.style.left = `${root.offsetLeft}px`;
    sky.style.top = `${root.offsetTop}px`;
    sky.style.width = `${root.offsetWidth}px`;
    sky.style.height = `${root.offsetHeight}px`;
    const tf = getComputedStyle(root).transform;
    sky.style.transform = tf && tf !== "none" ? tf : "";
  }

  function resolveTarget(step) {
    if (step.target == null) return null;
    if (typeof step.target === "function") return step.target() ?? null;
    if (typeof step.target === "string") return root.querySelector(step.target) || document.querySelector(step.target);
    return step.target instanceof Element ? step.target : null;
  }

  const vars = (step) => (typeof step.vars === "function" ? step.vars() : step.vars || {});

  function show() {
    const step = list[index];
    if (!step) return end("finished");
    const target = resolveTarget(step);
    if (step.target != null && !target) {
      // Configured but not on this table (no strap, no zoom buttons, no
      // explorers): the step has nothing to point at and is skipped, not shown.
      emit("skippedStep");
      index += 1;
      return show();
    }
    cycleToken += 1;
    clearTimeout(cycleTimer);
    currentTarget = target;
    layer.dataset.step = step.id;
    if (step.title) {
      titleEl.textContent = text(step.title, vars(step));
      titleEl.hidden = false;
    } else {
      titleEl.textContent = "";
      titleEl.hidden = true;
    }
    bodyKey = step.body;
    bodyEl.textContent = text(bodyKey, vars(step));
    dotsEl.textContent = "";
    list.forEach((_, i) => {
      dotsEl.appendChild(el("i", "tour-dot" + (i === index ? " is-on" : i < index ? " is-done" : "")));
    });
    card.classList.remove("is-leaving");
    // The last card's button closes the tour rather than promising more.
    nextBtn.textContent = text(index === list.length - 1 ? "tour.close" : "tour.next");
    lastProgress = now();
    lastHoleKey = "";
    position(true);
    emit("shown");
  }

  /** The element's rect in the ROOT's layout space; `inside` is false when the root is not an ancestor. */
  function localRect(elm) {
    let x = 0;
    let y = 0;
    let e = elm;
    while (e && e !== root) {
      x += e.offsetLeft;
      y += e.offsetTop;
      e = e.offsetParent;
    }
    if (e === root) return { left: x, top: y, width: elm.offsetWidth, height: elm.offsetHeight, inside: true };
    const r = root.getBoundingClientRect();
    const t = elm.getBoundingClientRect();
    let left = t.left - r.left;
    let top = t.top - r.top;
    if (rotationOf(root) === 180) {
      left = r.width - (t.right - r.left);
      top = r.height - (t.bottom - r.top);
    }
    return { left, top, width: t.width, height: t.height, inside: false };
  }

  function position(fresh) {
    if (!layer) return;
    placeSky();
    const W = root.clientWidth;
    const H = root.clientHeight;
    const pad = 8;
    const rect = currentTarget ? localRect(currentTarget) : null;
    let hole = null;
    if (rect) {
      hole = { left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad };
      const visible = hole.left < W && hole.top < H && hole.left + hole.width > 0 && hole.top + hole.height > 0;
      if (!visible) hole = null;
    }
    const key = hole ? [hole.left, hole.top, hole.width, hole.height].map(Math.round).join(",") : "none";
    if (key !== lastHoleKey || fresh) {
      lastHoleKey = key;
      paintMask(hole, W, H);
      // Under the loop style the card keeps to the LOOP's box, which may be
      // smaller than the target's: it sits by the loop, not at the half's foot.
      const ring = hole ? ringFor(list[index], hole) : null;
      paintLoop(ring, W, H, fresh);
      placeCard(rect, styleName === "loop" ? ring : hole, W, H);
    }
  }

  /** The box the loop circles: the step's own, padded like the hole, else the target's capped. */
  function ringFor(step, hole) {
    if (typeof step?.loopBox === "function") {
      try {
        const b = step.loopBox({ rectOf: localRect });
        if (b && b.width > 0 && b.height > 0) return { left: b.left - 8, top: b.top - 8, width: b.width + 16, height: b.height + 16 };
      } catch (e) {
        console.warn("tour: loopBox threw", e);
      }
    }
    return loopBox(hole);
  }

  function box(node, left, top, width, height) {
    node.style.left = `${Math.max(0, left)}px`;
    node.style.top = `${Math.max(0, top)}px`;
    node.style.width = `${Math.max(0, width)}px`;
    node.style.height = `${Math.max(0, height)}px`;
  }

  function paintMask(hole, W, H) {
    if (!hole) {
      box(masks.top, 0, 0, W, H);
      for (const side of ["bottom", "left", "right"]) box(masks[side], 0, 0, 0, 0);
      holeEl.hidden = true;
      return;
    }
    const right = hole.left + hole.width;
    const bottom = hole.top + hole.height;
    box(masks.top, 0, 0, W, hole.top);
    box(masks.bottom, 0, bottom, W, H - bottom);
    box(masks.left, 0, hole.top, hole.left, hole.height);
    box(masks.right, right, hole.top, W - right, hole.height);
    holeEl.hidden = false;
    box(holeEl, hole.left, hole.top, hole.width, hole.height);
  }

  function clearDash(paths) {
    for (const p of paths) {
      p.getAnimations?.().forEach((a) => a.cancel());
      p.style.strokeDasharray = "";
      p.style.strokeDashoffset = "";
    }
  }

  function paintLoop(hole, W, H, fresh) {
    if (styleName !== "loop") return;
    loopSvg.setAttribute("width", String(W));
    loopSvg.setAttribute("height", String(H));
    loopSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    if (!hole) {
      loopSvg.style.display = "none";
      loopDrawn = false;
      return;
    }
    loopSvg.style.display = "";
    const d = loopPath(hole);
    loopHalo.setAttribute("d", d);
    loopLine.setAttribute("d", d);
    if (!fresh && loopDrawn) return; // a target that merely moved keeps its drawn loop
    loopLen = loopLine.getTotalLength?.() || 4 * (hole.width + hole.height);
    clearDash([loopHalo, loopLine]);
    loopDrawn = true;
    if (reducedMotion || typeof loopLine.animate !== "function") return;
    // The draw-in: one dash the length of the path, its phase running from the
    // length (nothing showing) down to zero (all of it) — POSITIVE throughout.
    // Both the promise and a timer settle it: a throttled tab can be slow to
    // finish an animation, and a loop must never stay half-drawn.
    let settled = false;
    const settle = () => {
      if (settled || !loopLine.isConnected) return;
      settled = true;
      clearDash([loopHalo, loopLine]);
    };
    for (const p of [loopHalo, loopLine]) {
      p.style.strokeDasharray = `${loopLen}`;
      p.style.strokeDashoffset = `${loopLen}`;
      const anim = p.animate([{ strokeDashoffset: loopLen }, { strokeDashoffset: 0 }], {
        duration: DRAW_MS,
        easing: "ease-out",
        fill: "forwards",
      });
      if (p === loopLine) anim.finished.then(settle, () => {});
    }
    setTimeout(settle, DRAW_MS + 120);
    scheduleCycle();
  }

  /**
   * The loop's life while a step stays up: drawn, held `loopHoldMs`, undrawn,
   * a beat, drawn again — so a visitor who looked away sees it draw itself
   * afresh. A step change or the end cancels the cycle through `cycleToken`.
   */
  function scheduleCycle() {
    clearTimeout(cycleTimer);
    if (reducedMotion || !(loopHoldMs > 0)) return;
    const token = cycleToken;
    cycleTimer = setTimeout(() => {
      if (token !== cycleToken || !active || leaving) return;
      undraw(layer, () => {
        if (token !== cycleToken || !active) return;
        cycleTimer = setTimeout(() => {
          if (token !== cycleToken || !active) return;
          emit("loopRedraw");
          lastHoleKey = "";
          position(true);
        }, REDRAW_PAUSE_MS);
      }, { cycle: true });
    }, DRAW_MS + loopHoldMs);
  }

  /**
   * The loop leaves: the switch cue's wipe, the phase running from twice the
   * length down to the length (positive), so the line is eaten from where the
   * pen set down. Then `next` runs. Under the mask style, or with no loop
   * drawn, `next` runs at once. A second undraw asked while one runs (Next
   * during a cycle's wipe) queues behind it rather than restarting the line.
   */
  function undraw(layerEl, next, { cycle = false } = {}) {
    if (undrawing) {
      afterUndraw.push(next);
      return;
    }
    const svg = loopSvg;
    const paths = svg ? [loopHalo, loopLine] : [];
    if (styleName !== "loop" || reducedMotion || !loopDrawn || !svg || svg.style.display === "none") {
      loopDrawn = false;
      next();
      return;
    }
    undrawing = true;
    if (!cycle) layerEl?.querySelector(".tour-card")?.classList.add("is-leaving");
    const len = loopLen || 1000;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      clearDash(paths);
      if (svg.isConnected) svg.style.display = "none";
      undrawing = false;
      // Only this layer's own state: a "?" pressed while the old loop was
      // leaving has started a NEW tour with its own loop by now.
      const mine = layer === layerEl || layer === null;
      if (mine) loopDrawn = false;
      next();
      const queued = afterUndraw.splice(0);
      for (const fn of queued) fn();
      if (mine) leaving = false;
    };
    for (const p of paths) {
      p.getAnimations?.().forEach((a) => a.cancel());
      p.style.strokeDasharray = `${len}`;
      p.style.strokeDashoffset = `${2 * len}`;
      const anim = p.animate([{ strokeDashoffset: 2 * len }, { strokeDashoffset: len }], {
        duration: UNDRAW_MS,
        easing: "ease-in",
        fill: "forwards",
      });
      if (p === paths[paths.length - 1]) anim.finished.then(go, () => {});
    }
    setTimeout(go, UNDRAW_MS + 100);
  }

  function placeCard(rect, hole, W, H) {
    card.classList.remove("is-below", "is-above", "is-centered", "is-inside");
    card.style.left = "0px";
    card.style.top = "0px";
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    if (!rect) {
      card.classList.add("is-centered");
      card.style.left = `${Math.max(8, (W - cw) / 2)}px`;
      card.style.top = `${Math.max(8, (H - ch) / 2)}px`;
      return;
    }
    const cx = clamp(rect.left + rect.width / 2, 8, W - 8);
    const left = clamp(cx - cw / 2, 8, Math.max(8, W - cw - 8));
    card.style.setProperty("--tour-pointer-x", `${clamp(cx - left, 16, Math.max(16, cw - 16))}px`);
    // The loop reaches ~18 px beyond the box; the card clears it.
    const gap = styleName === "loop" ? 26 : 12;
    const top0 = hole ? hole.top : rect.top;
    const bottom0 = hole ? hole.top + hole.height : rect.top + rect.height;
    let top;
    if (!hole) {
      // Outside the root: pin to the edge nearest the target and point at it.
      if (rect.top < 0) {
        top = 8;
        card.classList.add("is-below");
      } else {
        top = H - ch - 8;
        card.classList.add("is-above");
      }
    } else if (bottom0 + gap + ch <= H - 8) {
      top = bottom0 + gap;
      card.classList.add("is-below");
    } else if (top0 - gap - ch >= 8) {
      top = top0 - gap - ch;
      card.classList.add("is-above");
    } else {
      // A target that fills the half (the strips): the card sits over its
      // lower edge rather than nowhere.
      top = clamp(bottom0 - ch - 8, 8, Math.max(8, H - ch - 8));
      card.classList.add("is-inside");
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function loop() {
    if (!active) return;
    const step = list[index];
    if (step && !leaving) {
      const target = resolveTarget(step);
      if (target !== currentTarget) {
        currentTarget = target;
        lastHoleKey = "";
      }
      position(false);
      // Words that name a live fact ("you are hearing X") follow the fact: a
      // switch while the step is up re-renders the card (user, 2026-09-23).
      if (typeof step.vars === "function" && bodyKey) {
        const live = text(bodyKey, vars(step));
        if (live !== bodyEl.textContent) bodyEl.textContent = live;
      }
      const c = step.complete;
      if (c && typeof c === "object" && typeof c.predicate === "function" && c.predicate()) {
        advance("predicate");
        return;
      }
      if (idleMs > 0 && now() - lastProgress > idleMs) {
        end("timedOut");
        return;
      }
    }
    frame = requestAnimationFrame(loop);
  }

  function advance(by) {
    if (!active || leaving) return;
    leaving = true;
    emit("advanced", { by });
    const fragment = active;
    undraw(layer, () => {
      if (active !== fragment) return; // ended or restarted while the loop left
      index += 1;
      show();
      if (active) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(loop);
      }
    });
    // An undraw that ran at once (mask style, or no loop drawn) has advanced already.
    if (!undrawing) leaving = false;
  }

  function end(reason) {
    if (!active) return;
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(cycleTimer);
    cycleToken += 1;
    emit(reason);
    const old = layer;
    const oldSky = sky;
    layer = null;
    sky = null;
    active = null;
    list = [];
    index = -1;
    currentTarget = null;
    // The loop leaves, then the layers go; the card is hidden meanwhile.
    undraw(old, () => {
      old?.remove();
      oldSky?.remove();
    });
  }

  function start(fragment) {
    if (active) end("restarted");
    list = steps.filter((s) => {
      if (fragment == null) return true;
      return Array.isArray(s.fragment) ? s.fragment.includes(fragment) : s.fragment === fragment;
    });
    // A step whose target is not on this table (no strap, no zoom buttons, no
    // explorers) is left out HERE, so the dots count the steps the visitor
    // will actually see — the runtime skip in show() stays as the fallback for
    // a target that vanishes mid-tour.
    list = list.filter((s) => s.target == null || resolveTarget(s) != null);
    if (!list.length) return false;
    active = fragment ?? "all";
    index = 0;
    leaving = false;
    loopDrawn = false;
    build();
    emit("started");
    show();
    if (active) frame = requestAnimationFrame(loop);
    return true;
  }

  function signal(name, payload) {
    if (!active || leaving) return false;
    const step = list[index];
    if (!step) return false;
    const c = step.complete;
    if (c && typeof c === "object" && c.signal === name && (typeof c.when !== "function" || c.when(payload))) {
      advance(name);
      return true;
    }
    if (step.variants && step.variants[name]) {
      bodyKey = step.variants[name];
      bodyEl.textContent = text(bodyKey, vars(step));
      lastProgress = now();
      lastHoleKey = "";
      position(false);
      emit("variant", { signal: name });
      return true;
    }
    return false;
  }

  return {
    start,
    skip: () => end("skipped"),
    next: () => advance("next"),
    signal,
    /** The running fragment's name, or null. */
    active: () => active,
    /** The current step's id, or null. */
    step: () => list[index]?.id ?? null,
    events,
    destroy() {
      end("destroyed");
    },
  };
}
