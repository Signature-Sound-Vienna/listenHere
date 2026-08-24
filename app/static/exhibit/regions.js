// exhibit/regions.js
//
// Annotation regions on the strips — the DISPLAY half only. Nothing here creates,
// edits, moves, or saves an annotation; the exhibit is read-only until visitor
// authoring is decided (plan §6.5, an 18-month horizon).
//
// LEDGER: copied from `annotation/waveform-interactions.js` — see ENGINE-WANTS.md
// row 2, disposition **acceptable permanent divergence**, which is a decision
// closed in plan §8 rather than a shortcut taken here. The reasoning, because a
// copy always looks like laziness later: what that module encodes is *conventions*
// — an id namespace, a metadata stash on the region object, drag and resize
// permissions, pointer mechanics — and the two consumers are entitled to differ
// about all of them. The exhibit has no drag, no alt-scoped edit, no drawer, and
// its regions read from the prepped payload's `targets[].regionTimes` rather than
// from `annotation/state.js`. What must NEVER diverge is the *serialisation* shape,
// and that is on the import side (`annotation/state.js`), not here.
//
// The one thing this file adds that Listen Here does not need: a MINIMUM WIDTH.
// At fit-to-width a 582 s overture is about 0.58 s per pixel, so a region narrower
// than a second is invisible — and `D or E?` region (a) is 0.012–0.120 s wide
// (plan §5.2d) because its alignment is unusable there and it awaits hand
// placement. Silently drawing nothing would hide a known authoring to-do, so those
// regions are widened to a few pixels and marked provisional.
//
// ZERO first-party imports, by rule. It works on the strips it is handed.

/**
 * Id namespace for regions this module owns. The plugin instances belong to the
 * exhibit alone, so nothing else can be in there — but the prefix costs nothing
 * and makes the reconcile below provably scoped, which is why Listen Here has one.
 */
export const EX_REGION_PREFIX = "ex_";

const ALPHA = 0.34;
const ALPHA_ACTIVE = 0.5;

/**
 * Draw the regions for `annotations` across one viewport's strips.
 *
 * Reconciles rather than clears and rebuilds: the audience switch will call this
 * on every change, and destroying sixteen strips' worth of region elements to
 * recreate most of them is both visible as a flicker and pointless work.
 *
 * @param {Map<string, object>} strips     file -> Strip, from strips.js
 * @param {object[]} annotations           already filtered to one audience
 * @param {object} [opts]
 * @param {number} [opts.minRegionPx]      widen anything narrower than this
 * @param {string|null} [opts.activeId]    annotation to emphasise, if any
 */
export function syncRegions(strips, annotations, { minRegionPx = 0, activeId = null } = {}) {
  const specsByFile = computeSpecsByFile(annotations, activeId);
  for (const [file, strip] of strips) {
    const secondsPerPx = _secondsPerPx(strip);
    const specs = (specsByFile[file] || []).map((s) =>
      _widen(s, minRegionPx * secondsPerPx, strip.duration),
    );
    _reconcile(strip.regions, specs);
  }
}

/**
 * One region spec per (recording × annotation × region), keyed by recording.
 *
 * The payload's shape does the filtering work that Listen Here's version had to do
 * against live state: `targets` was already cut to the curated eight at prep time,
 * and `regionTimes` was already re-derived through the canonical index pairs, so a
 * target that is not in this exhibit simply is not here to skip.
 */
export function computeSpecsByFile(annotations, activeId = null) {
  const byFile = {};
  for (const ann of annotations) {
    const isActive = ann.id === activeId;
    const handPlaced = new Set(
      (ann.regions || []).filter((r) => r.needsHandPlacement).map((r) => r.id),
    );
    for (const target of ann.targets || []) {
      const list = (byFile[target.file] ||= []);
      for (const region of ann.regions || []) {
        const t = target.regionTimes?.[region.id];
        // `null` is a real value here: the prep script writes it when an index
        // pair falls outside a grid, and a region with no times for this
        // recording is not drawn rather than drawn at zero.
        if (!t) continue;
        list.push({
          id: `${EX_REGION_PREFIX}${ann.id}_${region.id}`,
          annId: ann.id,
          regionId: region.id,
          start: t.start,
          end: t.end,
          color: _withAlpha(ann.color, isActive ? ALPHA_ACTIVE : ALPHA),
          provisional: handPlaced.has(region.id),
        });
      }
    }
  }
  return byFile;
}

/** Seconds per CSS pixel for a strip at its current zoom. */
function _secondsPerPx(strip) {
  // The rendered width, not the container's: at fit-to-width they are the same,
  // but from week 2 the strips zoom and the inner is wider than the box. Going
  // through the wrapper is also the only way to see it — WaveSurfer 7 builds its
  // wrapper inside a SHADOW ROOT, so a document-level query finds nothing.
  let width = 0;
  try {
    width = strip.ws.getWrapper()?.scrollWidth || 0;
  } catch (_) {
    /* a renderer mid-teardown has no wrapper; fall through to the container */
  }
  if (!width) width = strip.host?.clientWidth || 0;
  if (!width || !strip.duration) return 0;
  return strip.duration / width;
}

/**
 * Grow a sub-minimum region symmetrically about its own centre, clamped to the
 * recording. Symmetric because the region's *midpoint* is the part that survives a
 * re-alignment best — both its edges came from the same index pair — so widening
 * from one edge would move the moment rather than just make it visible.
 */
function _widen(spec, minSeconds, duration) {
  const span = spec.end - spec.start;
  if (!minSeconds || span >= minSeconds) return spec;
  const mid = (spec.start + spec.end) / 2;
  const half = minSeconds / 2;
  const start = Math.max(0, Math.min(mid - half, (duration || 0) - minSeconds));
  return { ...spec, start: Math.max(0, start), end: Math.max(0, start) + minSeconds, widened: true };
}

function _reconcile(plugin, specs) {
  const ours = () =>
    plugin.getRegions().filter((r) => r.id && r.id.startsWith(EX_REGION_PREFIX));
  const wantById = new Map(specs.map((s) => [s.id, s]));
  for (const r of ours()) if (!wantById.has(r.id)) r.remove();

  const existingById = new Map(ours().map((r) => [r.id, r]));
  for (const spec of specs) {
    const cur = existingById.get(spec.id);
    if (cur && cur.start === spec.start && cur.end === spec.end && cur.color === spec.color) {
      cur._exMeta = _meta(spec);
      _mark(cur, spec);
      continue;
    }
    if (cur) cur.remove();
    const r = plugin.addRegion({
      id: spec.id,
      start: spec.start,
      end: spec.end,
      color: spec.color,
      // The read-only exhibit, stated rather than defaulted: WaveSurfer's region
      // defaults are permissive, and `resize` in particular is truthy-by-absence.
      drag: false,
      resize: false,
    });
    if (!r) continue;
    r._exMeta = _meta(spec);
    _mark(r, spec);
  }
}

function _meta(spec) {
  return { annId: spec.annId, regionId: spec.regionId, provisional: !!spec.provisional };
}

/** Flag the provisional ones for CSS. Skipped silently before the first render. */
function _mark(region, spec) {
  if (!region.element) return;
  if (spec.provisional) region.element.dataset.provisional = "1";
  else delete region.element.dataset.provisional;
  if (spec.widened) region.element.dataset.widened = "1";
  else delete region.element.dataset.widened;
}

/**
 * Hex or rgb() to rgba() at `alpha`. Copied unchanged from
 * `annotation/waveform-interactions.js` — the annotation colours in the payload
 * are the same authored values, so a second interpretation of them would let the
 * exhibit and the tool draw the same annotation in two different colours.
 */
function _withAlpha(hexOrRgb, alpha) {
  if (!hexOrRgb) return `rgba(120,120,120,${alpha})`;
  if (hexOrRgb.startsWith("#")) {
    const h = hexOrRgb.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.substring(0, 2), 16);
    const g = parseInt(full.substring(2, 4), 16);
    const b = parseInt(full.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hexOrRgb;
}
