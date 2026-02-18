// Re-export globals set by the template's inline <script>
export let versionString = window.versionString;
export let versionDate = window.versionDate;

import { populateSolidTab, loginAndFetch, solidLogout } from "./solid.js";

let markers = [];
let loaded = new Set();
let alignmentGrids = {};
let scoreAlignment; // score tstamp to ref tstamp maps for onset and offset
let timemap = []; // verovio timemap
let mei = null; // MEI XML
let meiDOM = null; // MEI DOM
let parser = new DOMParser(); // XML parser for MEI
let ref;
export let currentAudioIx = "";
export let currentlyAnnotatedRegions = []; // alignment indexes of start and end for each active annotated region
export let maoSelections = [];
let referenceAudioIx;
let colorMap;
let timerFrom = 0;
let timerTo = 0;
let tk; // verovio toolkit

// seconds by which to nudge markers when arrow keys pressed in close-listening mode
const smallMarkerNudge = 0.02;
const bigMarkerNudge = 0.1;

export let storage;
export let meiUri;
export let currentlyActiveMaoSelection = "";
export let wavesurfers = {};

// File picker: maps alignment audio keys to blob URLs from user-selected files
let fileBlobUrls = new Map();
let useFilesMode = false;

// HTTP Basic Auth: scoped per-origin to avoid leaking credentials
// Maps origin string -> { credentials, requestHeaders } xhr options
// NOTE: WaveSurfer v4 uses `xhr` with `requestHeaders: [{key, value}]`.
// When upgrading to WaveSurfer v7, change to `fetchParams` with standard
// `headers: { Authorization: 'Basic ...' }` — update xhrOptionsForUrl().
let authByOrigin = new Map();
let authPromptedOrigins = new Set();

// Close-listening mode state
let closeListeningMode = false;
let activeMarkerIx = null; // index into markers[] array

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function xhrOptionsForUrl(url) {
  const origin = getOrigin(url);
  if (origin && authByOrigin.has(origin)) {
    return authByOrigin.get(origin);
  }
  return {};
}

function promptForAuth(failedUrl) {
  const origin = getOrigin(failedUrl);
  if (!origin || authPromptedOrigins.has(origin)) return false;
  authPromptedOrigins.add(origin);
  const user = prompt(
    `Audio server ${origin} requires authentication.\nUsername:`,
  );
  if (user === null) return false;
  const pass = prompt("Password:");
  if (pass === null) return false;
  const token = btoa(user + ":" + pass);
  authByOrigin.set(origin, {
    requestHeaders: [{ key: "Authorization", value: "Basic " + token }],
  });
  return true;
}

function reloadWaveformsForOrigin(authedOrigin) {
  // Only reload waveforms whose audio URL matches the authenticated origin
  for (const [filename, ws] of Object.entries(wavesurfers)) {
    const url = resolveAudioUrl(filename);
    if (getOrigin(url) === authedOrigin) {
      ws.params.xhr = authByOrigin.get(authedOrigin);
      ws.load(url);
    }
  }
}

try {
  storage = window.localStorage;
} catch (err) {
  console.warn("unable to access local storage: ", err);
}

function resolveAudioUrl(filename) {
  // If ?useFiles is active and we have a blob URL for this file, use it
  if (useFilesMode && fileBlobUrls.has(filename)) {
    return fileBlobUrls.get(filename);
  }
  // If ?useLocal is present, override with local base URL
  let useLocal = params.get("useLocal");
  if (useLocal !== null) {
    let base = useLocal || "http://127.0.0.1:8080";
    let name = filename.split("/").pop();
    return base.replace(/\/$/, "") + "/" + name;
  }
  // Full URLs: load directly from the web
  if (filename.startsWith("http://") || filename.startsWith("https://")) {
    return filename;
  }
  // Relative paths: load from local static files
  return root + "wav/" + filename;
}

function seekToLastMark() {
  if (markers.length) {
    const currentAlignmentIx = getClosestAlignmentIx();
    const prevMarkers = markers.filter((m) => m <= currentAlignmentIx);
    let lastMarker;
    if (prevMarkers.length) lastMarker = prevMarkers[prevMarkers.length - 1];
    else lastMarker = 0;
    wavesurfers[currentAudioIx].seekTo(
      getCorrespondingTime(currentAudioIx, lastMarker) /
        wavesurfers[currentAudioIx].getDuration(),
    );
  }
}

// --- Marker redraw helper ---
// Redraws all markers on all wavesurfers, highlighting the active marker in close-listening mode
function redrawAllMarkers() {
  Object.keys(wavesurfers).forEach((ws) => {
    wavesurfers[ws].clearMarkers();
    wavesurfers[ws].addMarker({
      time: 0,
      label: ws,
      color: "black",
      position: "top",
    });
    markers.forEach((m, i) => {
      const t = getCorrespondingTime(ws, m);
      const color =
        closeListeningMode && activeMarkerIx === i ? "#8b0000" : "red";
      wavesurfers[ws].addMarker({ time: t, color });
    });
  });
}

// --- Resize handling ---

function showWaveformOverlays() {
  document.querySelectorAll("#waveforms .waveform").forEach((wf) => {
    // Hide the inner wave element (canvas + markers)
    const wave = wf.querySelector("wave");
    if (wave) wave.style.visibility = "hidden";
    showWaveformOverlay(wf, "Redrawing\u2026");
  });
}

function showWaveformOverlay(wfEl, statusText) {
  let overlay = wfEl.querySelector(".wf-resize-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "wf-resize-overlay";
    overlay.innerHTML =
      '<div class="resize-spinner"></div><span class="wf-overlay-status"></span>';
    wfEl.appendChild(overlay);
  }
  const statusEl = overlay.querySelector(".wf-overlay-status");
  if (statusEl) statusEl.textContent = statusText || "";
  overlay.style.display = "flex";
}

function updateWaveformOverlayStatus(wfEl, statusText) {
  const overlay = wfEl.querySelector(".wf-resize-overlay");
  if (!overlay) return;
  const statusEl = overlay.querySelector(".wf-overlay-status");
  if (statusEl) statusEl.textContent = statusText || "";
}

function hideWaveformOverlay(wfEl) {
  const overlay = wfEl.querySelector(".wf-resize-overlay");
  if (overlay) overlay.style.display = "none";
  const wave = wfEl.querySelector("wave");
  if (wave) wave.style.visibility = "";
}

window.addEventListener("resize", () => {
  if (Object.keys(wavesurfers).length === 0) return;
  // Immediately clear all markers so stale positions aren't visible
  Object.keys(wavesurfers).forEach((ws) => wavesurfers[ws].clearMarkers());
  showWaveformOverlays();
});

// --- Close-listening mode ---

function enterCloseListeningMode(markerArrayIndex) {
  if (markers.length === 0) return;
  closeListeningMode = true;
  activeMarkerIx =
    markerArrayIndex != null ? markerArrayIndex : findClosestMarkerIndex();
  redrawAllMarkers();
  seekToActiveMarker();
  updateCloseListeningBadge();
}

function exitCloseListeningMode() {
  closeListeningMode = false;
  activeMarkerIx = null;
  redrawAllMarkers();
  updateCloseListeningBadge();
}

function seekToActiveMarker() {
  if (activeMarkerIx == null || !currentAudioIx) return;
  const alignIx = markers[activeMarkerIx];
  const t = getCorrespondingTime(currentAudioIx, alignIx);
  const duration = wavesurfers[currentAudioIx].getDuration();
  wavesurfers[currentAudioIx].seekTo(t / duration);
}

function findClosestMarkerIndex() {
  // Find the closest marker at or before current playback position.
  // If none, use the closest marker in the future.
  if (markers.length === 0) return null;
  const currentAlignIx = getClosestAlignmentIx();
  // Build sorted array of {markerArrayIndex, alignmentIx}
  const sorted = markers.map((m, i) => ({ i, m })).sort((a, b) => a.m - b.m);
  // Find closest at or before current position
  let best = null;
  for (const entry of sorted) {
    if (entry.m <= currentAlignIx) best = entry;
  }
  if (best != null) return best.i;
  // No marker in the past; use closest in the future
  return sorted[0].i;
}

function getSortedMarkerIndices() {
  // Returns indices into markers[] sorted by their alignment grid position
  return markers
    .map((m, i) => ({ i, m }))
    .sort((a, b) => a.m - b.m)
    .map((x) => x.i);
}

function updateCloseListeningBadge() {
  const badge = document.getElementById("close-listening-badge");
  if (badge) {
    badge.style.display = closeListeningMode ? "" : "none";
  }
}

function getClosestAlignmentIx(
  time = wavesurfers[currentAudioIx].getCurrentTime(),
  audioIx = currentAudioIx,
) {
  console.log("Get closest alignment Ix: ", time, audioIx);
  // return alignment index closest to supplied time (default: current playback position)
  let currentGrid = alignmentGrids[audioIx];
  // find the last grid entry at or below target time
  const lower = currentGrid.filter((t) => t <= time);
  const belowIx = lower.length - 1; // last index at or below time
  const aboveIx = lower.length; // first index above time
  if (belowIx < 0) return 0; // time is before grid start
  if (aboveIx >= currentGrid.length) return belowIx; // time is past grid end
  // return whichever is closer (prefer earlier on tie)
  const distBelow = time - currentGrid[belowIx];
  const distAbove = currentGrid[aboveIx] - time;
  return distAbove < distBelow ? aboveIx : belowIx;
}

export function getCorrespondingTime(audioIx, alignmentIx) {
  // get time position corresponding to current position of current audio,
  // in the alternative audio with index audioIx
  let grid = alignmentGrids[audioIx];
  return grid[alignmentIx];
}

function onClickRenditionName(e) {
  // Catches clicks on checkboxes or labels
  // Used to load / switch to the respective rendition
  let checkbox;
  if (e.target.nodeName.toLowerCase() === "label") {
    // retrieve checkbox
    checkbox = document.getElementById(e.target.for);
  } else if (e.target.nodeName.toLowerCase === "li") {
    checkbox = e.target.querySelector("input");
  } else {
    checkbox = e.target;
  }
  console.log("CLick: ", e);
  console.log("Checkbox: ", checkbox);

  if (checkbox.value) {
    const status = document
      .getElementById(checkbox.value)
      .querySelector("label").classList;
    if (!status.contains("ready") && !status.contains("loading")) {
      status.add("loading");
    }
    prepareWaveform(checkbox.value);
    console.log("Clicked!", checkbox.value);
  }
}

function onClickRenditionCheckbox(e) {
  // n.b. separate handler to onClickRenditionName
  // used only to specifically show/hide renditions when
  // they have already loaded
  let checkbox = e.target;
  let checked = checkbox.checked;
  let label = checkbox.parentElement.querySelector("label");
  let waveform = document.getElementById("waveform-" + e.target.value + "-wav");
  let spectrogram = document.getElementById(
    "waveform-" + e.target.value + "-spec",
  );
  if (!checked) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "none";
    spectrogram.style.display = "none";
    checkbox.checked = false;
    label.classList.remove("ready");
    label.classList.add("loading");
  } else if (label.classList.contains("loading")) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "unset";
    if (document.getElementById("showSpectrograms").checked)
      spectrogram.style.display = "unset";
    checkbox.checked = true;
    label.classList.remove("loading");
    label.classList.add("ready");
  } else {
    // user clicked unloaded checkbox, so it is now checked
    // uncheck it again - it wil set itself after loading finished
    checkbox.checked = false;
  }
}

function swapCurrentAudio(newAudio) {
  if (currentAudioIx === newAudio) {
    // no need to swap
    return;
  }
  if (currentAudioIx) {
    console.log("Pausing current: ", currentAudioIx);
    console.log(
      "Current duration: ",
      wavesurfers[currentAudioIx].getDuration(),
    );
    const wasPlaying = wavesurfers[currentAudioIx].isPlaying();
    wavesurfers[currentAudioIx].pause();
    let closestAlignmentIx = getClosestAlignmentIx();
    document
      .getElementById(`waveform-${currentAudioIx}` + "-wav")
      .classList.remove("active");
    // swap to new audio and alignment grid
    currentAudioIx = newAudio;
    console.log("new audio ix: ", currentAudioIx);
    let currentGrid = alignmentGrids[currentAudioIx];
    console.log("new audio grid: ", alignmentGrids[currentAudioIx]);
    console.log("new duration: ", wavesurfers[currentAudioIx].getDuration());
    let newWaveform = document.getElementById(
      `waveform-${currentAudioIx}` + "-wav",
    );
    // highlight as active
    newWaveform.classList.add("active");
    // scroll to position
    let bbox = newWaveform.getBoundingClientRect();
    let waveforms = document.getElementById("waveforms");
    waveforms.scrollTo({
      top: bbox.top + waveforms.scrollTop - 128,
      left: 0,
      behavior: "smooth",
    });
    // seek to new (corresponding) position
    let transitionToLastMark =
      document.getElementById(`transitionType`).checked;
    console.log("transitionToLastMark: ", transitionToLastMark);
    let correspondingPosition = currentGrid[closestAlignmentIx];
    let newPosition =
      correspondingPosition / wavesurfers[currentAudioIx].getDuration();
    wavesurfers[currentAudioIx].seekTo(newPosition);
    if (transitionToLastMark) {
      seekToLastMark();
    }
    if (wasPlaying) wavesurfers[currentAudioIx].play();
  } else {
    currentAudioIx = newAudio;
    const newActiveWaveform = document.getElementById(
      `waveform-${currentAudioIx}` + "-wav",
    );
    if (newActiveWaveform) {
      newActiveWaveform.classList.add("active");
    }
  }
}

function generateCheckboxList(list) {
  console.log("Generate checkbox list: ", list);
  // generate content for <ul>:
  // <li> containing a checkbox for each list member
  const ul = document.createElement("ul");
  list.forEach((n) => {
    const li = document.createElement("li");
    li.classList.add("renditionName");
    li.id = n;
    const checkboxSpan = document.createElement("span");
    const checkbox = document.createElement("input");
    checkbox.id = "checkbox-" + n;
    checkbox.name = "checkbox-" + n;
    checkbox.type = "checkbox";
    checkbox.classList.add("renditionCheckbox");
    checkbox.value = n;
    const label = document.createElement("label");
    label.for = "checkbox-" + n;
    label.innerText = n.substr(n.indexOf("/") + 1); // HACK, use semantic title
    checkboxSpan.appendChild(checkbox);
    checkboxSpan.appendChild(label);
    li.appendChild(checkboxSpan);
    ul.appendChild(li);
  });
  return ul;
}

function reloadWaveforms() {
  let playPosition = 0;
  let isPlaying = false;
  const prevLoaded = Object.keys(wavesurfers);
  if (currentAudioIx) {
    playPosition = wavesurfers[currentAudioIx].getCurrentTime();
    isPlaying = wavesurfers[currentAudioIx].isPlaying();
  }
  // get current play position of active wavesurfer
  // destroy current wavesurfers
  prevLoaded.forEach((ws) => wavesurfers[ws].destroy());
  wavesurfers = {};
  // forget waveform elements (and spectorgrams)
  document.getElementById("waveforms").replaceChildren();
  // re-create previously loaded waveforms
  prevLoaded.forEach((ws) => prepareWaveform(ws, playPosition, isPlaying));
}

function visualiseAlignments() {
  // go through all wavesurfers, throw out user-defined markers, and instead draw in alignment positions as markers
  Object.keys(wavesurfers).forEach((ws) => {
    wavesurfers[ws].clearMarkers();
    alignmentGrids[ws].forEach((t) => {
      wavesurfers[ws].addMarker({ time: t, color: "red" });
      wavesurfers[ws].on("hover", (e) => {
        console.log("HOVER: ", e);
      });
    });
  });
}

function prepareWaveform(filename, playPosition = 0, isPlaying = false) {
  console.log(
    "preparing waveform, currently annotated regions:",
    currentlyAnnotatedRegions,
  );
  // if not yet created, do so:
  if (!(filename in wavesurfers)) {
    const waveform = document.createElement("div");
    waveform.id = "waveform-" + filename + "-wav";
    waveform.dataset.ix = filename;
    waveform.classList.add("waveform");
    const spectrogram = document.createElement("div");
    spectrogram.id = "waveform-" + filename + "-spec";
    spectrogram.dataset.ix = filename;
    spectrogram.classList.add("spectrogram");
    let waveforms = document.getElementById("waveforms");
    // add elements to waveforms
    waveforms.appendChild(spectrogram);
    waveforms.appendChild(waveform);
    // now resort waveforms to maintain order, prioritizing VPO
    let vpo = [...waveforms.children].filter((n) =>
      n.id.substr(n.id.lastIndexOf("/") + 1).startsWith("VPO-"),
    );
    let other = [...waveforms.children].filter(
      (n) => !n.id.substr(n.id.lastIndexOf("/") + 1).startsWith("VPO-"),
    );
    vpo
      .sort((a, b) => (a.id > b.id ? 1 : -1))
      .forEach((node) => waveforms.appendChild(node));
    other
      .sort((a, b) => (a.id > b.id ? 1 : -1))
      .forEach((node) => waveforms.appendChild(node));
    // create new wavesurfer instance in the new container
    /* HACK (DH 2023): eventually, show all annotated regions
     * For now, only allow one at a time
     */
    let regions = extractCurrentlyAnnotatedRegions(filename);
    let annoRegions = WaveSurfer.regions.create({ regions });
    //let annoRegions = [];
    /*
    let annoFrom = 0;
    let annoTo = 0;
    if (currentlyAnnotatedRegions.length) {
      annoFrom = currentlyAnnotatedRegions[0].from;
      annoTo = currentlyAnnotatedRegions[0].to;
    }
    annoRegions = WaveSurfer.regions.create({
      regions: [
        {
          id: "anno_region_0",
          start: getCorrespondingTime(filename, annoFrom),
          end: getCorrespondingTime(filename, annoTo),
          drag: false,
          color: "rgba(200, 130, 80, 0.3)",
        },
      ],
    });*/

    wavesurfers[filename] = WaveSurfer.create({
      container: `#${CSS.escape("waveform-" + filename) + "-wav"}`,
      waveColor: "violet",
      progressColor: "purple",
      normalize: document.getElementById("normalize").checked,
      responsive: true,
      xhr: xhrOptionsForUrl(resolveAudioUrl(filename)),
      plugins: [
        WaveSurfer.markers.create({}),
        WaveSurfer.spectrogram.create({
          wavesurfer: wavesurfers[filename],
          container: `#${CSS.escape("waveform-" + filename + "-spec")}`,
          labels: true,
          colorMap: colorMap,
          height: 128,
        }),
        WaveSurfer.cursor.create({
          showTime: true,
          opacity: 1,
          customShowTimeStyle: {
            "background-color": "#000",
            color: "#fff",
            padding: "2px",
            "font-size": "10px",
          },
        }),
        WaveSurfer.regions.create({
          regions: [
            {
              id: "timer",
              start: 0,
              end: 0,
              drag: false,
              resize: false,
              color: "rgba(255, 0, 100, 0.3)",
            },
          ],
        }),
        annoRegions,
      ],
    });
    // add filename label marker
    wavesurfers[filename].addMarker({
      time: 0,
      label: filename,
      color: "black",
      position: "top",
    });
    // add any user-generated markers
    markers.forEach((m) => {
      const t = getCorrespondingTime(filename, m);
      wavesurfers[filename].addMarker({ time: t, color: "red" });
    });
    wavesurfers[filename].load(resolveAudioUrl(filename));
    // Show loading overlay immediately
    const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
    showWaveformOverlay(wfEl, "Loading audio\u2026");
    // Update overlay with download progress
    wavesurfers[filename].on("loading", (pct) => {
      if (pct < 100) {
        updateWaveformOverlayStatus(wfEl, `Loading audio\u2026 ${pct}%`);
      } else {
        updateWaveformOverlayStatus(wfEl, "Rendering waveform\u2026");
      }
    });
    // Handle 401 errors: prompt for credentials and retry (scoped to origin)
    wavesurfers[filename].on("error", function (err) {
      if (err && err.message && err.message.includes("401")) {
        const url = resolveAudioUrl(filename);
        const origin = getOrigin(url);
        if (promptForAuth(url)) {
          reloadWaveformsForOrigin(origin);
        }
      }
    });
    function updatePositionIndicator() {
      // work out current alignment grid index via binary search
      const grid = alignmentGrids[filename];
      const currentTime = wavesurfers[filename].getCurrentTime();
      let lo = 0,
        hi = grid.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (grid[mid] <= currentTime) lo = mid + 1;
        else hi = mid;
      }
      // lo is now the first index where grid[lo] > currentTime;
      // subtract 1 to get the last index at or before currentTime
      let currentGridIx = Math.max(0, lo - 1);
      if (currentGridIx <= 0 && currentTime > grid[grid.length - 1]) {
        // past the end
        currentGridIx = grid.length - 1;
      }
      // iterate through all positionIndicatorCanvases, drawing in current ix position for that canvas
      const canvases = document.getElementsByClassName("position-indicator");
      const playingDuration = wavesurfers[filename].getDuration();
      Array.from(canvases).forEach((c) => {
        const file = c.closest(".waveform").dataset["ix"];
        const ctx = c.getContext("2d");
        const correspondingSeconds = alignmentGrids[file][currentGridIx];
        const duration = wavesurfers[file].getDuration();
        // absoluteX: where the playing file's cursor actually is (proportional position)
        const absoluteX = (currentTime / playingDuration) * c.width;
        const relativeX = (correspondingSeconds / duration) * c.width;
        const diffMapped = Math.floor((255 * (absoluteX - relativeX)) / 100);
        ctx.clearRect(0, 0, c.width, c.height);
        if (document.getElementById("visrelalign").checked) {
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.moveTo(absoluteX, 0);
          ctx.lineTo(relativeX, c.height / 6);
          ctx.lineTo(relativeX, 5 * (c.height / 6));
          ctx.lineTo(absoluteX, c.height);
          ctx.strokeStyle =
            diffMapped < 0
              ? `rgb(${-1 * diffMapped} 100 100)`
              : `rgb(100 100 ${diffMapped})`;
          ctx.stroke();
        }
      });
    }
    wavesurfers[filename].on("seek", () => {
      updatePositionIndicator();
    });
    wavesurfers[filename].on("ready", () => {
      // signal file is ready in filename list
      loaded.add(filename);
      console.log("READY:...", filename);
      // create alignment grid and position indicator canvases from waveform canvas
      const waveCanvas = document.querySelector(
        `.waveform[data-ix='${filename}']>wave>canvas`,
      );
      const waveStyle = waveCanvas.style;
      const gridCanvas = document.createElement("canvas");
      const gridStyle = gridCanvas.style;
      const positionIndicatorCanvas = document.createElement("canvas");
      const positionIndicatorStyle = positionIndicatorCanvas.style;
      gridCanvas.classList.add("alignment-grid");
      gridCanvas.width = waveCanvas.width;
      gridCanvas.height = waveCanvas.height;
      const baseZIndex = parseInt(waveStyle.zIndex) || 2;
      gridStyle.zIndex = baseZIndex - 2;
      gridStyle.position = "absolute";
      gridStyle.top = waveStyle.top;
      gridStyle.left = waveStyle.left;
      gridStyle.bottom = waveStyle.bottom;
      gridStyle.right = waveStyle.right;
      gridStyle.width = waveStyle.width;
      gridStyle.height = waveStyle.height;
      gridStyle.pointerEvents = "none";
      gridStyle.display = document.getElementById("visalign").checked
        ? "unset"
        : "none";
      positionIndicatorCanvas.classList.add("position-indicator");
      positionIndicatorCanvas.width = waveCanvas.width;
      positionIndicatorCanvas.height = waveCanvas.height;
      positionIndicatorStyle.zIndex = baseZIndex - 1;
      positionIndicatorStyle.position = "absolute";
      positionIndicatorStyle.top = waveStyle.top;
      positionIndicatorStyle.left = waveStyle.left;
      positionIndicatorStyle.bottom = waveStyle.bottom;
      positionIndicatorStyle.right = waveStyle.right;
      positionIndicatorStyle.width = waveStyle.width;
      positionIndicatorStyle.height = waveStyle.height;
      positionIndicatorStyle.pointerEvents = "none";
      //      positionIndicatorStyle.display = document.getElementById("visalign").checked ? "unset" : "none";
      waveCanvas.parentNode.insertBefore(gridCanvas, waveCanvas);
      waveCanvas.parentNode.insertBefore(positionIndicatorCanvas, waveCanvas);

      // Function to draw (or redraw) the alignment grid
      function drawAlignmentGrid() {
        const currentWaveCanvas = document.querySelector(
          `.waveform[data-ix='${filename}']>wave>canvas`,
        );
        if (!currentWaveCanvas) return;
        // Resize overlay canvases to match current wave canvas
        gridCanvas.width = currentWaveCanvas.width;
        gridCanvas.height = currentWaveCanvas.height;
        gridStyle.width = currentWaveCanvas.style.width;
        gridStyle.height = currentWaveCanvas.style.height;
        positionIndicatorCanvas.width = currentWaveCanvas.width;
        positionIndicatorCanvas.height = currentWaveCanvas.height;
        positionIndicatorStyle.width = currentWaveCanvas.style.width;
        positionIndicatorStyle.height = currentWaveCanvas.style.height;
        // Redraw grid lines
        const ctx = gridCanvas.getContext("2d");
        ctx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#b0b0b055";
        ctx.beginPath();
        const dur = wavesurfers[filename].getDuration();
        alignmentGrids[filename].forEach((gridPos, gridIx) => {
          const absoluteX =
            (gridIx / alignmentGrids[filename].length) * gridCanvas.width;
          const relativeX = (gridPos / dur) * gridCanvas.width;
          ctx.moveTo(absoluteX, 0);
          ctx.lineTo(relativeX, gridCanvas.height / 6);
          ctx.lineTo(relativeX, 5 * (gridCanvas.height / 6));
          ctx.lineTo(absoluteX, gridCanvas.height);
        });
        ctx.stroke();
      }

      // Initial draw
      drawAlignmentGrid();

      // Hide the initial-load overlay
      const readyWfEl = document.querySelector(
        `.waveform[data-ix='${filename}']`,
      );
      if (readyWfEl) hideWaveformOverlay(readyWfEl);

      // Redraw overlays and markers when WaveSurfer redraws on resize
      wavesurfers[filename].on("redraw", () => {
        drawAlignmentGrid();
        // Redraw markers for this specific waveform
        wavesurfers[filename].clearMarkers();
        wavesurfers[filename].addMarker({
          time: 0,
          label: filename,
          color: "black",
          position: "top",
        });
        markers.forEach((m, i) => {
          const t = getCorrespondingTime(filename, m);
          const color =
            closeListeningMode && activeMarkerIx === i ? "#8b0000" : "red";
          wavesurfers[filename].addMarker({ time: t, color });
        });
        // Hide this waveform's resize overlay
        const wfEl = document.querySelector(`.waveform[data-ix='${filename}']`);
        if (wfEl) hideWaveformOverlay(wfEl);
      });
      let listItem = document.getElementById(filename);
      let status = listItem.querySelector("label").classList;
      status.remove("loading");
      status.add("ready");
      listItem.querySelector("input").checked = true;
      // check if we're the currentAudioIx, and if so make ourselves active and spool to provided playPosition
      // (possible when normalize checkbox has forced a reload of waveform elements)
      if (filename === currentAudioIx) {
        document
          .querySelector(`.waveform[data-ix='${filename}']`)
          .classList.add("active");
        wavesurfers[currentAudioIx].play(playPosition);
        if (!isPlaying) {
          wavesurfers[currentAudioIx].pause();
        }
      }
      // restore marks from storage if they exist
      if (storage) {
        markersString = storage.getItem("markers_" + workId);
        if (markersString) {
          markers = JSON.parse(markersString);
          // apply any markers that may have been loaded from local storage
          markers.forEach((m) => {
            const t = getCorrespondingTime(filename, m);
            wavesurfers[filename].addMarker({ time: t, color: "red" });
          });
        }
      }
    });
    wavesurfers[filename].on("marker-click", (e) => {
      console.log("MARKER CLICKED");
      if (e.position === "top") {
        // ignore clicks on filename-label markers
        return;
      }
      // Find the alignment grid index for the clicked marker
      const clickedAudioIx = e.el.closest(".waveform").dataset.ix;
      const clickedGrid = alignmentGrids[clickedAudioIx];
      const alignmentIx = clickedGrid.indexOf(e.time);
      if (alignmentIx > -1) {
        // Find which index in the markers array this corresponds to
        const markerArrayIx = markers.indexOf(alignmentIx);
        if (markerArrayIx > -1) {
          if (closeListeningMode) {
            // Already in close-listening mode: make clicked marker active
            activeMarkerIx = markerArrayIx;
            redrawAllMarkers();
            seekToActiveMarker();
          } else {
            // Enter close-listening mode with the clicked marker as active
            enterCloseListeningMode(markerArrayIx);
          }
        }
      } else {
        console.error("Could not find grid entry for time ", e.time);
      }
    });
    wavesurfers[filename].on("seek", (e) => {
      if (filename !== currentAudioIx) swapCurrentAudio(filename);
    });
    wavesurfers[filename].on("audioprocess", () => {
      // update position indicator during playback
      updatePositionIndicator();
      // continually update timer region when opened but not yet closed
      if (timerFrom === timerTo && timerFrom > 0) {
        wavesurfers[filename].regions.list.timer.end =
          wavesurfers[filename].getCurrentTime();
        updateRenderTimer();
      }
    });

    // render anno regions
    if (currentlyAnnotatedRegions) updateRenderAnnoRegions();
  } else {
    // waveform already loaded...
    let checkbox = document.getElementById(filename).querySelector("input");
    if (!checkbox.checked) {
      // if hidden, unhide by clicking on checkbox
      checkbox.click();
    }
    // now swap to the audio
    swapCurrentAudio(filename);
  }
}

let loadedAlignmentJSON = null; // Full alignment object for download

async function setGrids(grids) {
  console.log("received grids: ", grids);
  loadedAlignmentJSON = grids;
  if ("body" in grids) {
    if ("audio" in grids.body) {
      // final version of alignment json
      alignmentGrids = grids.body.audio;
      if ("header" in grids) {
        if ("meiUri" in grids.header && "score" in grids.body) {
          meiUri = grids.header.meiUri;
          scoreAlignment = grids.body.score;
          console.log("starting MEI fetch: ", meiUri);
          await fetch(meiUri)
            .then((response) => response.text())
            .then((meiXml) => {
              mei = meiXml;
              meiDOM = parser.parseFromString(mei, "application/xml");
              tk.loadData(mei, {});
              timemap = tk.renderToTimemap({ includeMeasures: true });
              console.log("timemap set!", timemap, mei);
            })
            .catch((e) => {
              console.error("Couldn't load MEI: ", e, grids.header.meiUri);
            });
          console.log("MEI fetched: ", meiUri);
        }
        if ("ref" in grids.header) {
          referenceAudioIx = grids.header.ref;
        }
      } else {
        console.error(
          "Broken grids received from alignment json file: ",
          grids,
        );
      }
    } else {
      // pre-final dev version of alignment json
      alignmentGrids = grids.body;
    }
  } else {
    // old version of alignment json
    alignmentGrids = grids;
  }
  console.log("setting grids: ", grids);
  /* separate VPO, external, and other */
  /* for now, hackily use filenames */
  /* in glorious future, use knowledge graph */
  let filenames = Object.keys(alignmentGrids);
  let vpoFiles = filenames.filter((n) =>
    n.substr(n.lastIndexOf("/") + 1).startsWith("VPO-"),
  );
  let extFiles = filenames.filter((n) =>
    n.substr(n.lastIndexOf("/") + 1).startsWith("ext-"),
  );
  vpoFiles = vpoFiles.sort();
  extFiles = extFiles.sort();
  let otherFiles = filenames
    .filter((n) => !vpoFiles.includes(n) && !extFiles.includes(n))
    .sort();
  otherFiles = otherFiles.sort();

  const vpoList = generateCheckboxList(vpoFiles);
  const otherList = generateCheckboxList(otherFiles);
  const extList = generateCheckboxList(extFiles);

  const listSelectors = `<span class='listSelectors'>
    <span class='all'>All</span><span class='none'>None</span>
  </span>`;

  const vpoFoldout = document.createElement("details");
  const vpoSummary = document.createElement("summary");

  vpoSummary.innerText = "VPO";
  vpoFoldout.appendChild(vpoSummary);
  vpoFoldout.innerHTML += listSelectors;
  vpoFoldout.appendChild(vpoList);

  const otherFoldout = document.createElement("details");
  const otherSummary = document.createElement("summary");
  otherSummary.innerText = "Other";
  otherFoldout.appendChild(otherSummary);
  otherFoldout.innerHTML += listSelectors;
  otherFoldout.appendChild(otherList);

  const extFoldout = document.createElement("details");
  const extSummary = document.createElement("summary");

  extSummary.innerText = "External";
  extFoldout.appendChild(extSummary);
  extFoldout.innerHTML += listSelectors;
  extFoldout.appendChild(extList);

  const audiosElement = document.getElementById("audios");

  vpoFoldout.open = true;
  otherFoldout.open = true;
  extFoldout.open = true;

  audiosElement.appendChild(vpoFoldout);
  audiosElement.appendChild(otherFoldout);
  audiosElement.appendChild(extFoldout);

  // list selectors
  Array.from(document.querySelectorAll(".listSelectors .all")).forEach(
    (selector) =>
      selector.addEventListener("click", (e) => {
        let checkboxes = Array.from(
          e.target.closest("details").querySelectorAll("input"),
        );
        checkboxes.forEach((cb) => {
          // we're doing work in clickhandlers, so can't just set checked value
          if (!cb.checked) cb.click();
        });
      }),
  );
  Array.from(document.querySelectorAll(".listSelectors .none")).forEach(
    (selector) =>
      selector.addEventListener("click", (e) => {
        let checkboxes = Array.from(
          e.target.closest("details").querySelectorAll("input"),
        );
        checkboxes.forEach((cb) => {
          // we're doing work in clickhandlers, so can't just unset checked value
          if (cb.checked) cb.click();
        });
      }),
  );

  // rendition selectors
  Array.from(document.getElementsByClassName("renditionName")).forEach(
    (r, ix) => {
      r.addEventListener("click", onClickRenditionName);
    },
  );
  Array.from(document.getElementsByClassName("renditionCheckbox")).forEach(
    (r, ix) => {
      r.addEventListener("click", onClickRenditionCheckbox);
    },
  );

  // If ?useFiles mode is active, show file picker overlay
  showFilePickerIfNeeded();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("back").addEventListener("click", () => {
    solidLogout().then(
      () => (window.location.href = window.location.origin + "/"),
    );
  });
  if (storage.restoreSolidSession) {
    // attempt to restore Solid session with fresh data
    loginAndFetch();
  }
  // draw appropriate solid authorization message
  populateSolidTab();

  // set up Verovio
  verovio.module.onRuntimeInitialized = () => {
    tk = new verovio.toolkit();
    console.log("Have Verovio toolkit:", tk);
  };

  // Download JSON button
  const dlBtn = document.getElementById("download-json-btn");
  if (dlBtn) {
    dlBtn.addEventListener("click", () => {
      if (!loadedAlignmentJSON) return;
      const blob = new Blob([JSON.stringify(loadedAlignmentJSON, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "alignment.json";
      a.click();
      URL.revokeObjectURL(url);
    });
    if (alignmentData === "session") dlBtn.style.display = "";
  }

  // load alignment json
  if (alignmentData === "local") {
    // Local mode: alignment will be provided via file picker
    // Just show the file picker, alignment loading happens there
    showFilePickerIfNeeded();
  } else if (alignmentData === "session" && window._sessionAlignment) {
    // Alignment from in-browser align tool (via sessionStorage)
    setGrids(window._sessionAlignment);
  } else if (alignmentData !== "local") {
    fetch(alignmentData)
      .then((response) => response.json())
      .then((contents) => {
        setGrids(contents);
      })
      .catch((err) => console.warn("Couldn't load alignment data: ", err));
  }

  // load a colormap json file to be passed to the spectrogram.create method.
  WaveSurfer.util
    .fetchFile({ url: root + "js/hot-colormap.json", responseType: "json" })
    .on("success", (cM) => {
      colorMap = cM;
    });
  // play/pause button
  document.getElementById("playpause").addEventListener("click", function (e) {
    playpause();
  });
  // mark button
  document.getElementById("mark").addEventListener("click", function (e) {
    let toMark = getClosestAlignmentIx();
    markers.push(toMark);
    // update markers in storage, if possible
    if (storage) {
      storage.setItem("markers_" + workId, JSON.stringify(markers));
    }
    Object.keys(wavesurfers).forEach((ws) => {
      const t = getCorrespondingTime(ws, toMark);
      console.log("got corresponding time: ", t);
      wavesurfers[ws].addMarker({ time: t, color: "red" });
    });
  });
  // play from last marker button
  document.getElementById("playLastMark").addEventListener("click", () => {
    seekToLastMark();
    wavesurfers[currentAudioIx].play();
  });

  // show spectrograms checkbox
  document.getElementById("showSpectrograms").checked = false;
  document.getElementById("showSpectrograms").addEventListener("click", (e) => {
    let waveforms = document.getElementById("waveforms");
    if (e.target.checked) {
      waveforms.classList.add("showSpectrograms");
    } else {
      waveforms.classList.remove("showSpectrograms");
    }
  });

  // normalize audio checkbox
  document.getElementById("normalize").checked = false;
  document.getElementById("normalize").addEventListener("click", (e) => {
    reloadWaveforms();
  });
  // visualize alignment checkbox
  document.getElementById("visalign").checked = false;
  document.getElementById("visalign").addEventListener("click", (e) => {
    let display = e.target.checked ? "unset" : "none";
    Array.from(document.querySelectorAll(".alignment-grid")).forEach(
      (e) => (e.style.display = display),
    );
  });

  document.querySelector("body").addEventListener("keydown", (e) => {
    // Don't intercept when typing in an input/textarea
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    console.log("KEYDOWN: ", e);
    if (!currentAudioIx) return;

    // --- Helper: get ordered list of visible (checked) waveform filenames ---
    function getVisibleWaveforms() {
      return Array.from(document.querySelectorAll("#waveforms .waveform"))
        .map((el) => el.dataset.ix)
        .filter((name) => name in wavesurfers);
    }

    let handled = true;
    let updateTimer = false;

    switch (e.code) {
      case "ArrowUp": {
        // Switch to previous waveform (works in both modes)
        const visible = getVisibleWaveforms();
        const idx = visible.indexOf(currentAudioIx);
        if (idx > 0) swapCurrentAudio(visible[idx - 1]);
        break;
      }
      case "ArrowDown": {
        // Switch to next waveform (works in both modes)
        const visible = getVisibleWaveforms();
        const idx = visible.indexOf(currentAudioIx);
        if (idx < visible.length - 1) swapCurrentAudio(visible[idx + 1]);
        break;
      }
      case "ArrowLeft": {
        if (closeListeningMode && activeMarkerIx != null) {
          if (e.shiftKey) {
            // Nudge active marker left by constant time: Shift+Alt = 20ms, Shift = 100ms
            const delta = e.altKey ? smallMarkerNudge : bigMarkerNudge;
            const currentTime = getCorrespondingTime(
              currentAudioIx,
              markers[activeMarkerIx],
            );
            const targetTime = currentTime - delta;
            if (targetTime >= 0) {
              const newIx = getClosestAlignmentIx(targetTime, currentAudioIx);
              // Only update if actually different from current position
              if (newIx !== markers[activeMarkerIx]) {
                markers[activeMarkerIx] = newIx;
                if (storage)
                  storage.setItem("markers_" + workId, JSON.stringify(markers));
                redrawAllMarkers();
                seekToActiveMarker();
              }
            }
          } else {
            // If past active marker, seek back to it; else go to previous
            const currentTime = wavesurfers[currentAudioIx].getCurrentTime();
            const activeTime = getCorrespondingTime(
              currentAudioIx,
              markers[activeMarkerIx],
            );
            if (currentTime > activeTime + 0.05) {
              seekToActiveMarker();
            } else {
              const sorted = getSortedMarkerIndices();
              const pos = sorted.indexOf(activeMarkerIx);
              if (pos > 0) {
                activeMarkerIx = sorted[pos - 1];
                redrawAllMarkers();
                seekToActiveMarker();
              }
            }
          }
        }
        break;
      }
      case "ArrowRight": {
        if (closeListeningMode && activeMarkerIx != null) {
          if (e.shiftKey) {
            // Nudge active marker right by constant time: Shift+Alt = 20ms, Shift = 100ms
            const delta = e.altKey ? smallMarkerNudge : bigMarkerNudge;
            const currentTime = getCorrespondingTime(
              currentAudioIx,
              markers[activeMarkerIx],
            );
            const gridLength = alignmentGrids[currentAudioIx].length;
            const targetTime = currentTime + delta;
            const newIx = getClosestAlignmentIx(targetTime, currentAudioIx);
            // Only update if actually different and in bounds
            if (newIx !== markers[activeMarkerIx] && newIx < gridLength) {
              markers[activeMarkerIx] = newIx;
              if (storage)
                storage.setItem("markers_" + workId, JSON.stringify(markers));
              redrawAllMarkers();
              seekToActiveMarker();
            }
          } else {
            // Navigate to next marker
            const sorted = getSortedMarkerIndices();
            const pos = sorted.indexOf(activeMarkerIx);
            if (pos < sorted.length - 1) {
              activeMarkerIx = sorted[pos + 1];
              redrawAllMarkers();
              seekToActiveMarker();
            }
          }
        }
        break;
      }
      case "Digit1":
      case "Digit2":
      case "Digit3":
      case "Digit4":
      case "Digit5":
      case "Digit6":
      case "Digit7":
      case "Digit8":
      case "Digit9":
      case "Digit0":
      case "Numpad1":
      case "Numpad2":
      case "Numpad3":
      case "Numpad4":
      case "Numpad5":
      case "Numpad6":
      case "Numpad7":
      case "Numpad8":
      case "Numpad9":
      case "Numpad0": {
        // Jump to nth waveform (1-9 = 1st-9th, 0 = 10th)
        const visible = getVisibleWaveforms();
        const digit = e.code.replace(/^(Digit|Numpad)/, "");
        const n = digit === "0" ? 9 : parseInt(digit) - 1;
        if (n < visible.length) {
          swapCurrentAudio(visible[n]);
          if (!wavesurfers[currentAudioIx].isPlaying()) {
            wavesurfers[currentAudioIx].play();
          }
        }
        break;
      }
      case "KeyM": {
        // Add marker at current playback position
        const toMark = getClosestAlignmentIx();
        markers.push(toMark);
        if (storage) {
          storage.setItem("markers_" + workId, JSON.stringify(markers));
        }
        if (closeListeningMode) {
          // Make the newly added marker active
          activeMarkerIx = markers.length - 1;
          redrawAllMarkers();
          seekToActiveMarker();
        } else {
          Object.keys(wavesurfers).forEach((ws) => {
            const t = getCorrespondingTime(ws, toMark);
            wavesurfers[ws].addMarker({ time: t, color: "red" });
          });
        }
        break;
      }
      case "Delete":
      case "Backspace": {
        // Delete active marker (close-listening mode only)
        if (closeListeningMode && activeMarkerIx != null) {
          const deletedAlignIx = markers[activeMarkerIx];
          markers.splice(activeMarkerIx, 1);
          if (storage) {
            storage.setItem("markers_" + workId, JSON.stringify(markers));
          }
          if (markers.length === 0) {
            exitCloseListeningMode();
          } else {
            // Select the marker closest in time to the deleted one,
            // preferring the one just before it
            let bestIx = 0;
            let bestDist = Infinity;
            for (let i = 0; i < markers.length; i++) {
              const dist = markers[i] - deletedAlignIx;
              const absDist = Math.abs(dist);
              if (absDist < bestDist || (absDist === bestDist && dist < 0)) {
                bestDist = absDist;
                bestIx = i;
              }
            }
            activeMarkerIx = bestIx;
            redrawAllMarkers();
            seekToActiveMarker();
          }
        }
        break;
      }
      case "KeyC": {
        // Toggle close-listening mode
        if (closeListeningMode) {
          exitCloseListeningMode();
        } else if (markers.length > 0) {
          // Enter with closest marker to current playback position
          const closestIdx = findClosestMarkerIndex();
          enterCloseListeningMode(closestIdx);
        }
        break;
      }
      case "Escape": {
        if (closeListeningMode) {
          exitCloseListeningMode();
        }
        break;
      }
      case "KeyT":
        // HACK FOR DH 2023 temporarily disable in this branch
        return false;
        if (timerFrom > 0 && timerFrom === timerTo) {
          timerTo = wavesurfers[currentAudioIx].getCurrentTime();
        } else {
          timerFrom = wavesurfers[currentAudioIx].getCurrentTime();
          timerTo = timerFrom;
        }
        updateTimer = true;
        break;
      case "KeyX":
        // release timer
        timerFrom = 0;
        timerTo = 0;
        updateTimer = true;
        break;
      case "Space":
        playpause();
        break;
      default:
        handled = false;
    }

    if (handled) e.preventDefault();

    if (updateTimer) {
      Object.keys(wavesurfers).forEach((ws) => {
        const wsFrom = getCorrespondingTime(
          ws,
          getClosestAlignmentIx(timerFrom),
        );
        const wsTo = getCorrespondingTime(ws, getClosestAlignmentIx(timerTo));
        wavesurfers[ws].regions.list.timer.start = wsFrom;
        wavesurfers[ws].regions.list.timer.end = wsTo;
      });
      updateRenderTimer();
    }
  });
});

export function markScoreRegion(ids, selectionUrl, reset = false) {
  if (reset) {
    currentlyAnnotatedRegions = [];
  }
  console.log("Marking score region for ids: ", ids);
  // iterate over ids, attempting to find the first and last note that the tk can getTimesForElements on
  if (scoreAlignment && tk && referenceAudioIx) {
    let fromId, toId;
    let fromTimes, toTimes;
    for (let id of ids) {
      console.log("MEI DOM: ", meiDOM);
      console.log("Looking for id: ", id);
      let el = meiDOM.querySelector("[*|id='" + id + "']");
      if (!el) {
        console.warn("Couldn't find element with id: ", id);
        continue;
      }
      if (el.tagName !== "note") {
        // get the first note in the closest measure
        let measure = el.closest("measure");
        if (measure) {
          let firstNote = measure.querySelector("note");
          if (firstNote) {
            id = firstNote.getAttribute("xml:id");
            console.log("Using first note in measure: ", id);
          } else {
            console.warn("Measure has no notes, skipping: ", id);
            continue;
          }
        } else {
          console.warn("Element is not within a measure, skipping: ", id);
          continue;
        }
      }
      console.log("Determined from ID to be: ", id);
      fromTimes = tk.getTimesForElement(id);
      if (Object.keys(fromTimes).length) {
        fromId = id;
        break;
      }
    }
    for (let id of ids.reverse()) {
      let el = meiDOM.querySelector("[*|id='" + id + "']");
      if (!el) {
        console.warn("Couldn't find element with id: ", id);
        continue;
      }
      if (el.tagName !== "note") {
        // get the last note in the closest measure
        let measure = el.closest("measure");
        if (measure) {
          let lastNote = measure.querySelector("note:last-of-type");
          if (lastNote) {
            id = lastNote.getAttribute("xml:id");
            console.log("Using last note in measure: ", id);
          } else {
            console.warn("Measure has no notes, skipping: ", id);
            continue;
          }
        } else {
          console.warn("Element is not within a measure, skipping: ", id);
          continue;
        }
      }
      console.log("Determined to ID to be: ", id);
      toTimes = tk.getTimesForElement(id);
      if (Object.keys(toTimes).length) {
        toId = id;
        break;
      }
    }
    if (fromTimes) {
      let onsets = fromTimes.tstampOn;
      // if no toId specified, mark region from onset to offset of fromId; otherwise, mark from onset of fromId to offset of toId
      let offsets = toTimes ? toTimes.tstampOff : fromTimes.tstampOff;
      // getTimesForElements returns onset and offset times for identified elements (plus other stuff)
      // The returned values are arrays, to handle expansions. So we have to handle the arrays.
      // Return regions in the reference audio corresponding to these onsets and offsets
      console.log(
        "fromId: ",
        fromId,
        "toId: ",
        toId,
        "fromTimes",
        fromTimes,
        "toTimes",
        toTimes,
        "onsets: ",
        onsets,
        "offsets: ",
        offsets,
      );
      let refRegions = onsets.map((t, expansionIx) => {
        console.log("In loop: ", t, expansionIx);
        return {
          from: scoreAlignment.ref_onset[
            getClosestScoreTimeIx(t, scoreAlignment.score_onset)
          ],
          to: scoreAlignment.ref_offset[
            getClosestScoreTimeIx(
              offsets[expansionIx],
              scoreAlignment.score_offset,
            )
          ],
        };
      });
      // convert to alignment ix
      currentlyAnnotatedRegions.push({
        selection: selectionUrl.href,
        from: getClosestAlignmentIx(refRegions[0].from, referenceAudioIx),
        to: getClosestAlignmentIx(refRegions[0].to, referenceAudioIx),
      });
      updateRenderAnnoRegions();
      /* HACK DH 2023, in future handle multiple regions, for now only use the first
      /*refRegions.map(r => { 
        return {
          from: getClosestAlignmentIx(r.from, referenceAudioIx), 
          to: getClosestAlignmentIx(r.to, referenceAudioIx)
        }
      });*/
    } else {
      console.warn(
        "Verovio couldn't find onset / offset times for any of the selection IDs. Were any notes selected?",
      );
    }
  } else {
    console.warn("Current alignment JSON does not support score alignment");
  }
}

function getClosestScoreTimeIx(tInMilliSec, times) {
  let t = tInMilliSec / 1000;
  let closest = times.reduce(function (prev, curr) {
    return Math.abs(curr - t) < Math.abs(prev - t) ? curr : prev;
  });
  return times.indexOf(closest);
}

function playpause() {
  if (currentAudioIx) {
    if (wavesurfers[currentAudioIx].isPlaying())
      wavesurfers[currentAudioIx].pause();
    else wavesurfers[currentAudioIx].play();
  } else {
    // if there is at least one waveform loaded, make it active and play it
    let firstWs = document.querySelector(".waveform");
    if (firstWs) {
      swapCurrentAudio(firstWs.dataset.ix);
      wavesurfers[currentAudioIx].play();
    }
  }
}

function updateRenderTimer() {
  Object.keys(wavesurfers).forEach((ws) => {
    let timer = wavesurfers[ws].regions.list.timer;
    console.log(timer.start, timer.end);
    timer.updateRender();
    let timeDelta = timer.end - timer.start;
    document.querySelector(
      '.waveform[data-ix="' + ws + '"] region[data-id="timer"]',
    ).innerHTML = timeDelta
      ? `<div class='timerValueContainer'><span>${timeDelta.toFixed(
          3,
        )}</span></div>`
      : ""; // don't display 0
  });
}

// todo refactor with updateRenderTimer above
function updateRenderAnnoRegions() {
  // HACK dlfm2023: for now do nothing, ensure annots are loaded before wavesurfers
  Object.keys(wavesurfers).forEach((ws) => {
    console.log("Update render anno regions: ", ws, currentlyAnnotatedRegions);
    let regions = extractCurrentlyAnnotatedRegions(ws);
    wavesurfers[ws].clearRegions();
    regions.forEach((r) => wavesurfers[ws].addRegion(r));

    /*
      let timeDelta = region.end - region.start;
      document.querySelector('.waveform[data-ix="' + ws + '"] region[data-id="anno_region_0"]')
        .innerHTML = timeDelta 
          ? `<div class='regiontimerValueContainer'><span>${timeDelta.toFixed(3)}</span></div>` 
          : ""; // don't display 0 */
  });
}

function extractCurrentlyAnnotatedRegions(ws) {
  return currentlyAnnotatedRegions.map((r, ix) => {
    return {
      id: "anno_region_" + ix,
      start: getCorrespondingTime(ws, r.from),
      end: getCorrespondingTime(ws, r.to),
      drag: false,
      resize: false,
      color: "rgba(200, 130, 80, 0.3)",
    };
  });
}

// --- File picker logic for ?useFiles mode ---

// Expected audio keys from the alignment JSON (set during setGrids)
let expectedAudioKeys = [];
let alignmentLoadedFromFile = false; // true when JSON was loaded via file picker

function extractFilename(key) {
  // Extract just the filename from an alignment key (which may be a path or URL)
  return key.split("/").pop();
}

function processPickedJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        resolve(data);
      } catch (e) {
        reject(new Error("Invalid JSON: " + e.message));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function initFilePicker() {
  const overlay = document.getElementById("file-picker-overlay");
  const listEl = document.getElementById("file-picker-list");
  const progressEl = document.getElementById("file-picker-progress");
  const continueBtn = document.getElementById("file-picker-continue");
  const dirBtn = document.getElementById("file-picker-dir-btn");
  const filesBtn = document.getElementById("file-picker-files-btn");
  const fileInput = document.getElementById("file-picker-input");
  const dropZone = document.getElementById("file-picker-card");
  const jsonStatusEl = document.getElementById("file-picker-json-status");

  // Show directory picker button on browsers that support it (Chromium)
  if (typeof window.showDirectoryPicker === "function") {
    dirBtn.style.display = "";
  }

  function updateJsonStatus() {
    if (!jsonStatusEl) return;
    if (expectedAudioKeys.length > 0) {
      const name = alignmentLoadedFromFile ? "local file" : "URL";
      jsonStatusEl.innerHTML = `<span class="json-status-ok">&#10003; Alignment JSON loaded (${expectedAudioKeys.length} audio entries, from ${name})</span>`;
    } else {
      jsonStatusEl.innerHTML = `<span class="json-status-missing">No alignment JSON loaded yet \u2014 include a .json file</span>`;
    }
  }

  // Populate expected file list
  function renderFileList() {
    listEl.innerHTML = "";
    if (expectedAudioKeys.length === 0) {
      progressEl.textContent = "";
      continueBtn.style.display = "none";
      updateJsonStatus();
      return;
    }
    let matched = 0;
    expectedAudioKeys.forEach((key) => {
      const name = extractFilename(key);
      const li = document.createElement("li");
      const isMatched = fileBlobUrls.has(key);
      li.className = isMatched ? "matched" : "missing";
      li.innerHTML = `<span class="status-icon"></span><span class="filename">${name}</span>`;
      listEl.appendChild(li);
      if (isMatched) matched++;
    });
    progressEl.textContent = `${matched} of ${expectedAudioKeys.length} files matched`;
    if (matched > 0) {
      continueBtn.style.display = "";
      continueBtn.textContent =
        matched === expectedAudioKeys.length
          ? "Continue"
          : `Continue with ${matched} of ${expectedAudioKeys.length}`;
    } else {
      continueBtn.style.display = "none";
    }
    updateJsonStatus();
  }

  async function handleFiles(files) {
    // Separate JSON from audio files
    const jsonFiles = [];
    const audioFiles = [];
    for (const f of files) {
      if (f.name.toLowerCase().endsWith(".json")) {
        jsonFiles.push(f);
      } else {
        audioFiles.push(f);
      }
    }
    // Process the first JSON file found (if any)
    if (jsonFiles.length > 0) {
      try {
        const data = await processPickedJsonFile(jsonFiles[0]);
        // Validate basic structure
        if (data.body && data.body.audio && data.header && data.header.ref) {
          alignmentLoadedFromFile = true;
          // Clear old blob URLs and audio keys
          fileBlobUrls.clear();
          expectedAudioKeys = Object.keys(data.body.audio);
          // Store the alignment data for use when continue is clicked
          window._pendingLocalAlignment = data;
          // Set workId from the JSON filename
          workId = jsonFiles[0].name;
          renderFileList();
        } else {
          alert(
            "The JSON file does not appear to be a valid alignment file.\nExpected: {header: {ref: ...}, body: {audio: {...}}}",
          );
        }
      } catch (e) {
        alert("Error reading JSON file: " + e.message);
      }
    }
    // Match audio files
    matchFiles(audioFiles);
  }

  function matchFiles(files) {
    // Build a map of lowercase filename -> File for quick lookup
    const filesByName = new Map();
    for (const f of files) {
      filesByName.set(f.name.toLowerCase(), f);
    }
    // Match against expected audio keys
    for (const key of expectedAudioKeys) {
      if (fileBlobUrls.has(key)) continue; // already matched
      const expectedName = extractFilename(key).toLowerCase();
      if (filesByName.has(expectedName)) {
        const file = filesByName.get(expectedName);
        fileBlobUrls.set(key, URL.createObjectURL(file));
      }
    }
    renderFileList();
  }

  // Directory picker (Chromium only)
  dirBtn.addEventListener("click", async () => {
    try {
      const dirHandle = await window.showDirectoryPicker();
      const files = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === "file") {
          files.push(await entry.getFile());
        }
      }
      handleFiles(files);
    } catch (e) {
      if (e.name !== "AbortError") console.warn("Directory picker error:", e);
    }
  });

  // File input (universal fallback)
  filesBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) {
      handleFiles(Array.from(fileInput.files));
    }
  });

  // Drag and drop
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });

  // Continue button
  continueBtn.addEventListener("click", () => {
    overlay.style.display = "none";
    // If alignment was loaded from a local JSON file, apply it now
    if (window._pendingLocalAlignment) {
      const data = window._pendingLocalAlignment;
      window._pendingLocalAlignment = null;
      setGrids(data);
    }
  });

  renderFileList();
  overlay.style.display = "flex";
}

function showFilePickerIfNeeded() {
  if (params.get("useFiles") !== null || alignmentData === "local") {
    useFilesMode = true;
    // If we already have alignment grids (from URL), populate expected keys
    if (
      Object.keys(alignmentGrids).length > 0 &&
      expectedAudioKeys.length === 0
    ) {
      expectedAudioKeys = Object.keys(alignmentGrids);
    }
    // Show the "Manage files" button and wire it to reopen the overlay
    const manageBtn = document.getElementById("manage-files-btn");
    if (manageBtn && manageBtn.style.display === "none") {
      manageBtn.style.display = "";
      manageBtn.addEventListener("click", () => {
        document.getElementById("file-picker-overlay").style.display = "flex";
      });
    }
    // Show download button (useful once alignment is loaded from file)
    const dlBtn = document.getElementById("download-json-btn");
    if (dlBtn && alignmentData === "local") dlBtn.style.display = "";
    if (!showFilePickerIfNeeded._initialized) {
      showFilePickerIfNeeded._initialized = true;
      initFilePicker();
    }
  }
}

// --- Global drag-and-drop for JSON replacement ---
// When the file picker overlay is NOT showing, allow dropping a JSON file
// anywhere on the page to replace the current alignment.
function initGlobalJsonDrop() {
  let dragCounter = 0;
  const dropOverlay = document.getElementById("json-drop-overlay");
  if (!dropOverlay) return;

  document.addEventListener("dragenter", (e) => {
    // Don't show global overlay if file picker is visible
    if (document.getElementById("file-picker-overlay").style.display === "flex")
      return;
    dragCounter++;
    if (dragCounter === 1) {
      dropOverlay.style.display = "flex";
    }
  });

  document.addEventListener("dragleave", (e) => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.style.display = "none";
    }
  });

  document.addEventListener("dragover", (e) => {
    // Only if file picker overlay is not showing
    if (
      document.getElementById("file-picker-overlay").style.display !== "flex"
    ) {
      e.preventDefault();
    }
  });

  document.addEventListener("drop", (e) => {
    dragCounter = 0;
    dropOverlay.style.display = "none";
    // Don't handle if file picker overlay is showing (it has its own handler)
    if (document.getElementById("file-picker-overlay").style.display === "flex")
      return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const jsonFile = files.find((f) => f.name.toLowerCase().endsWith(".json"));
    if (!jsonFile) return;
    processPickedJsonFile(jsonFile)
      .then((data) => {
        if (data.body && data.body.audio && data.header && data.header.ref) {
          // Destroy existing waveforms
          wavesurfers.forEach((ws) => ws.destroy());
          wavesurfers = [];
          // Clear containers
          document.querySelectorAll(".wfContainer").forEach((c) => c.remove());
          // Reset state
          alignmentGrids = {};
          fileBlobUrls.clear();
          markers = {};
          loadedAlignmentJSON = data;
          workId = jsonFile.name;
          // Enable local mode
          useFilesMode = true;
          alignmentLoadedFromFile = true;
          // Apply new alignment
          setGrids(data);
        } else {
          alert(
            "The dropped JSON file does not appear to be a valid alignment file.",
          );
        }
      })
      .catch((err) => {
        alert("Error reading dropped JSON: " + err.message);
      });
  });
}

// Initialize global JSON drop handler
initGlobalJsonDrop();
