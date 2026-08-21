// engine/grouping-model.js
//
// The grouping MODEL: what groups exist, which recording belongs to which one,
// where that is persisted, and the colour/label primitives every view of a group
// draws with. No view lives here — the sidebar fieldsets, the nav drag-and-drop,
// the content pane's containers, and the Group Recordings modal all stay in
// listen.js and read the answers from here.
//
// The one rule this module exists to keep: within a single grouping context — a
// tab, or an annotation's pinned grouping — a recording belongs to EXACTLY ONE
// group. resolveGroupFor is the only answer to "which one?", resolveGroupMembers
// is the only answer to "which recordings does each group hold?", and
// normaliseGroupOverlap repairs an alignment file that says otherwise. Those
// three used to be five ad-hoc computations that disagreed (roadmap item U).
//
// matchesGroup and resolveGroupFor came from engine/waveform-layout.js, which
// answers *where a row goes* and now asks this module *which group owns it*.
// Everything else came from listen.js (Phase 1 refactor, cluster J, slice 1).
//
// State owned here: the group-id counter. Everything else is read out of
// loadedAlignmentJSON.header.groupingTabs, which listen.js owns.

import { confirmDialog, el } from "../annotation/ui-common.js";
import { loadedAlignmentJSON, SYNTH_MEI_KEY, waveformViews } from "../listen.js";

const _GROUPS_STORAGE_PREFIX = "listenTool_fileGroups_";

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
 * Mint a stable, opaque group id. Used when a new group is created in the
 * grouping modal so the V6 annotation layer can key group notes/comparisons
 * on an identity that survives a later rename. Older groups without an id
 * fall back to their name at snapshot time (see getActiveGroupingSnapshot).
 */
let _groupIdCounter = 0;
export function mintGroupId() {
  return "g_" + Date.now().toString(36) + "_" + _groupIdCounter++;
}

/**
 * Notify listeners that the active application grouping changed (tab switch
 * or grouping-modal apply). The V6 annotation drawer listens for this to
 * re-render the open editor so its "Update to current view" gate reflects
 * the live grouping rather than a stale render-time snapshot.
 */
export function emitGroupingChanged() {
  try {
    document.dispatchEvent(new CustomEvent("lh-grouping-changed"));
  } catch (_) {}
}

/** Returns the localStorage key for the current context. */
function _groupsStorageKey() {
  return _GROUPS_STORAGE_PREFIX + (window.location.pathname || "default");
}

/**
 * Load saved groups from localStorage.
 * Format: [ { name: string, pattern: string, files: string[] }, ... ]
 */
function _loadGroups() {
  try {
    const raw = localStorage.getItem(_groupsStorageKey());
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("Could not load file groups from localStorage:", e);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Grouping Tabs – migration and accessors
// ---------------------------------------------------------------------------

/**
 * Migrate legacy flat fileGroups/groupOrder into the new groupingTabs format.
 * Call once after alignment JSON is loaded.
 */
export function migrateToGroupingTabs() {
  if (!loadedAlignmentJSON) return;
  if (!loadedAlignmentJSON.header) loadedAlignmentJSON.header = {};
  const h = loadedAlignmentJSON.header;

  if (Array.isArray(h.groupingTabs) && h.groupingTabs.length > 0) return;

  // Wrap existing flat groups (or localStorage fallback) into a "Default" tab
  const groups = Array.isArray(h.fileGroups) ? h.fileGroups : _loadGroups();
  const order = Array.isArray(h.groupOrder) ? h.groupOrder : [];
  h.groupingTabs = [{ name: "Default", fileGroups: groups, groupOrder: order }];
  h.activeTab = "Default";

  // Remove legacy flat properties now that they are nested inside the tab
  delete h.fileGroups;
  delete h.groupOrder;
}

/** Return the active tab object (falls back to index 0). */
function _getActiveTab() {
  const h = loadedAlignmentJSON?.header;
  if (!h || !Array.isArray(h.groupingTabs) || h.groupingTabs.length === 0) {
    return { name: "Default", fileGroups: [], groupOrder: [] };
  }
  return (
    h.groupingTabs.find((t) => t.name === h.activeTab) || h.groupingTabs[0]
  );
}

export function getActiveFileGroups() {
  return _getActiveTab().fileGroups || [];
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
 * normalised at load by normaliseGroupOverlap below. Precedence when a
 * defective file does overlap is **first match in group order**, matching that
 * normalisation, so every site agrees even before it runs.
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
  if (filename === SYNTH_MEI_KEY) return null;
  for (const g of groups || []) {
    if (matchesGroup(filename, g)) return g;
  }
  return null;
}

/**
 * Find, report, and normalise recordings that more than one group claims within
 * the same grouping context.
 *
 * A recording belongs to exactly one group per context (a tab, or an
 * annotation's pinned grouping). Switching context may change which one — that
 * is the point of tabs — but two groups claiming it inside one context is a
 * defect in the alignment file, most likely written by an older version. Every
 * membership question in the app now goes through resolveGroupFor, which keeps
 * the FIRST claimant, so this makes the file agree with what the user sees.
 *
 * Only explicit `files` entries can be normalised: a recording claimed by a
 * later group's regex `pattern` cannot be edited out of it without expanding the
 * pattern, which would stop it matching recordings added later. Those are still
 * reported, and resolveGroupFor already resolves them to the first claimant, so
 * behaviour is consistent either way. The grouping modal drops patterns the
 * first time it opens, and its expansion honours first-wins too.
 *
 * Checks every tab, not just the active one: the file is being repaired as a
 * whole, and finding out on a tab switch later would be worse.
 *
 * @param {string[]} filenames every recording in the alignment
 * @returns {Array<{tab: string, file: string, kept: string, dropped: string[],
 *   patternOnly: boolean}>} one entry per over-claimed recording
 */
export function normaliseGroupOverlap(filenames) {
  const tabs = loadedAlignmentJSON?.header?.groupingTabs;
  if (!Array.isArray(tabs)) return [];
  const report = [];
  for (const tab of tabs) {
    const groups = tab.fileGroups || [];
    if (groups.length < 2) continue;
    for (const f of filenames) {
      if (f === SYNTH_MEI_KEY) continue; // never groupable
      const claimants = groups.filter((g) => matchesGroup(f, g));
      if (claimants.length < 2) continue;
      const [kept, ...losers] = claimants;
      for (const g of losers) {
        g.files = (g.files || []).filter((x) => x !== f);
      }
      // A loser whose claim SURVIVES the explicit removal is claiming by regex.
      // We cannot edit one filename out of a pattern without expanding it, which
      // would stop the pattern matching recordings added later — so the claim
      // stays in the file and resolveGroupFor keeps ignoring it. Worth telling
      // the user, since the group will still look like it should hold the row.
      const patternRemains = losers.some((g) => matchesGroup(f, g));
      report.push({
        tab: tab.name || "Default",
        file: f,
        kept: kept.name || "",
        dropped: losers.map((g) => g.name || ""),
        patternRemains,
      });
    }
  }
  return report;
}

/**
 * Tell the user their alignment file claimed a recording in more than one group,
 * and what was done about it. Acknowledgement only — the normalisation has
 * already happened, and the load is complete by the time this shows, so the
 * dialog never sits behind the pane spinner.
 *
 * The repair is in memory: it persists when the user next saves, for their own
 * reasons. Marking the document dirty here would fake user intent and would feed
 * the unsaved-work check in the replace-piece prompt.
 */
export async function warnGroupOverlap(report) {
  if (!report.length) return;
  const multiTab =
    new Set(report.map((r) => r.tab)).size > 1 ||
    (loadedAlignmentJSON?.header?.groupingTabs || []).length > 1;
  const lines = report.map((r) =>
    el("li", { class: "lh-v6-confirm-line removed" }, [
      el("strong", {
        text: r.file.substring(r.file.lastIndexOf("/") + 1),
      }),
      document.createTextNode(
        (multiTab ? ` (tab \u201c${r.tab}\u201d)` : "") +
          " \u2014 also claimed by " +
          r.dropped.map((n) => `\u201c${n}\u201d`).join(", ") +
          `; kept in \u201c${r.kept}\u201d`,
      ),
    ]),
  );
  const anyPatternRemains = report.some((r) => r.patternRemains);
  const body = [
    el("p", { class: "lh-v6-confirm-target" }, [
      "This alignment puts ",
      el("strong", {
        class: "lh-v6-confirm-reason",
        text:
          report.length === 1
            ? "one recording"
            : `${report.length} recordings`,
      }),
      " in more than one group at the same time. A recording can only belong to" +
        " one group at a time, so the extra memberships have been dropped.",
    ]),
    el("ul", { class: "lh-v6-confirm-list" }, lines),
    el("p", {
      class: "lh-v6-confirm-detail",
      text:
        (anyPatternRemains
          ? "A group that claims a recording by filename pattern keeps its" +
            " pattern, so it may still look like it should hold the recording;" +
            " the recording is shown in the first group only. "
          : "") +
        "Nothing has been saved \u2014 the corrected grouping is written the next" +
        " time you save this alignment. Use Group / Manage recordings to change it.",
    }),
  ];
  await confirmDialog({
    title:
      report.length === 1
        ? "A recording was in more than one group"
        : "Recordings were in more than one group",
    confirmLabel: "Continue",
    // Acknowledgement, not a destructive choice: the danger colour goes on the
    // header indicator, and the button stays the ordinary primary one.
    dialogClass: "lh-v6-confirm-danger",
    cancelLabel: null,
    body,
  });
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

/**
 * Snapshot the current grouping (active tab + resolved per-group file
 * memberships) for the V6 annotation pinned-grouping field. Resolves
 * each group's `files` list + `pattern` regex against the currently
 * loaded waveforms so the snapshot reflects what the user actually sees.
 * Returns null when no alignment data is loaded.
 */
export function getActiveGroupingSnapshot() {
  if (!loadedAlignmentJSON) return null;
  const tab = _getActiveTab();
  const groups = getActiveFileGroups();
  // Working set: this snapshot is persisted with the annotation, so it must
  // describe what the user has in the pane, not which rows happen to be built.
  const loadedFiles = Object.keys(waveformViews);
  // One group per recording, via the shared resolver: within a grouping context
  // — a tab, or an annotation's pinned grouping — a recording belongs to exactly
  // one group. This snapshot is persisted with the annotation, so it used to be
  // possible to save a recording under two groups at once (roadmap item U).
  const members = resolveGroupMembers(loadedFiles, groups);
  const out = { name: tab.name || "Default", groups: [] };
  for (const [gi, g] of groups.entries()) {
    const files = members[gi];
    out.groups.push({
      // Stable identity for the group, independent of its display label.
      // Source groups created via the grouping modal carry a minted `id`;
      // older groups (and the score foldout) fall back to their name. This
      // id is what the V6 annotation layer keys group notes/comparisons on
      // and what survives a group rename across a re-pin.
      groupId: g.id || g.name || "",
      label: g.name || "",
      color: g.color || "#94a3b8",
      files,
    });
  }
  return out;
}

export function getActiveGroupOrder() {
  return _getActiveTab().groupOrder || [];
}

export function setActiveFileGroups(groups) {
  const tab = _getActiveTab();
  tab.fileGroups = groups;
}

export function setActiveGroupOrder(order) {
  const tab = _getActiveTab();
  tab.groupOrder = order;
}
