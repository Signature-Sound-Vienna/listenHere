// exhibit/study-panel.js
//
// The in-situ design-discussion panel (`?studyPanel=true`): a cog in the corner
// that opens a tabbed panel of the exhibit's A/B parameters, so competing
// design-space points can be flipped between live at a table instead of argued
// about from memory. STAFF TOOLING, not visitor UI — which is why it is exempt
// from the strings catalogue (English literals, like the console), exempt from
// the no-labels rule, and appended to document.body so the stage rotation and
// the viewport transforms never touch it.
//
// HOW A CHANGE APPLIES: by REWRITING THE QUERY STRING AND RELOADING, never by
// live-patching. Almost every parameter is consumed at boot (renderer heights,
// WaveSurfer colours, viewport count), boot is sub-second from the HTTP cache,
// and the reload buys the property that makes this a study tool rather than a
// toy: THE URL IS ALWAYS THE COMPLETE CONFIGURATION. Copy it out of the footer
// mid-discussion and that design-space point is saved. Values equal to the
// default are REMOVED from the URL rather than written, so the query string
// stays a minimal diff against the shipped exhibit.
//
// Parameters are declared in TABS below — adding a config field to the panel is
// one entry there, nothing else.

import { DEFAULTS } from "./config.js";
import { PALETTES, CATEGORY_KEYS, categoryOptions } from "./themes.js";

/** Panel labels for the theme categories (staff-facing English, see header). */
const CATEGORY_LABELS = {
  canvas: "Canvas (background)",
  strips: "Strips",
  waves: "Waveforms",
  captions: "Strip captions",
  text: "Commentary text",
  controls: "Controls & chips",
  accent: "Accent",
  band: "Middle band",
};

const TABS = [
  {
    id: "layout",
    label: "Layout",
    params: [
      { key: "viewports", label: "Viewports", options: [1, 2] },
      { key: "splitOrientation", label: "Split", options: ["horizontal", "vertical"] },
      { key: "stageRotation", label: "Stage rotation (desktop)", options: [0, 90, 270] },
      { key: "stripHeight", label: "Strip height (px)", options: [40, 44, 48, 54, 60] },
      { key: "stackedRecordings", label: "Recordings", options: [4, 6, 8] },
      {
        key: "zoomControls",
        label: "Zoom buttons",
        options: [true, false],
        display: (v) => (v ? "show" : "hide"),
      },
    ],
  },
  {
    id: "band",
    label: "Band",
    params: [
      { key: "bandOrientation", label: "Orientation", options: ["upright", "rotated", "mirrored"] },
      { key: "middleBandHeight", label: "Band height (px)", options: [72, 96, 120, 176] },
    ],
  },
  {
    id: "theme",
    label: "Theme",
    params: [
      {
        key: "theme",
        label: "Preset",
        options: Object.keys(PALETTES),
        display: (v) => PALETTES[v]?.label || v,
      },
      // One row per themable category: pin it to any palette (or extra
      // variant) independently of the preset. "follow" is the default and
      // keeps the URL clean.
      ...CATEGORY_KEYS.map((cat) => ({
        key: "theme" + cat[0].toUpperCase() + cat.slice(1),
        label: CATEGORY_LABELS[cat] || cat,
        options: ["", ...categoryOptions(cat)],
        display: (v) => (v === "" ? "follow" : v),
      })),
      {
        key: "annotationColors",
        label: "Annotation colours",
        options: ["authored", "theme"],
        display: (v) => (v === "authored" ? "authored" : "theme series"),
      },
    ],
  },
  {
    id: "misc",
    label: "Misc",
    params: [
      { key: "minRegionPx", label: "Region floor (px)", options: [2, 4, 8] },
      { key: "zoom", label: "Initial zoom (px/s; 0 = fit)", options: [0, 30] },
      { key: "debug", label: "Debug logging", options: [false, true] },
    ],
  },
];

// PANEL STATE LIVES IN localStorage, NEVER IN THE URL — the URL is reserved
// for parameter selections (the configuration), while whether the panel is
// open and which tab it shows is ephemeral discussion state. Both survive the
// reload each change triggers, so changing an option feels continuous: the
// panel reopens itself on the same tab.
const TAB_KEY = "exhibitStudyTab";
const OPEN_KEY = "exhibitStudyOpen";

/** Mount the cog and the panel. Call once, only when config.studyPanel is on. */
export function mountStudyPanel(config) {
  const cog = document.createElement("button");
  cog.type = "button";
  cog.className = "study-cog";
  cog.textContent = "⚙";
  cog.setAttribute("aria-label", "Study panel");

  const panel = document.createElement("div");
  panel.className = "study-panel";
  panel.hidden = true;

  const tabs = document.createElement("div");
  tabs.className = "study-tabs";
  const body = document.createElement("div");
  body.className = "study-body";

  let activeTab = localStorage.getItem(TAB_KEY) || TABS[0].id;
  if (!TABS.some((t) => t.id === activeTab)) activeTab = TABS[0].id;

  for (const tab of TABS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "study-tab";
    b.dataset.tab = tab.id;
    b.textContent = tab.label;
    b.addEventListener("click", () => {
      activeTab = tab.id;
      localStorage.setItem(TAB_KEY, activeTab);
      paint();
    });
    tabs.appendChild(b);
  }

  // The footer: the current configuration as its URL — selectable against the
  // kiosk's global user-select: none, because copying it IS the feature.
  const footer = document.createElement("div");
  footer.className = "study-footer";
  const url = document.createElement("code");
  url.className = "study-url";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "study-copy";
  copy.textContent = "Copy URL";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy URL"), 1200);
    } catch (_) {
      // No clipboard (e.g. plain-http LAN): the text is selectable, say so.
      copy.textContent = "Select the text";
      setTimeout(() => (copy.textContent = "Copy URL"), 2000);
    }
  });
  footer.append(url, copy);

  panel.append(tabs, body, footer);

  function paint() {
    for (const b of tabs.children) b.classList.toggle("is-on", b.dataset.tab === activeTab);
    body.textContent = "";
    const tab = TABS.find((t) => t.id === activeTab);
    for (const param of tab.params) {
      const row = document.createElement("div");
      row.className = "study-row";
      const label = document.createElement("span");
      label.className = "study-label";
      label.textContent = param.label;
      const opts = document.createElement("span");
      opts.className = "study-options";
      const current = String(config[param.key]);
      for (const option of param.options) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "study-option";
        const isDefault = String(option) === String(DEFAULTS[param.key]);
        chip.textContent = (param.display ? param.display(option) : String(option)) +
          (isDefault ? " •" : "");
        chip.title = isDefault ? "default" : "";
        chip.classList.toggle("is-on", String(option) === current);
        chip.addEventListener("click", () => applyParam(param.key, option));
        opts.appendChild(chip);
      }
      row.append(label, opts);
      body.appendChild(row);
    }
    url.textContent = location.search || "(defaults)";
  }

  /**
   * Write one parameter into the URL and reload. Defaults are deleted rather
   * than written, so the URL stays a minimal, readable diff — and studyPanel
   * itself survives because true is not its default.
   */
  function applyParam(key, value) {
    const params = new URLSearchParams(location.search);
    if (String(value) === String(DEFAULTS[key])) params.delete(key);
    else params.set(key, String(value));
    // Choosing a PRESET clears every per-category pin back to "follow": a
    // preset click means "show me that theme", and stale pins silently
    // corrupting it is the confusing outcome. Pins are re-applied after, if
    // wanted — they are one chip away.
    if (key === "theme") {
      for (const cat of CATEGORY_KEYS) {
        params.delete("theme" + cat[0].toUpperCase() + cat.slice(1));
      }
    }
    const qs = params.toString();
    location.href = location.pathname + (qs ? `?${qs}` : "");
  }

  cog.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    localStorage.setItem(OPEN_KEY, panel.hidden ? "0" : "1");
    if (!panel.hidden) paint();
  });

  document.body.append(cog, panel);
  // Reopen where the discussion left off: an option change reloads the page,
  // and the panel comes straight back on the same tab.
  if (localStorage.getItem(OPEN_KEY) === "1") {
    panel.hidden = false;
    paint();
  }
  return { cog, panel };
}
