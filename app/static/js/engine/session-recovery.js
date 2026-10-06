// Session recovery: unsaved work survives losing the tab (0.85.0).
//
// A SESSION is one load of an alignment in one tab, named by a random id. The
// id is the storage key, so two tabs never overwrite each other's work. Each
// snapshot also carries a PIECE FINGERPRINT (the score URI and the sorted
// recording names), used only for MATCHING a later load, never as a key: in
// this corpus several annotation sets share both score and recordings (Adults
// and Expert, Kids and HQ), so a key derived from the piece would let one set's
// work overwrite another's. Where a match is ambiguous the user picks, from the
// description each snapshot carries.
//
// What is copied: the alignment's header (markers, grouping tabs, LD config)
// and the annotations — a few KB. What is NOT: the body's grids, ~12 MB for a
// real piece against localStorage's ~5 MB per origin. Fix-mode corrections live
// in the body; when they are covered, they go to IndexedDB under the same
// session id, and this format stays as it is (hence `v`).
//
// Pure apart from the storage object passed in, so every function here takes
// it explicitly; listen.js owns the timing and the UI.

export const RECOVERY_PREFIX = "lh-recovery:";
export const RECOVERY_FORMAT = 1;
export const RECOVERY_MAX_COUNT = 20;
export const RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A fresh session id. */
export function newSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** FNV-1a, 32-bit, as 8 hex digits. Identity for matching, not security. */
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The piece an alignment is for: its score and its recordings. Stable across
 * re-saves and renames of the alignment file, which is the point.
 *
 * @param {string} meiUri  header.meiUri, or "" for an audio-only alignment
 * @param {string[]} recordings  body.audio keys, without the synth key
 */
export function pieceFingerprint(meiUri, recordings) {
  return _fnv1a((meiUri || "") + "\n" + [...recordings].sort().join("\n"));
}

function _key(id) {
  return RECOVERY_PREFIX + id;
}

/** Every well-formed snapshot in storage, newest edit first. */
export function listSnapshots(storage) {
  const out = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(RECOVERY_PREFIX)) continue;
      try {
        const s = JSON.parse(storage.getItem(k));
        if (s && s.v === RECOVERY_FORMAT && s.id) out.push(s);
      } catch (_) {
        // A torn or foreign entry: ignore rather than let it block recovery.
      }
    }
  } catch (_) {
    return [];
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function readSnapshot(storage, id) {
  try {
    const s = JSON.parse(storage.getItem(_key(id)));
    return s && s.v === RECOVERY_FORMAT ? s : null;
  } catch (_) {
    return null;
  }
}

export function removeSnapshot(storage, id) {
  try {
    storage.removeItem(_key(id));
  } catch (_) {}
}

/**
 * Drop snapshots older than the age limit, then the oldest beyond the count
 * limit. `keepId` (the live session) is never dropped.
 */
export function pruneSnapshots(
  storage,
  { now = Date.now(), maxCount = RECOVERY_MAX_COUNT, maxAgeMs = RECOVERY_MAX_AGE_MS, keepId = null } = {},
) {
  const all = listSnapshots(storage);
  let kept = 0;
  for (const s of all) {
    if (s.id === keepId) continue; // the live session: neither dropped nor counted
    const tooOld = now - (s.updatedAt || 0) > maxAgeMs;
    if (tooOld || kept >= maxCount) removeSnapshot(storage, s.id);
    else kept++;
  }
}

/**
 * Write one snapshot. On a full store, prune the oldest others and try once
 * more; a store that still refuses is reported, not thrown, since losing the
 * safety net must never break editing.
 *
 * @returns {boolean} whether it was written
 */
export function writeSnapshot(storage, snap) {
  const text = JSON.stringify(snap);
  try {
    storage.setItem(_key(snap.id), text);
    return true;
  } catch (_) {
    try {
      pruneSnapshots(storage, { maxCount: Math.floor(RECOVERY_MAX_COUNT / 2), keepId: snap.id });
      storage.setItem(_key(snap.id), text);
      return true;
    } catch (err) {
      console.warn("session recovery: could not write a snapshot", err);
      return false;
    }
  }
}

/**
 * The comparable content of a snapshot: what the user edits. Two payloads with
 * the same content describe the same work, whatever their timestamps.
 */
export function contentSignature(header, annotations) {
  return JSON.stringify({
    markers: header?.markers ?? [],
    groupingTabs: header?.groupingTabs ?? null,
    activeTab: header?.activeTab ?? null,
    annotations: annotations ?? [],
  });
}

/**
 * Snapshots worth offering back for a just-loaded piece: same piece, unsaved
 * work, a different session, and content that differs from what was loaded.
 */
export function offersFor(storage, { fingerprint, currentId, loadedSignature }) {
  return listSnapshots(storage).filter(
    (s) =>
      s.dirty &&
      s.fingerprint === fingerprint &&
      s.id !== currentId &&
      contentSignature(s.header, s.annotations) !== loadedSignature,
  );
}

/**
 * The header a restore loads: the snapshot's, except the fields that describe
 * the grids and score it was aligned against, which stay as loaded.
 */
export function restoredHeader(loadedHeader, snapHeader) {
  const h = { ...(snapHeader || {}) };
  for (const k of ["ref", "meiUri", "alignmentParams", "createdBy", "createdAt"]) {
    if (loadedHeader && k in loadedHeader) h[k] = loadedHeader[k];
    else delete h[k];
  }
  return h;
}

/** The source name of an alignment made in the wizard and not yet saved. */
export const IN_BROWSER_SOURCE = "in-browser-alignment";

/**
 * The Save data file name for a session label: characters no file system
 * takes become "-", so "Fledermaus: expert/set" saves as
 * "Fledermaus- expert-set.json". No label, the old "alignment.json".
 */
export function alignmentFileName(label) {
  const base = String(label || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();
  return (base || "alignment") + ".json";
}

/** The work title in an MEI file's header (titleStmt), or "". */
export function meiTitle(xmlText) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const t =
      doc.querySelector("meiHead fileDesc titleStmt title") ||
      doc.querySelector("meiHead title");
    return (t?.textContent || "").replace(/\s+/g, " ").trim();
  } catch (_) {
    return "";
  }
}

/** "1 marker, 3 annotations (Intro, Waltz, Coda)" — for the banner and picker. */
export function describeSnapshot(s, { labels = 3 } = {}) {
  const nm = s.header?.markers?.length ?? 0;
  const anns = s.annotations ?? [];
  const parts = [
    nm + " marker" + (nm === 1 ? "" : "s"),
    anns.length + " annotation" + (anns.length === 1 ? "" : "s"),
  ];
  let text = parts.join(", ");
  const names = anns.map((a) => a.label).filter(Boolean);
  if (names.length) {
    const shown = names.slice(0, labels).join(", ");
    text += " (" + shown + (names.length > labels ? ", …" : "") + ")";
  }
  return text;
}

/** "Mon 6 Oct, 14:32" in the user's locale. */
export function describeWhen(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_) {
    return new Date(ms).toISOString();
  }
}
