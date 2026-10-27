// Add recordings to a loaded alignment (0.97.0): the "Add Recordings" tab of
// Manage recordings.
//
// Each new recording is aligned to the reference by a worker of its own (fix
// mode's worker is left alone, and adding is refused while fix mode is open),
// with the settings the form holds: the original run's when the file records
// them, else the Balanced preset. What gets written, and why the original
// header is never touched, is engine/additions.js's business.

import { el } from "./annotation/ui-common.js";
import { PRESETS, decodeAudio } from "./align.js";
import {
  addRefusal,
  applyAddition,
  defaultAddParams,
  defaultOpenEnds,
  peakCountOf,
  refSpanOf,
} from "./engine/additions.js";

const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus)$/i;
const PARAM_KEYS = ["coarse", "slack", "featureRate"];

let _deps = null;
/** [{file, openEnds, refusal}] — the files picked for adding. */
let _picked = [];
/** The reference, when this session holds no audio for it and it was picked. */
let _pickedRef = null;
/** The setting beyond the form's three (scoreDownsample), carried through. */
let _paramBase = {};
let _running = false;

const $ = (id) => document.getElementById(id);

function _baseName(key) {
  return String(key).split("/").pop().normalize("NFC").toLowerCase();
}

/** A File under its composed (NFC) name, as the wizard stores names. */
function _nfcFile(f) {
  const nfc = f.name.normalize("NFC");
  return nfc === f.name
    ? f
    : new File([f], nfc, { type: f.type, lastModified: f.lastModified });
}

/**
 * @param {object} deps
 * @param {string}   deps.workerUrl
 * @param {string}   deps.synthKey     body.audio key of the synthesised score
 * @param {Function} deps.getAlignment () => the loaded alignment JSON or null
 * @param {Function} deps.refSource    () => "session" | "fetch" | "pick":
 *                                     where the reference's audio comes from
 * @param {Function} deps.refBlob      async () => the reference's audio as a
 *                                     Blob, from the session or its URL
 * @param {Function} deps.busyReason   () => why adding is refused now, or ""
 * @param {Function} deps.onAdded      ({names, files, refFile}) after the
 *                                     alignment JSON has been extended
 * @param {Function} deps.createdBy    () => "Listen Here! v…"
 */
export function initAddRecordings(deps) {
  _deps = deps;
  const input = $("add-rec-input");
  $("add-rec-files-btn")?.addEventListener("click", () => input.click());
  input?.addEventListener("change", () => {
    // Deferred a task: Firefox may not have populated .files yet (see the
    // file picker's input).
    setTimeout(() => {
      const files = Array.from(input.files);
      input.value = "";
      if (files.length) addPickedFiles(files);
    }, 0);
  });
  document.querySelectorAll('input[name="add-rec-quality"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked) _writeParams(PRESETS[r.value]);
    }),
  );
  for (const id of ["add-rec-coarse", "add-rec-slack", "add-rec-feature-rate"]) {
    $(id)?.addEventListener("change", _syncPresetRadio);
  }
  $("add-rec-start")?.addEventListener("click", _run);
}

/** Is the Add Recordings tab the one showing? (The card's drop target asks.) */
export function addTabActive() {
  return !!$("fp-tab-add")?.classList.contains("active");
}

/**
 * Bring the tab up to date with the loaded alignment: called whenever Manage
 * recordings opens, and after a load. Keeps the picked files unless the
 * alignment they were picked for is gone.
 */
export function refreshAddRecordings() {
  const json = _deps?.getAlignment();
  const tab = document.querySelector('.fp-tab[data-tab="fp-tab-add"]');
  const usable = !!(json?.header?.ref && json?.body?.audio);
  tab?.classList.toggle("disabled", !usable);
  if (!usable) {
    _picked = [];
    _pickedRef = null;
    return;
  }
  if (_running) return;
  $("add-rec-ref").textContent = json.header.ref;
  const { params, known } = defaultAddParams(json.header, PRESETS.balanced);
  // Only what a run reads: an older file's inert keys (onsetWeight, gone
  // since 0.59.0) must not be recorded as settings the addition used.
  _paramBase = { scoreDownsample: params.scoreDownsample ?? PRESETS.balanced.scoreDownsample };
  _writeParams(params);
  $("add-rec-params-note").textContent = known
    ? "These are the settings this alignment was made with. Change them only if you mean to align the new recordings differently; the file records which settings each recording was aligned with."
    : "This alignment doesn’t record the settings it was made with, so these are the Balanced defaults. The file will record them for the recordings you add, and keep the original settings marked as unknown.";
  // Settings that differ from the original's are worth seeing before a run.
  $("add-rec-params").open = !known;
  // Picked files may have become refusable since (a save, another addition).
  for (const p of _picked) p.refusal = addRefusal(p.file.name, json, _deps.synthKey);
  _render();
}

/** Take picked or dropped files: audio only, the reference recognised. */
export function addPickedFiles(files) {
  const json = _deps?.getAlignment();
  if (!json || _running) return;
  const refBase = _baseName(json.header.ref);
  const openDefault = defaultOpenEnds(json.header);
  for (let f of files) {
    if (!(AUDIO_EXTS.test(f.name) || f.type?.startsWith("audio/"))) continue;
    f = _nfcFile(f);
    if (_baseName(f.name) === refBase) {
      // The reference is never added; it is only picked when the session
      // has no audio for it.
      if (_deps.refSource() === "pick") _pickedRef = f;
      continue;
    }
    if (_picked.some((p) => p.file.name === f.name)) continue;
    _picked.push({
      file: f,
      openEnds: openDefault,
      refusal: addRefusal(f.name, json, _deps.synthKey),
    });
  }
  $("add-rec-result").textContent = "";
  _render();
}

function _readParams() {
  return {
    ..._paramBase,
    coarse: parseInt($("add-rec-coarse").value),
    slack: parseInt($("add-rec-slack").value),
    featureRate: parseInt($("add-rec-feature-rate").value),
  };
}

/** A value the select does not offer (an older or hand-made file) is added. */
function _setSelect(sel, v) {
  if (![...sel.options].some((o) => o.value === String(v))) {
    sel.append(el("option", { value: String(v), text: String(v) }));
  }
  sel.value = String(v);
}

function _writeParams(p) {
  _setSelect($("add-rec-coarse"), p.coarse);
  $("add-rec-slack").value = p.slack;
  _setSelect($("add-rec-feature-rate"), p.featureRate);
  _syncPresetRadio();
}

/** Check the preset the fields match, or none (custom). */
function _syncPresetRadio() {
  const p = _readParams();
  const match = Object.entries(PRESETS).find(([, q]) =>
    PARAM_KEYS.every((k) => q[k] === p[k]),
  );
  document.querySelectorAll('input[name="add-rec-quality"]').forEach((r) => {
    r.checked = !!match && r.value === match[0];
  });
}

function _render() {
  const json = _deps?.getAlignment();
  const tbody = $("add-rec-tbody");
  if (!tbody || !json) return;
  const needRef = _deps.refSource() === "pick";
  $("add-rec-ref-needed").hidden = !needRef || !!_pickedRef;
  $("add-rec-ref-needed-name").textContent = json.header.ref;
  tbody.replaceChildren(
    ..._picked.map((p, i) =>
      el("tr", { class: p.refusal ? "add-rec-refused" : "" }, [
        el("td", {}, [
          el("span", { class: "add-rec-name", text: p.file.name }),
          p.refusal ? el("span", { class: "add-rec-refusal", text: " — " + p.refusal }) : null,
        ]),
        el("td", {}, [
          p.refusal
            ? null
            : el("input", {
                type: "checkbox",
                class: "add-rec-trim",
                checked: p.openEnds,
                disabled: _running,
                "aria-label": "Trim ends of " + p.file.name,
                onchange: (e) => (p.openEnds = e.target.checked),
              }),
        ]),
        el("td", {}, [
          el("button", {
            type: "button",
            class: "add-rec-remove",
            text: "×",
            title: "Remove from this list",
            disabled: _running,
            onclick: () => {
              _picked.splice(i, 1);
              _render();
            },
          }),
        ]),
      ]),
    ),
  );
  $("add-rec-table").hidden = !_picked.length;
  const addable = _picked.filter((p) => !p.refusal).length;
  const busy = _deps.busyReason();
  const start = $("add-rec-start");
  start.disabled = _running || !addable || (needRef && !_pickedRef) || !!busy;
  start.title = busy || "";
  start.textContent = addable > 1 ? `Align and Add ${addable} Recordings` : "Align and Add";
}

function _progress(text, pct) {
  $("add-rec-progress").hidden = false;
  if (text != null) $("add-rec-progress-text").textContent = text;
  if (pct != null && pct >= 0) $("add-rec-progress-bar").style.width = pct + "%";
}

async function _run() {
  const json = _deps.getAlignment();
  const todo = _picked.filter((p) => !p.refusal);
  if (_running || !json || !todo.length) return;
  _running = true;
  _render();
  $("add-rec-result").textContent = "";
  $("add-rec-progress-bar").style.background = "";
  const refName = json.header.ref;
  const params = _readParams();
  const openEndsByFile = Object.fromEntries(todo.map((p) => [p.file.name, p.openEnds]));
  const worker = new Worker(_deps.workerUrl);
  const waiters = new Map();
  const waitFor = (key) => new Promise((resolve, reject) => waiters.set(key, { resolve, reject }));
  let failed = null;
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === "progress") _progress(d.message, d.pct);
    else if (d.type === "batch_ready") waiters.get("batch")?.resolve();
    else if (d.type === "feature_done") waiters.get("feature:" + d.name)?.resolve();
    else if (d.type === "added") waiters.get("added")?.resolve(d.result);
    else if (d.type === "error") {
      failed = new Error(d.message);
      for (const w of waiters.values()) w.reject(failed);
    }
  };
  worker.onerror = (err) => {
    failed = new Error(err.message || "worker error");
    for (const w of waiters.values()) w.reject(failed);
  };
  try {
    _progress("Starting the aligner…", 2);
    const ready = waitFor("batch");
    worker.postMessage({
      type: "begin_batch",
      refName,
      peakCount: peakCountOf(json),
      scoreMode: false,
      featureTotal: todo.length + 1,
      options: params,
      openEnds: false,
      openEndsByFile,
    });
    await ready;
    // The reference first, under its key in the alignment (the picked file's
    // own name may be spelled differently).
    const sources = [
      { name: refName, isRef: true, blob: () => (_pickedRef ? _pickedRef : _deps.refBlob()) },
      ...todo.map((p) => ({ name: p.file.name, isRef: false, blob: () => p.file })),
    ];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      _progress(`Decoding audio: ${s.name} (${i + 1}/${sources.length})`, 5 + (25 * i) / sources.length);
      const samples = await decodeAudio(await s.blob());
      const done = waitFor("feature:" + s.name);
      worker.postMessage(
        { type: "feature", name: s.name, samples, isRef: s.isRef },
        [samples.buffer],
      );
      await done;
    }
    const resultReady = waitFor("added");
    worker.postMessage({ type: "align_added", refSpan: refSpanOf(json) });
    const added = await resultReady;
    const record = applyAddition(json, added, {
      params,
      openEndsByFile,
      createdBy: _deps.createdBy(),
    });
    const files = todo.map((p) => p.file);
    _picked = _picked.filter((p) => p.refusal);
    _deps.onAdded({ names: record.recordings, files, refFile: _pickedRef });
    _pickedRef = null;
    _progress("", 100);
    $("add-rec-progress").hidden = true;
    $("add-rec-result").textContent = _summary(record);
  } catch (err) {
    _progress("Error: " + (failed || err).message, 100);
    $("add-rec-progress-bar").style.background = "var(--color-danger, #dc2626)";
  } finally {
    worker.terminate();
    _running = false;
    _render();
  }
}

/** "Added 2 recordings: a.wav, b.wav. Trimmed …" */
function _summary(record) {
  const n = record.recordings.length;
  let s = `Added ${n} recording${n === 1 ? "" : "s"}: ${record.recordings.join(", ")}.`;
  const { trimmed, guardFailed } = record.openEnds;
  if (trimmed.length) s += ` Audio with no counterpart in the reference was left out at the ends of ${trimmed.join(", ")}.`;
  if (guardFailed.length) s += ` ${guardFailed.join(", ")} could not be trimmed safely and was aligned whole.`;
  return s + ` Save the alignment to keep ${n === 1 ? "it" : "them"}.`;
}
