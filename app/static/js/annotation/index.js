// V6 annotation rework — module entry point.
//
// Feature-flag-gated for development. Active iff one of:
//   - URL contains ?annot=v6 (which also persists the choice in localStorage)
//   - localStorage["annot-v6"] === "1"
//
// To switch back to legacy, load with ?annot=legacy (clears the localStorage flag).
//
// While the flag is off this module is a no-op; the legacy annotation.js stack
// continues to drive the annotation UI. The flag is removed in Phase F.

import * as state from "./state.js";
import * as adapter from "./mao-adapter.js";

const STORAGE_KEY = "annot-v6";

export function isV6Active() {
  let urlChoice = null;
  try {
    urlChoice = new URLSearchParams(window.location.search).get("annot");
  } catch (_) {}
  if (urlChoice === "v6") {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (_) {}
    return true;
  }
  if (urlChoice === "legacy") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    return false;
  }
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function initAnnotationV6() {
  if (!isV6Active()) return;
  console.info(
    "[annotation/v6] feature flag active — Phase A foundation loaded.",
  );
  // Expose state + adapter for devtools inspection. UI phases will add more.
  window.__annotationV6 = { active: true, state, adapter };
  // Run the adapter round-trip smoke on init so a console message confirms
  // the foundation is healthy.
  try {
    const report = adapter.selfTest();
    if (report.passed) {
      console.info(
        `[annotation/v6] adapter self-test passed (${report.templateCount} templates).`,
      );
    } else {
      console.error("[annotation/v6] adapter self-test FAILED:", report.failures);
    }
  } catch (e) {
    console.error("[annotation/v6] adapter self-test threw:", e);
  }
}
