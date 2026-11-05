// exhibit/peel.js
//
// A peel-off card: an opaque paper label laid over an answer, that a reader
// peels back to read what is underneath (?reveal=peel; the user, 2026-10-20 —
// "an (apparently) physical bit of card with 'peel back to reveal the
// answer'"). Two ways off, both ruled: a TAP peels it away on its own, and a
// DRAG peels it under the finger.
//
// THE FOLD. A drag takes hold of the paper wherever the finger lands (G) and
// carries that point to wherever the finger is now (P). Paper folding back on
// itself so that G lands on P folds along the perpendicular bisector of G and
// P — so the card is cut by that line: the part on P's side stays flat (the
// FACE, clip-path), and the part on G's side is turned over onto it (the FLAP:
// the same rectangle clipped to G's side, then reflected across the fold).
// Taking hold anywhere, not only at a corner, is what makes it follow the
// finger; the resting dog-ear only says where a fold looks natural.
//
// POINTER MAPPING without knowing the rotation: three zero-size probes sit at
// the card's local (0,0), (w,0), and (0,h), so their client positions ARE the
// local axes as the stage and viewport rotations have painted them. A client
// point is solved against those two axes. That holds for the stage's 90/270 and
// the far reader's extra 180 alike, and for any angle the exhibit never uses —
// unlike marker.js's right-angle table, which this did not want to copy.
//
// Pure presentation: it knows nothing of annotations. The caller lays it over
// a box (position: relative) and is told once, on onReveal, that the card is
// gone.

const TAP_SLOP_PX = 6;
/** How much of the card must be turned over for a released drag to finish. */
const FINISH_FRACTION = 0.3;
/** The resting dog-ear: the corner's fold, in local px. */
const DOG_EAR = { x: 22, y: 16 };
const FINISH_MS = 380;
const RETURN_MS = 220;

/**
 * @param {object} opts
 * @param {string} opts.label        the card's word ("Show answer")
 * @param {string} [opts.ariaLabel]  the longer sentence for a screen reader
 * @param {() => void} opts.onReveal called once, when the card has come off
 */
export function createPeel({ label, ariaLabel, onReveal }) {
  const el = document.createElement("div");
  el.className = "peel";
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.setAttribute("aria-label", ariaLabel || label);

  const face = document.createElement("div");
  face.className = "peel-face";
  const word = document.createElement("span");
  word.className = "peel-label";
  word.textContent = label;
  face.appendChild(word);

  // The flap's shadow lives on a wrapper: a filter on the clipped element
  // itself would be clipped away with it.
  const flapWrap = document.createElement("div");
  flapWrap.className = "peel-flap-wrap";
  flapWrap.hidden = true;
  const flap = document.createElement("div");
  flap.className = "peel-flap";
  flapWrap.appendChild(flap);

  const probes = [
    ["0", "0"],
    ["100%", "0"],
    ["0", "100%"],
  ].map(([left, top]) => {
    const p = document.createElement("span");
    p.className = "peel-probe";
    p.style.left = left;
    p.style.top = top;
    return p;
  });
  el.append(face, flapWrap, ...probes);

  let done = false;
  let anim = 0;
  let gesture = null; // { id, G, start: {x, y} client, dragging, P }

  const size = () => ({ w: el.offsetWidth, h: el.offsetHeight });
  const corner = () => {
    const { w, h } = size();
    return { x: w, y: h };
  };
  const dogEarP = () => {
    const c = corner();
    return { x: c.x - DOG_EAR.x, y: c.y - DOG_EAR.y };
  };

  /** Client → card-local, solved against the probes' painted axes. */
  const toLocal = (cx, cy) => {
    const [o, a, b] = probes.map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.left, y: r.top };
    });
    const ax = { x: a.x - o.x, y: a.y - o.y };
    const ay = { x: b.x - o.x, y: b.y - o.y };
    const det = ax.x * ay.y - ax.y * ay.x;
    const { w, h } = size();
    if (!det) return { x: cx - o.x, y: cy - o.y };
    const qx = cx - o.x;
    const qy = cy - o.y;
    const s = (qx * ay.y - qy * ay.x) / det;
    const t = (ax.x * qy - ax.y * qx) / det;
    return { x: s * w, y: t * h };
  };

  /** The card's rectangle clipped to the half-plane side·((X−M)·n) ≥ 0. */
  const clipRect = (M, n, side) => {
    const { w, h } = size();
    const pts = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
    const f = (p) => side * ((p.x - M.x) * n.x + (p.y - M.y) * n.y);
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const fp = f(p);
      const fq = f(q);
      if (fp >= 0) out.push(p);
      if ((fp >= 0) !== (fq >= 0)) {
        const k = fp / (fp - fq);
        out.push({ x: p.x + k * (q.x - p.x), y: p.y + k * (q.y - p.y) });
      }
    }
    return out;
  };
  const area = (poly) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      s += p.x * q.y - q.x * p.y;
    }
    return Math.abs(s) / 2;
  };
  const polygon = (poly) =>
    poly.length ? `polygon(${poly.map((p) => `${p.x}px ${p.y}px`).join(", ")})` : "polygon(0 0)";

  /** Paint the fold that carries G to P; returns the fraction turned over. */
  const render = (G, P) => {
    const dx = P.x - G.x;
    const dy = P.y - G.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) {
      face.style.clipPath = "";
      flapWrap.hidden = true;
      return 0;
    }
    const n = { x: dx / len, y: dy / len };
    const M = { x: (G.x + P.x) / 2, y: (G.y + P.y) / 2 };
    const flat = clipRect(M, n, 1);
    const turned = clipRect(M, n, -1);
    face.style.clipPath = polygon(flat);
    flapWrap.hidden = turned.length === 0;
    flap.style.clipPath = polygon(turned);
    // Reflection across the fold: X' = X − 2((X−M)·n)n, as a CSS matrix.
    const mn = M.x * n.x + M.y * n.y;
    flap.style.transform =
      `matrix(${1 - 2 * n.x * n.x}, ${-2 * n.x * n.y}, ${-2 * n.x * n.y}, ` +
      `${1 - 2 * n.y * n.y}, ${2 * mn * n.x}, ${2 * mn * n.y})`;
    // The paper's back darkens away from the fold, in the flap's own (pre-
    // reflection) frame: towards G, i.e. along −n.
    const angle = (Math.atan2(-n.x, n.y) * 180) / Math.PI;
    flap.style.setProperty("--peel-shade-angle", `${angle}deg`);
    const { w, h } = size();
    return w && h ? area(turned) / (w * h) : 0;
  };

  /** Where P must go, along G→P's direction, for the whole card to turn over. */
  const offPoint = (G, P) => {
    let dx = P.x - G.x;
    let dy = P.y - G.y;
    let len = Math.hypot(dx, dy);
    if (len < 0.5) {
      const d = dogEarP();
      dx = d.x - G.x;
      dy = d.y - G.y;
      len = Math.hypot(dx, dy) || 1;
    }
    const n = { x: dx / len, y: dy / len };
    const { w, h } = size();
    const far = Math.max(...[[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => x * n.x + y * n.y));
    const t = far - (G.x * n.x + G.y * n.y) + 8;
    return { x: G.x + 2 * t * n.x, y: G.y + 2 * t * n.y };
  };

  // Frames drive the motion, and a timer guarantees the END: a page whose
  // frames are withheld (a hidden pane, a background tab) must still finish a
  // peel it started, or a card would hang half-folded over the answer.
  let animTimer = 0;
  const animate = (G, from, to, ms, then) => {
    cancelAnimationFrame(anim);
    clearTimeout(animTimer);
    const t0 = performance.now();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      cancelAnimationFrame(anim);
      clearTimeout(animTimer);
      render(G, to);
      then?.();
    };
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      if (k >= 1) return end();
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      render(G, { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
    animTimer = setTimeout(end, ms + 120);
  };

  const rest = () => render(corner(), dogEarP());

  const finish = (G, from) => {
    done = true;
    el.classList.add("is-peeling");
    animate(G, from, offPoint(G, from), FINISH_MS, () => {
      ro?.disconnect();
      el.remove();
      onReveal?.();
    });
  };

  el.addEventListener("pointerdown", (e) => {
    if (done || gesture || (e.pointerType === "mouse" && e.button !== 0)) return;
    // The panel scrolls; a peel is not a scroll, and a captured pointer keeps
    // reporting even when the finger leaves the card.
    e.preventDefault();
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks (a synthetic one) cannot be
      // captured; the gesture still works while it stays over the card.
    }
    cancelAnimationFrame(anim);
    clearTimeout(animTimer);
    const G = toLocal(e.clientX, e.clientY);
    gesture = { id: e.pointerId, G, start: { x: e.clientX, y: e.clientY }, dragging: false, P: G };
  });
  el.addEventListener("pointermove", (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    if (!gesture.dragging) {
      if (Math.hypot(e.clientX - gesture.start.x, e.clientY - gesture.start.y) < TAP_SLOP_PX) return;
      gesture.dragging = true;
      el.classList.add("is-peeling");
    }
    gesture.P = toLocal(e.clientX, e.clientY);
    render(gesture.G, gesture.P);
  });
  let releasedAt = -Infinity;
  const release = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    releasedAt = performance.now();
    if (!g.dragging) {
      // A tap: the card comes off by itself, from its dog-ear.
      if (e.type === "pointerup") finish(corner(), dogEarP());
      else rest();
      return;
    }
    const turned = render(g.G, g.P);
    if (e.type === "pointerup" && turned >= FINISH_FRACTION) {
      finish(g.G, g.P);
    } else {
      el.classList.remove("is-peeling");
      animate(g.G, g.P, g.G, RETURN_MS, rest);
    }
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  // A click that the pointer events did not already settle (a synthetic one,
  // an assistive technology's) peels it like a tap. The click that FOLLOWS a
  // pointer gesture is ignored: a drag released short of the finish springs
  // back, and must not then be finished by its own trailing click.
  el.addEventListener("click", () => {
    if (done || gesture || performance.now() - releasedAt < 500) return;
    finish(corner(), dogEarP());
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (!done) finish(corner(), dogEarP());
  });

  // The dog-ear is drawn in px, so it follows the card's size: a card laid
  // down while its panel was hidden, or a panel that resizes, re-folds it.
  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        if (!done && !gesture) rest();
      })
    : null;
  ro?.observe(el);

  return {
    el,
    /** Re-measure the resting fold (the box changed size). */
    refit() {
      if (!done && !gesture) rest();
    },
    /** Take the card off at once, silently — no animation, no onReveal. */
    destroy() {
      done = true;
      cancelAnimationFrame(anim);
      clearTimeout(animTimer);
      ro?.disconnect();
      el.remove();
    },
  };
}
