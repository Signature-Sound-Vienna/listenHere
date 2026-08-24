// engine/grouping-core.js
//
// The grouping READ model: which group owns a recording, which recordings each
// group holds, what the active tab's groups are, and the colour/label primitives
// every view of a group draws with. Nothing here writes, persists, migrates, or
// asks the user anything — that half stayed in engine/grouping-model.js.
//
// The split exists because this half is SEMANTICS and the other half is
// authoring. Annotations pin to group ids, so a second copy of resolveGroupFor
// would let the exhibit and the tool disagree about which recordings an
// annotation is about. The same argument as engine/align-core.js.
//
// The one rule this module exists to keep: within a single grouping context — a
// tab, or an annotation's pinned grouping — a recording belongs to EXACTLY ONE
// group. resolveGroupFor is the only answer to "which one?" and
// resolveGroupMembers the only answer to "which recordings does each group
// hold?". Those two used to be five ad-hoc computations that disagreed (roadmap
// item U); grouping-model.js's normaliseGroupOverlap repairs a file that says
// otherwise.
//
// ZERO imports. The two things it cannot compute — where the alignment JSON
// lives, and which key means "the synthesised score" — are injected once via
// configureGroupingCore, so every existing call site keeps its signature.
//
// Split out of engine/grouping-model.js (Phase 2, week 0, plan §4.0c).
// Behaviour-preserving.

// ---------------------------------------------------------------------------
// Injected context.
//
// The plan sketched three members; only two are needed. `isInWorkingSet` was
// for getActiveGroupingSnapshot, the sole reader of listen.js's `waveformViews`
// — and that function snapshots grouping FOR PERSISTENCE, so it stayed on the
// authoring side and took its dependency with it.
//
// Defaults are inert rather than clever: no alignment, and a score key that
// matches nothing. A consumer that forgets to configure sees empty groups, not
// wrong ones.
// ---------------------------------------------------------------------------
let _ctx = { getAlignment: () => null, SYNTH_MEI_KEY: null };

/**
 * Point the grouping read model at its host's state. Call once, before any
 * grouping question is asked.
 * @param {{getAlignment: () => (object|null), SYNTH_MEI_KEY: (string|null)}} ctx
 */
export function configureGroupingCore(ctx) {
  _ctx = { ..._ctx, ...(ctx || {}) };
}

/** Predefined pastel palette for group colours (similar saturation, subtle). */
export const GROUP_PALETTE = [
  "#dbeafe", // soft blue
  "#dcfce7", // soft green
  "#fce7f3", // soft pink
  "#ede9fe", // soft lavender
  "#ffedd5", // soft peach
  "#ccfbf1", // soft teal
  "#fef9c3", // soft yellow
  "#ffe4e6", // soft rose
  "#e0e7ff", // soft indigo
  "#d1fae5", // soft mint
  "#fde68a", // soft amber
  "#e9d5ff", // soft purple
];

/** Return a legible text colour (#222 or #fff) for a given hex background. */
export function groupTextColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#222' : '#fff';
}

/**
 * Security: alignment JSON can come from an attacker-controlled URL.
 * Colours from header.fileGroups[].color end up in inline `style.color` /
 * `style.backgroundColor`. Browsers reject obvious script-in-CSS via the
 * .style.X setter, but bad values silently land in computed garbage; we
 * accept only #hex and rgb/rgba forms — same shape as V6's sanitiser.
 */
const _SAFE_HEX_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const _SAFE_RGB_RE = /^rgba?\(\s*\d{1,3}(\s*,\s*\d{1,3}){2}(\s*,\s*(0|1|0?\.\d+))?\s*\)$/;
export function safeColor(c) {
  if (typeof c !== "string") return null;
  const t = c.trim();
  if (_SAFE_HEX_RE.test(t) || _SAFE_RGB_RE.test(t)) return t;
  return null;
}

/**
 * Build a `.group-title` element safely (no innerHTML). The label is set
 * via textContent so a malicious alignment.json fileGroups[].name can't
 * inject script tags.
 */
export function buildGroupTitle(labelText) {
  const title = document.createElement("div");
  title.className = "group-title";
  // Lead with a text node carrying the (untrusted) label.
  title.appendChild(document.createTextNode(labelText + " "));
  const count = document.createElement("span");
  count.className = "group-count";
  const actions = document.createElement("span");
  actions.className = "group-actions";
  const all = document.createElement("span");
  all.className = "group-all";
  all.textContent = "All";
  const none = document.createElement("span");
  none.className = "group-none";
  none.textContent = "None";
  actions.append(all, none);
  title.append(count, actions);
  return title;
}

/** Return the next palette colour not yet used by any group. */
export function nextGroupColour(groups) {
  const used = new Set((groups || []).map((g) => g.color).filter(Boolean));
  for (const c of GROUP_PALETTE) {
    if (!used.has(c)) return c;
  }
  // All used — cycle back
  return GROUP_PALETTE[(groups || []).length % GROUP_PALETTE.length];
}

/**
 * Return the active tab object (falls back to index 0).
 *
 * Exported, and therefore de-underscored (spec 26.1): grouping-model.js needs
 * the same tab object to write into, so the authoring half cannot disagree with
 * the read half about which tab is active.
 */
export function getActiveTab() {
  const h = _ctx.getAlignment()?.header;
  if (!h || !Array.isArray(h.groupingTabs) || h.groupingTabs.length === 0) {
    return { name: "Default", fileGroups: [], groupOrder: [] };
  }
  return (
    h.groupingTabs.find((t) => t.name === h.activeTab) || h.groupingTabs[0]
  );
}

export function getActiveFileGroups() {
  return getActiveTab().fileGroups || [];
}

/**
 * Does `filename` belong to group `g` — by explicit membership or by pattern?
 *
 * Returns false rather than throwing on a malformed pattern: the grouping modal
 * flags invalid regexes for the user, and a bad one saved into an alignment
 * must not stop the pane from rendering.
 */
export function matchesGroup(filename, g) {
  if (new Set(g.files || []).has(filename)) return true;
  if (!g.pattern) return false;
  try {
    const re = new RegExp(g.pattern);
    const short = filename.substring(filename.lastIndexOf("/") + 1);
    return re.test(short) || re.test(filename);
  } catch (_) {
    return false;
  }
}

/**
 * THE answer to "which group does this recording belong to?" — the single source
 * of truth for group membership, in every context.
 *
 * Within one grouping context (a tab, or an annotation's pinned grouping) a
 * recording belongs to **exactly one** group. Switching context may change which
 * one; overlapping membership inside a context is a defect in the alignment file,
 * normalised at load by grouping-model.js's normaliseGroupOverlap. Precedence
 * when a defective file does overlap is **first match in group order**, matching
 * that normalisation, so every site agrees even before it runs.
 *
 * Before this existed the question was answered five times over — twice
 * single-valued (row placement first-wins, tab switch last-wins) and three times
 * multi-valued (sidebar, container builder, annotation snapshot). A recording in
 * two groups therefore moved between them on a tab round-trip, and left behind a
 * container that existed, was titled and coloured, and whose badge claimed a
 * recording it never showed. See roadmap item U.
 *
 * The score row is never groupable: it has its own dedicated container, so it
 * resolves to null here no matter what a pattern says.
 *
 * @param {string} filename
 * @param {Array<{name: string, files?: string[], pattern?: string}>} groups
 * @returns {object|null} the owning group, or null when ungrouped
 */
export function resolveGroupFor(filename, groups) {
  if (filename === _ctx.SYNTH_MEI_KEY) return null;
  for (const g of groups || []) {
    if (matchesGroup(filename, g)) return g;
  }
  return null;
}

/**
 * Resolve `filenames` into one member list per group in `groups`, in the same
 * order as `groups`.
 *
 * Single-valued by construction: a recording appears in exactly one list, the
 * first group that claims it (see resolveGroupFor). The sidebar, the content
 * pane's container builder, and the annotation snapshot all go through here, so
 * they cannot drift apart again — which they had, each answering "which group?"
 * its own way (roadmap item U).
 */
export function resolveGroupMembers(filenames, groups) {
  const lists = (groups || []).map(() => []);
  const indexByGroup = new Map((groups || []).map((g, i) => [g, i]));
  for (const f of filenames) {
    const g = resolveGroupFor(f, groups);
    if (!g) continue;
    const i = indexByGroup.get(g);
    if (i !== undefined) lists[i].push(f);
  }
  return lists.map((l) => l.sort());
}
