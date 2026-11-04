// Remembered values for URI entry fields. The app never submits a <form>, so
// the browser's own form history records nothing for them; a <datalist> fed
// from localStorage gives the same drop-down of earlier entries.

const MAX_ENTRIES = 12;
const KEY_PREFIX = "listenTool_uriHistory_";

function load(kind) {
  try {
    const list = JSON.parse(localStorage.getItem(KEY_PREFIX + kind) || "[]");
    return Array.isArray(list) ? list.filter((v) => typeof v === "string") : [];
  } catch (_) {
    return [];
  }
}

function save(kind, list) {
  try {
    localStorage.setItem(KEY_PREFIX + kind, JSON.stringify(list));
  } catch (_) {}
}

function isHttpUri(v) {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch (_) {
    return false;
  }
}

function fill(datalist, kind) {
  datalist.replaceChildren(
    ...load(kind).map((v) => {
      const option = document.createElement("option");
      option.value = v;
      return option;
    }),
  );
}

/**
 * Offer `input` the values earlier committed in any field of the same `kind`,
 * most recent first. A value is remembered when the field is committed (its
 * change event) and parses as an http(s) URI.
 */
export function rememberUriInput(input, kind) {
  if (!input) return;
  const listId = `uri-history-${kind}`;
  let datalist = document.getElementById(listId);
  if (!datalist) {
    datalist = document.createElement("datalist");
    datalist.id = listId;
    document.body.appendChild(datalist);
  }
  input.setAttribute("list", listId);
  // Refilled on focus, so a value committed in another field or tab shows up
  input.addEventListener("focus", () => fill(datalist, kind));
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (!isHttpUri(v)) return;
    save(kind, [v, ...load(kind).filter((x) => x !== v)].slice(0, MAX_ENTRIES));
    fill(datalist, kind);
  });
  fill(datalist, kind);
}
