// V6 annotation — ephemeral UI state.
//
// Session-only: drawer open/closed, drawer mode (view/edit), draw-mode toggle.
// Not persisted in alignment.json. Subscribers re-render on change.

let _drawerOpen = false;
let _mode = "edit";
let _drawMode = true; // defaults on per locked design
const _listeners = new Set();

function emit() {
  for (const fn of _listeners) {
    try {
      fn();
    } catch (e) {
      console.error("[annotation/v6] ui-state listener threw", e);
    }
  }
}

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getDrawerOpen() {
  return _drawerOpen;
}

export function setDrawerOpen(v) {
  _drawerOpen = !!v;
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("lh-v6-drawer-open", _drawerOpen);
  }
  emit();
}

export function getMode() {
  return _mode;
}

export function setMode(v) {
  if (v === "view" || v === "edit") {
    _mode = v;
    emit();
  }
}

export function getDrawMode() {
  return _drawMode;
}

export function setDrawMode(v) {
  _drawMode = !!v;
  emit();
}
