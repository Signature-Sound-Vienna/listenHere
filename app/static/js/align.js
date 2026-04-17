// ---------------------------------------------------------------------------
// align.js — In-browser DTW alignment module (ES module)
//
// Extracted from the former standalone align.html inline script.
// Now imported by listen.js so alignment and listening share a single page
// load.  Audio File objects stay in memory — no reload after alignment.
// ---------------------------------------------------------------------------

const TARGET_SR = 22050;

let selectedFiles = []; // Array of File objects
let alignmentResult = null;
let currentTab = 1; // Active wizard tab: 1=Files, 2=Quality, 3=URIs, 4=Align
let alignmentRunning = false; // true while worker is active

// ---------------------------------------------------------------------------
// Alignment quality presets and parameter defaults
// ---------------------------------------------------------------------------

const PRESETS = {
  fast: {
    coarse: 4,
    slack: 80,
    featureRate: 10,
    scoreDownsample: 2,
    onsetWeight: 2.0,
  },
  balanced: {
    coarse: 2,
    slack: 120,
    featureRate: 10,
    scoreDownsample: 1,
    onsetWeight: 2.0,
  },
  hq: {
    coarse: 2,
    slack: 160,
    featureRate: 20,
    scoreDownsample: 1,
    onsetWeight: 2.0,
  },
};

const STORAGE_KEY = "listenHere_alignQuality";

/** Load saved quality settings from localStorage, or return balanced defaults. */
function loadQualitySettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {
    /* ignore */
  }
  return { preset: "balanced", params: { ...PRESETS.balanced } };
}

/** Persist current quality settings to localStorage. */
function saveQualitySettings(preset, params) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset, params }));
  } catch (_) {
    /* ignore */
  }
}

/** Get the current alignment parameters from the Advanced UI controls. */
function readAdvancedParams() {
  return {
    coarse: parseInt(document.getElementById("align-param-coarse").value),
    slack: parseInt(document.getElementById("align-param-slack").value),
    featureRate: parseInt(
      document.getElementById("align-param-feature-rate").value,
    ),
    scoreDownsample: parseInt(
      document.getElementById("align-param-score-ds").value,
    ),
    onsetWeight: parseFloat(
      document.getElementById("align-param-onset-weight").value,
    ),
  };
}

/** Write parameter values into the Advanced UI controls. */
function writeAdvancedParams(p) {
  document.getElementById("align-param-coarse").value = p.coarse;
  document.getElementById("align-param-slack").value = p.slack;
  document.getElementById("align-param-feature-rate").value = p.featureRate;
  document.getElementById("align-param-score-ds").value = p.scoreDownsample;
  document.getElementById("align-param-onset-weight").value = p.onsetWeight;
}

/** Check if current advanced params match any preset. */
function detectPreset(params) {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (
      p.coarse === params.coarse &&
      p.slack === params.slack &&
      p.featureRate === params.featureRate &&
      p.scoreDownsample === params.scoreDownsample &&
      p.onsetWeight === params.onsetWeight
    )
      return name;
  }
  return null;
}

/** Select a preset radio and sync advanced params. */
function selectPreset(name) {
  const radio = document.querySelector(
    `input[name="align-quality"][value="${name}"]`,
  );
  if (radio) radio.checked = true;
  writeAdvancedParams(PRESETS[name]);
  saveQualitySettings(name, { ...PRESETS[name] });
}

/** Called when an advanced param changes — detect or clear preset. */
function onAdvancedParamChange() {
  const params = readAdvancedParams();
  const match = detectPreset(params);
  if (match) {
    const radio = document.querySelector(
      `input[name="align-quality"][value="${match}"]`,
    );
    if (radio) radio.checked = true;
  } else {
    // Uncheck all preset radios
    document
      .querySelectorAll('input[name="align-quality"]')
      .forEach((r) => (r.checked = false));
  }
  saveQualitySettings(match || "custom", params);
}

/** Update score param enabled/disabled state based on MEI input. */
function updateScoreParamState() {
  const hasMei = !!document.getElementById("align-mei-input").value.trim();
  document.querySelectorAll(".align-score-param").forEach((row) => {
    if (hasMei) {
      row.classList.remove("disabled");
      const tip = row.querySelector(".align-score-param-tooltip");
      if (tip) tip.remove();
    } else {
      row.classList.add("disabled");
      if (!row.querySelector(".align-score-param-tooltip")) {
        const tip = document.createElement("span");
        tip.className = "align-score-param-tooltip";
        tip.textContent = "Available when an MEI score is provided";
        row.appendChild(tip);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Verovio helpers (reuse the toolkit that listen.js already initialises)
// ---------------------------------------------------------------------------

/** Promise that resolves to a verovio.toolkit instance. */
let _verovioPromise = null;

/**
 * Called by listen.js once DOMContentLoaded fires, passing a Promise that
 * resolves to the shared verovio toolkit.
 */
export function setVerovioPromise(p) {
  _verovioPromise = p;
}

async function fetchMeiMidi(meiUri) {
  if (!_verovioPromise) throw new Error("Verovio not initialised");
  const tk = await _verovioPromise;
  const resp = await fetch(meiUri);
  if (!resp.ok) throw new Error(`Could not fetch MEI (HTTP ${resp.status})`);
  const meiText = await resp.text();
  const loaded = tk.loadData(meiText);
  if (!loaded) throw new Error("Verovio could not parse the MEI data");
  const midiBase64 = tk.renderToMIDI();
  if (!midiBase64 || midiBase64.length === 0)
    throw new Error("Verovio produced empty MIDI output");
  const binary = atob(midiBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Audio decoding (mono @ 22050 Hz for chroma features)
// ---------------------------------------------------------------------------

async function decodeAudio(file) {
  const arrayBuf = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  const decoded = await audioCtx.decodeAudioData(arrayBuf);
  await audioCtx.close();
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * TARGET_SR),
    TARGET_SR,
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const resampled = await offlineCtx.startRendering();
  return resampled.getChannelData(0);
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

/** Get playback duration (seconds) from file metadata without full decode. */
function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => {
      const dur = audio.duration;
      audio.src = "";
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(dur) ? dur : 0);
    });
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      resolve(0);
    });
    audio.src = url;
  });
}

async function addFiles(files) {
  const audioExts = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus)$/i;
  const newFiles = [];
  for (const f of files) {
    if (audioExts.test(f.name) || f.type.startsWith("audio/")) {
      if (!selectedFiles.some((s) => s.name === f.name)) {
        selectedFiles.push(f);
        newFiles.push(f);
      }
    }
  }
  // Probe durations for newly added files (parallel, metadata only)
  await Promise.all(
    newFiles.map(async (f) => {
      if (f._duration == null) f._duration = await probeDuration(f);
    }),
  );
  renderFileTable();
}

function renderFileTable() {
  const container = document.getElementById("align-file-list-container");
  const tbody = document.querySelector("#align-file-table tbody");
  tbody.innerHTML = "";
  if (selectedFiles.length === 0) {
    container.style.display = "none";
    return;
  }
  container.style.display = "";
  // Default reference = longest file by duration
  let longestIdx = 0;
  let longestDur = 0;
  selectedFiles.forEach((f, i) => {
    if ((f._duration || 0) > longestDur) {
      longestDur = f._duration;
      longestIdx = i;
    }
  });
  selectedFiles.forEach((f, i) => {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = f.name;
    const tdDur = document.createElement("td");
    tdDur.style.textAlign = "right";
    tdDur.style.color = "#94a3b8";
    tdDur.style.fontVariantNumeric = "tabular-nums";
    if (f._duration) {
      const m = Math.floor(f._duration / 60);
      const s = Math.round(f._duration % 60);
      tdDur.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    const tdRef = document.createElement("td");
    tdRef.style.textAlign = "center";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "ref";
    radio.value = f.name;
    if (i === longestIdx) radio.checked = true;
    tdRef.appendChild(radio);
    tr.appendChild(tdName);
    tr.appendChild(tdDur);
    tr.appendChild(tdRef);
    tbody.appendChild(tr);
  });
  updatePeakSizeEstimate();
}

function updatePeakSizeEstimate() {
  const checkbox = document.getElementById("align-peaks-checkbox");
  const countInput = document.getElementById("align-peaks-count");
  const estimateEl = document.getElementById("align-peaks-size-estimate");
  if (!checkbox || !checkbox.checked) return;
  const n = Math.max(128, parseInt(countInput.value) || 4096);
  const sizeBytes = n * Math.max(selectedFiles.length, 1) * 9;
  const sizeStr =
    sizeBytes < 1024 * 1024
      ? `${Math.round(sizeBytes / 1024)} KB`
      : `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  estimateEl.textContent = `≈ ${sizeStr} added to JSON`;
}

// ---------------------------------------------------------------------------
// Alignment orchestration
// ---------------------------------------------------------------------------

/**
 * Called by the listen.js integration to supply the onComplete callback.
 * @param {Object} opts
 * @param {string}   opts.workerUrl  — URL to align-worker.js
 * @param {Function} opts.onComplete — called with (alignmentResult, selectedFiles)
 */
let _workerUrl = "";
let _onComplete = null;

export function configure({ workerUrl, onComplete }) {
  _workerUrl = workerUrl;
  _onComplete = onComplete;
}

async function startAlignment() {
  if (selectedFiles.length < 2) {
    alert("Please select at least 2 audio files.");
    return;
  }
  const refName = document.querySelector('input[name="ref"]:checked').value;
  const peaksChecked = document.getElementById("align-peaks-checkbox").checked;
  const peakCount = peaksChecked
    ? Math.max(
        128,
        parseInt(document.getElementById("align-peaks-count").value) || 4096,
      )
    : 0;

  sessionStorage.removeItem("alignSavedBeforeListen");

  // Show progress, hide controls
  alignmentRunning = true;
  document.getElementById("align-steps").classList.add("disabled");
  document.getElementById("align-start-btn").style.display = "none";
  document.getElementById("align-summary").style.display = "none";
  document.getElementById("align-wizard-nav").style.display = "none";
  const progressEl = document.getElementById("align-progress");
  const progressBar = document.getElementById("align-progress-bar");
  const progressText = document.getElementById("align-progress-text");
  const stepList = document.getElementById("align-step-list");
  const elapsedEl = document.getElementById("align-progress-elapsed");
  progressEl.style.display = "";
  stepList.innerHTML = "";

  const alignStartTime = performance.now();
  const elapsedTimer = setInterval(() => {
    const secs = ((performance.now() - alignStartTime) / 1000).toFixed(0);
    elapsedEl.textContent = `Elapsed: ${secs}s`;
  }, 1000);
  elapsedEl.textContent = "Elapsed: 0s";

  function addStep(label) {
    const li = document.createElement("li");
    li.className = "align-step running";
    li.innerHTML = `<span class="step-icon">&#9676;</span> ${label}`;
    li.dataset.startTime = performance.now();
    stepList.appendChild(li);
    li.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return li;
  }

  function completeStep(li, elapsed) {
    if (!li) return;
    li.classList.remove("running");
    li.classList.add("done");
    const icon = li.querySelector(".step-icon");
    if (icon) icon.innerHTML = "&#10003;";
    const timeStr =
      elapsed != null
        ? elapsed.toFixed(1)
        : (
            (performance.now() - parseFloat(li.dataset.startTime)) /
            1000
          ).toFixed(1);
    li.innerHTML += `<span class="step-time">${timeStr}s</span>`;
  }

  // Decode audio sequentially (limits peak memory)
  const audios = [];
  for (let i = 0; i < selectedFiles.length; i++) {
    const f = selectedFiles[i];
    progressText.textContent = `Decoding audio: ${f.name} (${i + 1}/${selectedFiles.length})`;
    progressBar.style.width = `${5 + (5 * i) / selectedFiles.length}%`;
    const li = addStep(`Decode: ${f.name}`);
    try {
      const samples = await decodeAudio(f);
      audios.push({ name: f.name, samples });
      completeStep(li);
    } catch (err) {
      progressText.textContent = `Error decoding ${f.name}: ${err.message}`;
      clearInterval(elapsedTimer);
      return;
    }
  }
  progressText.textContent = "Starting alignment worker...";
  progressBar.style.width = "10%";

  // Optionally fetch MEI and render to MIDI
  let meiMidi = null;
  const meiUri = document.getElementById("align-mei-input").value.trim();
  if (meiUri) {
    progressText.textContent = "Loading MEI and rendering to MIDI…";
    const meiLi = addStep("Render MEI → MIDI");
    try {
      meiMidi = await fetchMeiMidi(meiUri);
      completeStep(meiLi);
    } catch (err) {
      progressText.textContent = `MEI error: ${err.message}`;
      clearInterval(elapsedTimer);
      return;
    }
  }

  // Launch Web Worker
  const currentOptions = readAdvancedParams();
  const worker = new Worker(_workerUrl);
  const activeSteps = {};

  worker.onmessage = function (e) {
    if (e.data.type === "step") {
      const d = e.data;
      const key = d.phase + ":" + d.file;
      if (d.step === "start") {
        let label;
        if (d.phase === "score") {
          label = d.file;
        } else {
          const phaseLabel = d.phase === "features" ? "Features" : "Align";
          const counter = d.index != null ? ` (${d.index}/${d.total})` : "";
          label = `${phaseLabel}: ${d.file}${counter}`;
        }
        const li = addStep(label);
        activeSteps[key] = li;
      } else if (d.step === "done") {
        completeStep(activeSteps[key], d.elapsed);
        delete activeSteps[key];
      }
    } else if (e.data.type === "progress") {
      progressText.textContent = e.data.message;
      if (e.data.pct >= 0) {
        progressBar.style.width = e.data.pct + "%";
      }
    } else if (e.data.type === "result") {
      clearInterval(elapsedTimer);
      const totalSecs = ((performance.now() - alignStartTime) / 1000).toFixed(
        1,
      );
      elapsedEl.textContent = `Total time: ${totalSecs}s`;
      alignmentResult = e.data.alignment;
      // Inject LD URI prefix from the alignment form (if provided)
      const ldPrefixEl = document.getElementById("align-ld-uri-prefix");
      const ldPrefix = ldPrefixEl ? ldPrefixEl.value.trim() : "";
      if (ldPrefix && alignmentResult.header) {
        alignmentResult.header.linkedDataUriPrefix = ldPrefix;
      }
      // Inject version & creation timestamp
      if (alignmentResult.header) {
        alignmentResult.header.createdBy =
          "Listen Here! v" + (window.versionString || "?");
        alignmentResult.header.createdAt = new Date().toISOString();
      }
      // Inject alignment parameters if checkbox is checked
      const includeParams = document.getElementById("align-include-params");
      if (includeParams && includeParams.checked && alignmentResult.header) {
        alignmentResult.header.alignmentParams = { ...currentOptions };
      }
      progressBar.style.width = "100%";
      progressText.textContent = "";
      document.getElementById("align-results").style.display = "";
      worker.terminate();
    } else if (e.data.type === "error") {
      clearInterval(elapsedTimer);
      progressText.textContent = "Error: " + e.data.message;
      progressBar.style.width = "100%";
      progressBar.style.background = "#ef4444";
      worker.terminate();
    }
  };
  worker.onerror = function (err) {
    clearInterval(elapsedTimer);
    progressText.textContent = "Worker error: " + err.message;
    progressBar.style.background = "#ef4444";
  };

  const transferables = audios.map((a) => a.samples.buffer);
  if (meiMidi) transferables.push(meiMidi.buffer);
  worker.postMessage(
    {
      type: "align",
      audios,
      refName,
      meiMidi: meiMidi || null,
      meiUri: meiUri || "",
      peakCount,
      options: currentOptions,
    },
    transferables,
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function downloadJSON() {
  if (!alignmentResult) return;
  const blob = new Blob([JSON.stringify(alignmentResult, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "alignment.json";
  a.click();
  URL.revokeObjectURL(url);
  sessionStorage.setItem("alignSavedBeforeListen", "true");
}

function listenToAlignment() {
  if (!alignmentResult || !_onComplete) return;
  _onComplete(alignmentResult, selectedFiles);
}

// ---------------------------------------------------------------------------
// Wizard tab navigation
// ---------------------------------------------------------------------------

const TAB_IDS = [
  "align-tab-files",
  "align-tab-quality",
  "align-tab-uris",
  "align-tab-align",
];
const LAST_TAB = TAB_IDS.length;

/** Switch to the given wizard tab (1-based). */
function goToTab(n) {
  if (n < 1 || n > LAST_TAB) return;
  if (alignmentRunning) return;
  currentTab = n;

  // Show/hide tab panes
  TAB_IDS.forEach((id, i) => {
    document.getElementById(id).classList.toggle("active", i === n - 1);
  });

  // Update step indicator
  document.querySelectorAll("#align-steps .align-step").forEach((el) => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle("active", s === n);
    el.classList.toggle("completed", s < n);
  });
  document
    .querySelectorAll("#align-steps .align-step-line")
    .forEach((el, i) => {
      el.classList.toggle("completed", i < n - 1);
    });

  // Update nav buttons
  const prevBtn = document.getElementById("align-prev-btn");
  const nextBtn = document.getElementById("align-next-btn");
  prevBtn.style.visibility = n === 1 ? "hidden" : "";

  // Cross-link to file picker only makes sense on step 1
  const modeSwitch = document.getElementById("align-mode-switch");
  if (modeSwitch) modeSwitch.classList.toggle("is-hidden", n !== 1);

  if (n === LAST_TAB) {
    nextBtn.style.display = "none";
    buildSummary();
  } else {
    nextBtn.style.display = "";
  }
}

/** Validate whether navigation away from the given tab is allowed. */
function canLeaveTab(tab) {
  if (tab === 1 && selectedFiles.length < 2) {
    alert("Please select at least 2 audio files before continuing.");
    return false;
  }
  return true;
}

/** Attempt to go to the next tab, with validation. */
function goNext() {
  if (!canLeaveTab(currentTab)) return;
  goToTab(currentTab + 1);
}

/** Jump directly to a step (clicked in the indicator). */
function goToStep(n) {
  if (n === currentTab) return;
  // When moving forward, validate leaving the current tab
  if (n > currentTab && !canLeaveTab(currentTab)) return;
  goToTab(n);
}

/** Go to the previous tab. */
function goPrev() {
  goToTab(currentTab - 1);
}

/** Build a summary on Tab 3 before alignment starts. */
function buildSummary() {
  const el = document.getElementById("align-summary");
  if (!el) return;
  const refRadio = document.querySelector('input[name="ref"]:checked');
  const refName = refRadio ? refRadio.value : selectedFiles[0]?.name || "?";
  const presetRadio = document.querySelector(
    'input[name="align-quality"]:checked',
  );
  const presetLabel = presetRadio ? presetRadio.value : "Custom";
  const meiUri = document.getElementById("align-mei-input").value.trim();

  let html = `<strong>${selectedFiles.length}</strong> audio files, reference: <strong>${escapeHtml(refName)}</strong>`;
  html += `<br>Quality: <strong>${escapeHtml(presetLabel.charAt(0).toUpperCase() + presetLabel.slice(1))}</strong>`;
  if (meiUri) html += `<br>Score alignment: MEI provided`;
  el.innerHTML = html;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Panel initialisation — wires up all DOM events inside #align-panel
// ---------------------------------------------------------------------------

export function initAlignPanel() {
  const panel = document.getElementById("align-panel");
  if (!panel) return;

  // Directory picker (Chromium only)
  const dirBtn = document.getElementById("align-dir-btn");
  if (typeof window.showDirectoryPicker === "function") {
    dirBtn.style.display = "";
    dirBtn.addEventListener("click", async () => {
      try {
        const dirHandle = await window.showDirectoryPicker();
        const files = [];
        for await (const entry of dirHandle.values()) {
          if (entry.kind === "file") files.push(await entry.getFile());
        }
        addFiles(files);
      } catch (e) {
        if (e.name !== "AbortError") console.warn("Dir picker error:", e);
      }
    });
  }

  // File input
  const filesBtn = document.getElementById("align-files-btn");
  const fileInput = document.getElementById("align-file-input");
  filesBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) addFiles(Array.from(fileInput.files));
  });

  // Drag and drop
  const card = document.getElementById("align-card");
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.getElementById("align-drop-zone").classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => {
    document.getElementById("align-drop-zone").classList.remove("drag-over");
  });
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    document.getElementById("align-drop-zone").classList.remove("drag-over");
    if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
  });

  // Start alignment
  document
    .getElementById("align-start-btn")
    .addEventListener("click", startAlignment);

  // Peaks checkbox + count input
  const peaksCheckbox = document.getElementById("align-peaks-checkbox");
  const peaksCountWrap = document.getElementById("align-peaks-count-wrap");
  const peaksCountInput = document.getElementById("align-peaks-count");
  peaksCheckbox.addEventListener("change", () => {
    peaksCountWrap.style.display = peaksCheckbox.checked ? "" : "none";
    updatePeakSizeEstimate();
  });
  peaksCountInput.addEventListener("input", updatePeakSizeEstimate);

  // --- Quality presets and advanced parameters ---

  // Load saved settings and apply to UI
  const saved = loadQualitySettings();
  writeAdvancedParams(saved.params);
  if (saved.preset && PRESETS[saved.preset]) {
    const radio = document.querySelector(
      `input[name="align-quality"][value="${saved.preset}"]`,
    );
    if (radio) radio.checked = true;
  } else {
    // Custom — uncheck all
    document
      .querySelectorAll('input[name="align-quality"]')
      .forEach((r) => (r.checked = false));
  }

  // Preset radio change → update advanced params
  document.querySelectorAll('input[name="align-quality"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked && PRESETS[radio.value]) {
        writeAdvancedParams(PRESETS[radio.value]);
        saveQualitySettings(radio.value, { ...PRESETS[radio.value] });
      }
    });
  });

  // Advanced param inputs → detect or clear preset
  const advancedInputs = [
    "align-param-coarse",
    "align-param-slack",
    "align-param-feature-rate",
    "align-param-score-ds",
    "align-param-onset-weight",
  ];
  advancedInputs.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", onAdvancedParamChange);
  });

  // "Reset to preset" link
  const resetLink = document.getElementById("align-reset-preset");
  if (resetLink) {
    resetLink.addEventListener("click", (e) => {
      e.preventDefault();
      const checked = document.querySelector(
        'input[name="align-quality"]:checked',
      );
      const presetName =
        checked && PRESETS[checked.value] ? checked.value : "balanced";
      selectPreset(presetName);
    });
  }

  // Score param enable/disable based on MEI input
  const meiInput = document.getElementById("align-mei-input");
  if (meiInput) {
    meiInput.addEventListener("input", updateScoreParamState);
    updateScoreParamState(); // initial state
  }

  // Results buttons
  document
    .getElementById("align-download-btn")
    .addEventListener("click", downloadJSON);
  document
    .getElementById("align-open-btn")
    .addEventListener("click", listenToAlignment);

  // Wizard navigation
  document.getElementById("align-next-btn").addEventListener("click", goNext);
  document.getElementById("align-prev-btn").addEventListener("click", goPrev);

  // Clickable step indicators
  document.querySelectorAll("#align-steps .align-step").forEach((el) => {
    el.addEventListener("click", () => {
      goToStep(parseInt(el.dataset.step));
    });
  });

  // Set initial tab state
  goToTab(1);
}
