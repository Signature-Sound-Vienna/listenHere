// engine/waveform-layout.js
//
// Where a waveform's row goes in the pane. This is *layout*, not lifecycle:
// nothing here knows about WaveSurfer, audio, or peaks. It builds the `.waveform`
// row element, works out which group container owns it, parents it there, and
// hangs the reorder-drag affordance off it.
//
// It was the first ~105 lines of prepareWaveform. Splitting it out separates the
// two questions that function used to answer at once: "does this recording have a
// row in the pane?" (here) and "does that row have a renderer yet?" (the
// lazy-creation decision, which stays in listen.js as orchestration).
//
// Group *container* order is owned entirely by ensureWaveformGroupContainers —
// saved groupOrder first, else Score, then named groups, then Ungrouped. This
// module must not reorder them. Row order *within* a container is the user's, set
// by drag-and-drop and persisted by _persistGroupOrder.
//
// Extracted from listen.js (Phase 1 refactor, cluster L, slice L3).
// Behaviour-preserving, with one deliberate exception: prepareWaveform's trailing
// "resort waveforms to maintain order" block (score → VPO- → other) was DROPPED
// rather than moved. It predates group containers and had become dead — the pane
// root has no `.waveform` children any more, so both its score and VPO buckets
// were always empty. Its only remaining effect was harmful: an inconsistent
// comparator (`a.id > b.id ? 1 : -1`) over the id-less `.file-group` divs
// reversed the containers on every row creation, so the Score group rendered
// last whenever an odd number of rows was built. See the 0.25.0 changelog.

import {
  alignmentGrids,
  loadedAlignmentJSON,
  SYNTH_MEI_KEY,
  ensureWaveformGroupContainers,
  getActiveFileGroups,
  hideWaveformsPaneLoading,
  isDrawModeActive,
} from "../listen.js";
import { ensureWaveformView } from "./waveform-view.js";

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
 * normalised at load by listen.js's group-overlap check. Precedence when a
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
 * The `.group-list` that should hold `filename`'s row.
 *
 * Precedence, unchanged from prepareWaveform: the Score container for the synth
 * key, then the FIRST group that claims the filename, else the ungrouped
 * container, else the pane root.
 *
 * Membership comes from resolveGroupFor, which _switchActiveTab now shares — the
 * two used to resolve it independently and disagreed (first-wins here, last-wins
 * there), so a recording in two groups moved between them on a tab round-trip.
 * Roadmap item U; the score row is never groupable, which resolveGroupFor owns.
 */
function _resolveGroupList(filename, waveformsRoot) {
  if (filename === SYNTH_MEI_KEY) {
    const scoreList = waveformsRoot.querySelector(
      ".file-group-score .group-list",
    );
    if (scoreList) return scoreList;
  }
  const groups = loadedAlignmentJSON ? getActiveFileGroups() : [];
  const g = resolveGroupFor(filename, groups);
  if (g) {
    const fg = waveformsRoot.querySelector(
      `.file-group[data-group='${CSS.escape(g.name)}']`,
    );
    const list = fg?.querySelector(".group-list");
    if (list) return list;
  }
  // Leave in the ungrouped container, or on the pane root if there is none.
  return (
    waveformsRoot.querySelector(".file-group-ungrouped .group-list") ||
    waveformsRoot
  );
}

/**
 * Add the reorder handle and wire the native HTML5 drag that moves a row
 * between group containers. The drop side lives with the containers, in
 * ensureWaveformGroupContainers.
 */
function _attachRowDragHandle(waveform, filename) {
  const handle = document.createElement("div");
  handle.className = "wf-drag-handle";
  waveform.appendChild(handle);
  waveform.draggable = true;
  waveform.addEventListener("dragstart", (ev) => {
    // In draw mode the gesture belongs to WaveSurfer's region creation, not
    // a native reorder drag. The CSS `-webkit-user-drag: none` guard is
    // WebKit-only, so cancel the native drag here too — otherwise dragstart
    // fires, adds `dragging`, and (since the drag is consumed by region
    // drawing) no dragend arrives to remove it, leaving the waveform stuck
    // at opacity 0.6 once edit mode's override is gone.
    if (isDrawModeActive()) {
      ev.preventDefault();
      return;
    }
    ev.dataTransfer.setData("text/plain", filename);
    ev.currentTarget.classList.add("dragging");
  });
  waveform.addEventListener("dragend", (ev) => {
    ev.currentTarget.classList.remove("dragging");
  });
}

/**
 * Create `filename`'s row in the pane and return it.
 *
 * Registers the WaveformView as soon as the element exists, so the recording
 * joins the WORKING SET here — before, and independently of, any decision to
 * build it a renderer.
 */
export function createWaveformRow(filename) {
  const waveform = document.createElement("div");
  waveform.id = "waveform-" + filename + "-wav";
  waveform.dataset.ix = filename;
  waveform.classList.add("waveform");

  // Ensure group containers exist and append into the appropriate group-list
  const allFilenames = Object.keys(alignmentGrids || {})
    .filter((n) => n !== SYNTH_MEI_KEY)
    .sort();
  ensureWaveformGroupContainers(allFilenames.concat(SYNTH_MEI_KEY));
  const waveformsRoot = document.getElementById("waveforms");
  _resolveGroupList(filename, waveformsRoot).appendChild(waveform);

  // Register the view as soon as the row exists. From here on this recording
  // is in the working set even though it has no WaveSurfer yet; the view's
  // canvases are filled in later, in the "ready" handler.
  ensureWaveformView(filename, waveform);
  // The pane has content now; the per-waveform overlays take it from here.
  hideWaveformsPaneLoading();
  _attachRowDragHandle(waveform, filename);
  return waveform;
}
