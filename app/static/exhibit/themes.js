// exhibit/themes.js
//
// Theme presets and per-category variants for the study panel. PLACEHOLDER
// AESTHETICS, by design: these exist so an in-situ design discussion can flip
// between palettes and argue about direction, not because any of them is the
// museum's final look. The preset list is oriented on Listen Here's own theme
// switcher (dark, light, sepia, solarized, nord, dracula, forest, peach) plus
// the exhibit's warm and high-contrast variants.
//
// TWO AXES, because committee discussions bikeshed per component:
//
//  * A PRESET (`?theme=`) is a complete coherent palette.
//  * Eight CATEGORIES can each be pinned to a DIFFERENT palette (or to an
//    extra variant) on top of the preset: `?theme=nord&themeWaves=amber`.
//    canvas / strips / waves / captions / text / controls / accent / band —
//    each is a slice of the token set, so "the nord background with sepia's
//    middle band and amber waveforms" is a URL, not an argument.
//
// HOW IT WORKS. exhibit.css defines every colour as a custom property on :root
// with the original dark palette as the literal default, so the default theme
// costs nothing and survives this module failing entirely. A category resolved
// to "dark" is therefore SKIPPED — the CSS defaults are those values — which
// also makes mixing dark parts into other presets free. The waveform colours
// cannot be CSS tokens (WaveSurfer paints canvases from JS options), so every
// palette carries a `wave` block, and main.js hands the resolved one to the
// strips at creation. The BAND has its own token set whose :root defaults
// chain to the generic tokens with var(), so it follows the preset until
// `themeBand` pins it to a palette of its own.
//
// KNOWN LIMIT, stated so nobody debugs it as a bug: annotation, region, and
// group colours are AUTHORED payload values (safeColor passes them through),
// so they do not re-tint with the theme. On light palettes the pale group
// pastels lose contrast against a light surface — a real finding for the
// design discussion, not a rendering error.

// OPTIONAL TOKENS (--ex-texture, --ex-font): a palette may carry them, and
// applyTheme skips the ones it does not — the :root defaults (no texture, the
// system sans) cover everyone else, so the existing themes are untouched and
// the dark default still writes zero inline tokens (35.11's pin).

const GLOW_DARK = "0 1px 2px #000, 0 0 6px #000";
const glowFrom = (bg) => `0 1px 2px ${bg}, 0 0 6px ${bg}`;
const MARKS_LIGHT_BG = { "--ex-mark": "rgba(0,0,0,0.7)", "--ex-mark-dim": "rgba(0,0,0,0.55)" };

// The parchment ground (user, 2026-08-25 — hand-written concert diaries,
// programme notes; PROCEDURAL by ruling: no asset, no fetch, the whole
// texture is these two strings). THE LESSON OF THREE TOO-FAINT CUTS (same
// day): amplitude alone cannot make turbulence read as paper — diffuse
// low-frequency clouds at tasteful contrast are exactly what vision is least
// sensitive to, and a field of high-contrast ink masks them entirely. Aged
// paper is read through EDGES, so the stains go through a non-linear alpha
// transfer (feComponentTransfer) that keeps most of the ground clean and
// gives the darker patches defined boundaries, plus a sparse rust-toned
// FOXING speckle (steeply thresholded fine turbulence) and a fibre grain.
//
// TWO IMAGES, deliberately (user, same day — a 512px tile's stain
// constellations drummed a visible repeat): the STRUCTURED layers cover the
// whole screen as ONE non-repeating image (background-size: cover; SVG is
// vector, so it re-rasterizes crisply at any screen), while the GRAIN stays a
// small repeating tile — its ~1px fibres must not scale, and uniform noise
// betrays no repetition. Cost of the cover layer: one full-screen
// rasterization at load (~20 MB layer at iPad resolution) — a kiosk never
// resizes, but it is on the §7.2 device-test and soak watch list. The
// vignette (aged edges) rides in the same background-image list as a
// radial-gradient. Real crumple (crease shading) is beyond turbulence — a
// scanned image can replace these URIs without touching the machinery.
const PARCHMENT_STAINS =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='768' height='1024' viewBox='0 0 768 1024'>" +
      "<filter id='b'><feTurbulence type='fractalNoise' baseFrequency='0.009' numOctaves='4' seed='4'/>" +
      "<feColorMatrix type='matrix' values='0 0 0 0 0.40  0 0 0 0 0.30  0 0 0 0 0.16  0 0 0 1 0'/>" +
      "<feComponentTransfer><feFuncA type='table' tableValues='0 0 0.04 0.18 0.34 0.42'/></feComponentTransfer></filter>" +
      "<filter id='f'><feTurbulence type='fractalNoise' baseFrequency='0.16' numOctaves='2' seed='23'/>" +
      "<feColorMatrix type='matrix' values='0 0 0 0 0.42  0 0 0 0 0.24  0 0 0 0 0.10  0 0 0 1 0'/>" +
      "<feComponentTransfer><feFuncA type='table' tableValues='0 0 0 0 0 0 0.12 0.45'/></feComponentTransfer></filter>" +
      "<rect width='768' height='1024' filter='url(#b)'/>" +
      "<rect width='768' height='1024' filter='url(#f)'/>" +
      "</svg>",
  );
const PARCHMENT_GRAIN =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'>" +
      "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.55' numOctaves='2' seed='11' stitchTiles='stitch'/>" +
      "<feColorMatrix type='matrix' values='0 0 0 0 0.36  0 0 0 0 0.28  0 0 0 0 0.16  0 0 0 0.10 0'/></filter>" +
      "<rect width='320' height='320' filter='url(#g)'/>" +
      "</svg>",
  );

// Leather for the switch strap (?tapMode=direct), parchment only — procedural
// like the paper above, by the same ruling: no asset, no fetch. Two layers,
// the paper lesson applied (amplitude alone does not read as material —
// edges do): a dense fine grain tile, and below it a THRESHOLDED low-
// frequency blotch layer (wear, oiling, water marks) stretched once over the
// strap's full height — stretched, not tiled, so nothing drums along its
// length. The colour work (base tan, edge burnish) lives in the token's
// gradient layers.
// Rendered 1:1 and tiled (stitchTiles), never stretched: a scaled turbulence
// render can seam at the renderer's internal tile boundaries — seen on the
// device as a hard edge past the arrow tips. 1024 tall, so the repeat only
// enters on a viewport half taller than that.
const LEATHER_BLOTCH =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='52' height='1024' viewBox='0 0 52 1024'>" +
      "<filter id='w' x='0' y='0' width='100%' height='100%'>" +
      "<feTurbulence type='fractalNoise' baseFrequency='0.06 0.008' numOctaves='3' seed='9' stitchTiles='stitch'/>" +
      "<feColorMatrix type='matrix' values='0 0 0 0 0.09  0 0 0 0 0.045  0 0 0 0 0.015  0 0 0 1 0'/>" +
      "<feComponentTransfer><feFuncA type='table' tableValues='0 0 0.10 0.28 0.42 0.52'/></feComponentTransfer></filter>" +
      "<rect width='52' height='1024' filter='url(#w)'/>" +
      "</svg>",
  );
const PARCHMENT_LEATHER =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'>" +
      "<filter id='l'><feTurbulence type='fractalNoise' baseFrequency='0.6' numOctaves='4' seed='7' stitchTiles='stitch'/>" +
      "<feColorMatrix type='matrix' values='0 0 0 0 0.10  0 0 0 0 0.05  0 0 0 0 0.02  0 0 0 0.45 0'/></filter>" +
      "<rect width='96' height='96' filter='url(#l)'/>" +
      "</svg>",
  );

export const PALETTES = {
  dark: {
    label: "Dark (default)",
    tokens: {
      // Listed in full even though the CSS defaults ARE these values — the
      // band mapping and cross-preset mixing read them as data.
      "--ex-bg": "#0b0b0c",
      "--ex-text": "#f2f2f4",
      "--ex-surface": "#141417",
      "--ex-surface-active": "#1b1b21",
      "--ex-panel": "#17171b",
      "--ex-border": "#26262c",
      "--ex-border-strong": "#3a3a44",
      "--ex-card": "#26262c",
      "--ex-text-body": "#d8d8e2",
      "--ex-text-soft": "#a9a9b4",
      "--ex-text-dim": "#8d8d99",
      "--ex-text-faint": "#6f6f7d",
      "--ex-label": "#cfcfd8",
      "--ex-label-active": "#fff",
      "--ex-glow": GLOW_DARK,
      "--ex-accent": "#2f4d70",
      "--ex-accent-border": "#5f86b4",
      "--ex-on-accent": "#fff",
      "--ex-mark": "rgba(255,255,255,0.7)",
      "--ex-mark-dim": "rgba(255,255,255,0.55)",
    },
    wave: {
      wave: "#5c5c68",
      waveActive: "#8fb8e8",
      progress: "#3d3d47",
      progressActive: "#5f86b4",
      cursor: "#f2f2f4",
    },
    // The annotation-recolour series (see recolorAnnotations): 12 diverging
    // colours tuned to this palette's surfaces, MAXIMALLY SEPARATED AT THE
    // FRONT because real payloads use fewer than 12.
    series: [
      "#4f9be8", "#e8a13d", "#4fc98f", "#e05a9a", "#4fc7d4", "#e05c4f",
      "#a07fe0", "#d9cb5a", "#3f9e8a", "#e88fb0", "#9ecf5a", "#8a9ab8",
    ],
  },

  light: {
    label: "Light",
    tokens: {
      "--ex-bg": "#f4f4f6",
      "--ex-text": "#17171b",
      "--ex-surface": "#e7e7ec",
      "--ex-surface-active": "#dde4f0",
      "--ex-panel": "#ececf0",
      "--ex-border": "#d3d3da",
      "--ex-border-strong": "#b9b9c2",
      "--ex-card": "#dcdce2",
      "--ex-text-body": "#2a2a32",
      "--ex-text-soft": "#5a5a66",
      "--ex-text-dim": "#6d6d78",
      "--ex-text-faint": "#8d8d99",
      "--ex-label": "#3a3a44",
      "--ex-label-active": "#000",
      "--ex-glow": glowFrom("#f4f4f6"),
      "--ex-accent": "#2f4d70",
      "--ex-accent-border": "#5f86b4",
      "--ex-on-accent": "#fff",
      ...MARKS_LIGHT_BG,
    },
    wave: {
      wave: "#9a9aa6",
      waveActive: "#3f6ea6",
      progress: "#71717e",
      progressActive: "#2f4d70",
      cursor: "#17171b",
    },
    series: [
      "#2266b8", "#b86e14", "#1f8a52", "#b02d72", "#17808e", "#c03a2b",
      "#6a48b0", "#8a7d1a", "#1f6f6a", "#b05a7a", "#5f7d1f", "#4a5a7a",
    ],
  },

  warm: {
    label: "Warm dark",
    tokens: {
      "--ex-bg": "#14100c",
      "--ex-text": "#f4ede2",
      "--ex-surface": "#1d1712",
      "--ex-surface-active": "#2a2016",
      "--ex-panel": "#201914",
      "--ex-border": "#322822",
      "--ex-border-strong": "#4a3c30",
      "--ex-card": "#322822",
      "--ex-text-body": "#e2d7c8",
      "--ex-text-soft": "#b3a48f",
      "--ex-text-dim": "#8f8272",
      "--ex-text-faint": "#7a6f60",
      "--ex-label": "#d8cbb8",
      "--ex-label-active": "#fff",
      "--ex-glow": GLOW_DARK,
      "--ex-accent": "#6e4f22",
      "--ex-accent-border": "#b98a3e",
      "--ex-on-accent": "#fff",
      "--ex-mark": "rgba(255,255,255,0.7)",
      "--ex-mark-dim": "rgba(255,255,255,0.55)",
    },
    wave: {
      wave: "#6b5f52",
      waveActive: "#d9a55a",
      progress: "#4a4138",
      progressActive: "#a1793d",
      cursor: "#f4ede2",
    },
    series: [
      "#d9a55a", "#6fa8d9", "#9ec46f", "#d96a8a", "#6fc9b8", "#c96a4f",
      "#b08fd9", "#d9c96f", "#8fb89a", "#d98fb8", "#a8a86f", "#8f9ab0",
    ],
  },

  contrast: {
    label: "High contrast",
    tokens: {
      "--ex-bg": "#000",
      "--ex-text": "#fff",
      "--ex-surface": "#101010",
      "--ex-surface-active": "#1c1c1c",
      "--ex-panel": "#101010",
      "--ex-border": "#555",
      "--ex-border-strong": "#777",
      "--ex-card": "#1c1c1c",
      "--ex-text-body": "#fff",
      "--ex-text-soft": "#ccc",
      "--ex-text-dim": "#bbb",
      "--ex-text-faint": "#999",
      "--ex-label": "#eee",
      "--ex-label-active": "#fff",
      "--ex-glow": GLOW_DARK,
      "--ex-accent": "#0a5ad4",
      "--ex-accent-border": "#4db2ff",
      "--ex-on-accent": "#fff",
      "--ex-mark": "rgba(255,255,255,0.8)",
      "--ex-mark-dim": "rgba(255,255,255,0.6)",
    },
    wave: {
      wave: "#a8a8b0",
      waveActive: "#4db2ff",
      progress: "#606068",
      progressActive: "#2b7fd4",
      cursor: "#fff",
    },
    series: [
      "#4db2ff", "#ffb300", "#4dff88", "#ff4dd2", "#00e5e5", "#ff5252",
      "#b388ff", "#ffe14d", "#00bfa5", "#ff8fb3", "#b2ff59", "#cfd8dc",
    ],
  },

  nord: {
    label: "Nord",
    tokens: {
      "--ex-bg": "#2e3440",
      "--ex-text": "#eceff4",
      "--ex-surface": "#3b4252",
      "--ex-surface-active": "#434c5e",
      "--ex-panel": "#3b4252",
      "--ex-border": "#434c5e",
      "--ex-border-strong": "#4c566a",
      "--ex-card": "#434c5e",
      "--ex-text-body": "#e5e9f0",
      "--ex-text-soft": "#d8dee9",
      "--ex-text-dim": "#a2aec7",
      "--ex-text-faint": "#7b88a1",
      "--ex-label": "#d8dee9",
      "--ex-label-active": "#fff",
      "--ex-glow": glowFrom("#2e3440"),
      "--ex-accent": "#5e81ac",
      "--ex-accent-border": "#81a1c1",
      "--ex-on-accent": "#fff",
      "--ex-mark": "rgba(236,239,244,0.7)",
      "--ex-mark-dim": "rgba(236,239,244,0.5)",
    },
    wave: {
      wave: "#4c566a",
      waveActive: "#88c0d0",
      progress: "#434c5e",
      progressActive: "#5e81ac",
      cursor: "#eceff4",
    },
    // Nord's own aurora + frost hues, divergence-first.
    series: [
      "#88c0d0", "#d08770", "#a3be8c", "#b48ead", "#ebcb8b", "#5e81ac",
      "#bf616a", "#8fbcbb", "#81a1c1", "#d4a373", "#7f9f6f", "#a9b8d4",
    ],
  },

  dracula: {
    label: "Dracula",
    tokens: {
      "--ex-bg": "#282a36",
      "--ex-text": "#f8f8f2",
      "--ex-surface": "#383a59",
      "--ex-surface-active": "#44475a",
      "--ex-panel": "#383a59",
      "--ex-border": "#44475a",
      "--ex-border-strong": "#6272a4",
      "--ex-card": "#44475a",
      "--ex-text-body": "#cdd6f4",
      "--ex-text-soft": "#a0a8d0",
      "--ex-text-dim": "#8a93bd",
      "--ex-text-faint": "#6272a4",
      "--ex-label": "#cdd6f4",
      "--ex-label-active": "#fff",
      "--ex-glow": glowFrom("#282a36"),
      "--ex-accent": "#6247aa",
      "--ex-accent-border": "#bd93f9",
      "--ex-on-accent": "#fff",
      "--ex-mark": "rgba(248,248,242,0.7)",
      "--ex-mark-dim": "rgba(248,248,242,0.5)",
    },
    wave: {
      wave: "#6272a4",
      waveActive: "#8be9fd",
      progress: "#44475a",
      progressActive: "#7286c4",
      cursor: "#f8f8f2",
    },
    // Dracula's signature accents, divergence-first, then tints.
    series: [
      "#8be9fd", "#ffb86c", "#50fa7b", "#ff79c6", "#bd93f9", "#f1fa8c",
      "#ff5555", "#7fd1a8", "#d6acff", "#ffcf9e", "#87e8ff", "#ffa3d1",
    ],
  },

  forest: {
    label: "Forest",
    tokens: {
      "--ex-bg": "#1a2b1a",
      "--ex-text": "#c8e0c8",
      "--ex-surface": "#1f3523",
      "--ex-surface-active": "#2a4230",
      "--ex-panel": "#1f3523",
      "--ex-border": "#2a4230",
      "--ex-border-strong": "#3d6048",
      "--ex-card": "#2a4230",
      "--ex-text-body": "#b8d4bc",
      "--ex-text-soft": "#a0c8a8",
      "--ex-text-dim": "#78a880",
      "--ex-text-faint": "#4a7855",
      "--ex-label": "#a0c8a8",
      "--ex-label-active": "#e8f5e8",
      "--ex-glow": glowFrom("#1a2b1a"),
      "--ex-accent": "#3d8b5f",
      "--ex-accent-border": "#5fae7f",
      "--ex-on-accent": "#fff",
      "--ex-mark": "rgba(200,224,200,0.7)",
      "--ex-mark-dim": "rgba(200,224,200,0.5)",
    },
    wave: {
      wave: "#4a7855",
      waveActive: "#8fd4a8",
      progress: "#2a4230",
      progressActive: "#5fae7f",
      cursor: "#c8e0c8",
    },
    series: [
      "#8fd4a8", "#d9b36a", "#7fb4d9", "#d98a7f", "#c9d46f", "#b08fd9",
      "#6fc9c0", "#d9d98f", "#a8d97f", "#d9a3c4", "#8fa8b8", "#c4b8a3",
    ],
  },

  sepia: {
    label: "Sepia",
    tokens: {
      "--ex-bg": "#f5ede0",
      "--ex-text": "#3d2b1f",
      "--ex-surface": "#ede0ce",
      "--ex-surface-active": "#e2d2ba",
      "--ex-panel": "#ede0ce",
      "--ex-border": "#ddd0bc",
      "--ex-border-strong": "#c8b89e",
      "--ex-card": "#ddd0bc",
      "--ex-text-body": "#4a3527",
      "--ex-text-soft": "#6b4f3a",
      "--ex-text-dim": "#8c6b55",
      "--ex-text-faint": "#b39880",
      "--ex-label": "#5a4232",
      "--ex-label-active": "#2e1e12",
      "--ex-glow": glowFrom("#f5ede0"),
      "--ex-accent": "#7a5230",
      "--ex-accent-border": "#5a3b22",
      "--ex-on-accent": "#fff",
      ...MARKS_LIGHT_BG,
    },
    wave: {
      wave: "#b39880",
      waveActive: "#7a5230",
      progress: "#8c6b55",
      progressActive: "#5a3b22",
      cursor: "#3d2b1f",
    },
    // Deep inks on cream, divergence-first.
    series: [
      "#2e6b8a", "#a8552e", "#4f7d3a", "#8a2e5c", "#1f7d76", "#6a48a0",
      "#b08814", "#b04a3a", "#4a5a8a", "#7d6a2e", "#a05a7a", "#5c5c50",
    ],
  },

  parchment: {
    label: "Parchment",
    // Hand-written concert diaries and programme notes (user, 2026-08-25):
    // aged cream a shade deeper than sepia's, iron-gall ink for text and
    // waveforms, a bronze accent (the eventual magnifying-glass marker's
    // metal), and the two optional tokens — the procedural paper ground and
    // an old-style serif stack. The serif is SYSTEM fonts only for now
    // (Iowan/Palatino/Georgia — German glyphs guaranteed, nothing to license);
    // option (c), a bundled open-licensed display face, would prepend itself
    // to this stack later.
    tokens: {
      "--ex-bg": "#eadfc6",
      "--ex-text": "#2e2418",
      // CLEAN LANES (user, eyeballing 2026-08-25, final ruling): the texture
      // is removed entirely from behind the waveforms — opaque ground colour,
      // so the ink lives on clean paper while the staining owns the margins.
      // The audible strip keeps the soft pressed distinction.
      "--ex-surface": "#eadfc6",
      "--ex-surface-active": "#e0cfa8",
      "--ex-panel": "#e3d6ba",
      "--ex-border": "#cdbc9a",
      "--ex-border-strong": "#b19f7a",
      "--ex-card": "#d8caa6",
      "--ex-text-body": "#3a2f1f",
      "--ex-text-soft": "#5c4d35",
      "--ex-text-dim": "#7a6848",
      "--ex-text-faint": "#9a8760",
      "--ex-label": "#4a3c28",
      "--ex-label-active": "#201808",
      "--ex-glow": glowFrom("#eadfc6"),
      "--ex-accent": "#8a5f2a",
      "--ex-accent-border": "#6b4a1e",
      "--ex-on-accent": "#fff",
      ...MARKS_LIGHT_BG,
      // (A per-control-cluster "clearing" halo was tried and REMOVED — its
      // rectangular sources banded visibly; user 2026-08-25. The clean strip
      // lanes carry the legibility instead.)
      // Three layers: vignette, the ONE cover image of stains + foxing, the
      // repeating grain tile — repeat and size lists correspond per layer.
      "--ex-texture":
        "radial-gradient(120% 90% at 50% 50%, rgba(0,0,0,0) 58%, rgba(82,60,32,0.14) 100%), " +
        `url("${PARCHMENT_STAINS}"), url("${PARCHMENT_GRAIN}")`,
      "--ex-texture-repeat": "no-repeat, no-repeat, repeat",
      "--ex-texture-size": "auto, cover, auto",
      "--ex-font":
        "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, 'Times New Roman', serif",
      // The switch strap's leather (optional tokens, like the texture above):
      // burnished edges, the stretched blotch layer, the grain tile, a
      // saddle-tan base; buttons get aged paper so the placeholder initials —
      // and later the portrait excerpts — sit like labels sewn onto the strap.
      "--ex-strap-bg":
        "linear-gradient(90deg, rgba(26,14,4,0.5), rgba(26,14,4,0) 26%, rgba(26,14,4,0) 74%, rgba(26,14,4,0.5)), " +
        `url("${LEATHER_BLOTCH}") center top / 100% 1024px repeat, ` +
        `url("${PARCHMENT_LEATHER}"), linear-gradient(180deg, #6a4423, #553318)`,
      "--ex-strap-btn": "rgba(238,226,200,0.92)",
      // The stitching threads (medallions, arrows, and every control button):
      // leather-brown on resting paper surfaces, pale on filled bronze ones.
      "--ex-thread": "rgba(90,58,32,0.5)",
      "--ex-thread-accent": "rgba(255,243,224,0.5)",
      // The magnifying-glass marker (?marker=glass): aged glass with a faint
      // amber cast, and a saddle-leather grip (the strap's leather family) so
      // the handle reads as wrapped leather between its brass fittings. The
      // metal is the accent — bronze was chosen for exactly this (see the
      // palette note above); other themes keep the neutral fallbacks.
      "--ex-marker-lens": "rgba(238, 226, 200, 0.3)",
      "--ex-marker-handle": "#5f3c1d",
      // The middle band as draped cloth (user, 2026-08-26): the active-
      // waveform gold with a vertical sheen, and shadows falling from its
      // long edges onto the straps it physically crosses.
      "--ex-band-drape": "linear-gradient(180deg, #ead9b4, #e0cfa8 30%, #d5c090)",
      "--ex-band-shadow": "0 5px 12px rgba(46,33,16,0.35), 0 -5px 12px rgba(46,33,16,0.35)",
    },
    // Iron-gall ink: aged-but-legible strokes on the resting strips (the
    // within-pane contrast ruling, eyeballed 2026-08-25), near-black ink on
    // the audible one.
    wave: {
      wave: "#8a7452",
      waveActive: "#463a26",
      progress: "#6f5c3e",
      progressActive: "#2e2418",
      cursor: "#2e2418",
    },
    // Historical pigments on cream, divergence-first: indigo, madder,
    // verdigris, umber, iron-violet, ochre, prussian, dragon's blood, olive,
    // walnut, slate, faded rose.
    series: [
      "#33507d", "#a03a2e", "#3d7a5c", "#6b4a2a", "#5a4a7d", "#a87f1f",
      "#2e5d6b", "#8a2e4a", "#6b7a2e", "#7a5c3d", "#566070", "#a06a72",
    ],
  },

  solarized: {
    label: "Solarized",
    tokens: {
      "--ex-bg": "#fdf6e3",
      "--ex-text": "#073642",
      "--ex-surface": "#eee8d5",
      "--ex-surface-active": "#e3dcc8",
      "--ex-panel": "#eee8d5",
      "--ex-border": "#e3dcc8",
      "--ex-border-strong": "#cdc9b8",
      "--ex-card": "#e3dcc8",
      "--ex-text-body": "#2c4a52",
      "--ex-text-soft": "#586e75",
      "--ex-text-dim": "#657b83",
      "--ex-text-faint": "#839496",
      "--ex-label": "#586e75",
      "--ex-label-active": "#073642",
      "--ex-glow": glowFrom("#fdf6e3"),
      "--ex-accent": "#2aa198",
      "--ex-accent-border": "#1f7d76",
      "--ex-on-accent": "#fff",
      ...MARKS_LIGHT_BG,
    },
    wave: {
      wave: "#93a1a1",
      waveActive: "#2aa198",
      progress: "#657b83",
      progressActive: "#1f7d76",
      cursor: "#073642",
    },
    // Solarized's own accent set, divergence-first, then tints.
    series: [
      "#268bd2", "#cb4b16", "#859900", "#d33682", "#2aa198", "#dc322f",
      "#6c71c4", "#b58900", "#3f9fb0", "#c46a3a", "#94a83a", "#c45a94",
    ],
  },

  peach: {
    label: "Peach",
    tokens: {
      "--ex-bg": "#fff3ed",
      "--ex-text": "#4a1f0a",
      "--ex-surface": "#ffe8dc",
      "--ex-surface-active": "#ffd9c6",
      "--ex-panel": "#ffe8dc",
      "--ex-border": "#ffd4c0",
      "--ex-border-strong": "#f5b89a",
      "--ex-card": "#ffd4c0",
      "--ex-text-body": "#5e2c12",
      "--ex-text-soft": "#7a3c20",
      "--ex-text-dim": "#a05840",
      "--ex-text-faint": "#c87860",
      "--ex-label": "#7a3c20",
      "--ex-label-active": "#2e1204",
      "--ex-glow": glowFrom("#fff3ed"),
      "--ex-accent": "#c05030",
      "--ex-accent-border": "#a03820",
      "--ex-on-accent": "#fff",
      ...MARKS_LIGHT_BG,
    },
    wave: {
      wave: "#d89a80",
      waveActive: "#c05030",
      progress: "#b06a4c",
      progressActive: "#a03820",
      cursor: "#4a1f0a",
    },
    series: [
      "#1f6b8a", "#7d8a1f", "#8a2e6b", "#1f8a72", "#a8552e", "#6a48b0",
      "#b08814", "#b03a4f", "#4a6a9a", "#6b7d3a", "#a05a8a", "#6b5c50",
    ],
  },
};

/**
 * Extra variants beyond the palettes, for the two categories committees argue
 * about most. Mid-tone choices that survive on light and dark canvases alike.
 */
export const WAVE_EXTRAS = {
  ice: {
    wave: "#5a6b7e",
    waveActive: "#7fd4ff",
    progress: "#43505f",
    progressActive: "#3fa8e0",
    cursor: "#eaf6ff",
  },
  amber: {
    wave: "#6b5f4a",
    waveActive: "#ffb347",
    progress: "#4a4236",
    progressActive: "#d98e2b",
    cursor: "#fff3e0",
  },
  emerald: {
    wave: "#4f6b58",
    waveActive: "#4fd48f",
    progress: "#3a4f41",
    progressActive: "#2fa868",
    cursor: "#eafff3",
  },
  mono: {
    wave: "#808088",
    waveActive: "#e8e8f0",
    progress: "#55555c",
    progressActive: "#b0b0b8",
    cursor: "#fff",
  },
};

export const ACCENT_EXTRAS = {
  royal: { "--ex-accent": "#5a4a9f", "--ex-accent-border": "#8f7fd4", "--ex-on-accent": "#fff" },
  wine: { "--ex-accent": "#7a2e3e", "--ex-accent-border": "#c05a6e", "--ex-on-accent": "#fff" },
  teal: { "--ex-accent": "#1f6f6a", "--ex-accent-border": "#3fa8a0", "--ex-on-accent": "#fff" },
  amber: { "--ex-accent": "#9a6b1f", "--ex-accent-border": "#d9a53e", "--ex-on-accent": "#fff" },
};

/** Which tokens each CSS category owns — the slicing that makes mixing work. */
const CATEGORY_SLICES = {
  canvas: ["--ex-bg", "--ex-text", "--ex-texture", "--ex-texture-repeat", "--ex-texture-size"],
  strips: ["--ex-surface", "--ex-surface-active", "--ex-mark", "--ex-mark-dim"],
  captions: ["--ex-label", "--ex-label-active", "--ex-glow"],
  text: ["--ex-text-body", "--ex-text-soft", "--ex-text-dim", "--ex-text-faint", "--ex-font"],
  // The strap and thread tokens are OPTIONAL (see the header): only parchment
  // carries them; every other palette leaves the fallbacks (panel, card,
  // invisible threads).
  controls: [
    "--ex-panel",
    "--ex-border",
    "--ex-border-strong",
    "--ex-card",
    "--ex-strap-bg",
    "--ex-strap-btn",
    "--ex-thread",
    "--ex-thread-accent",
    "--ex-marker-lens",
    "--ex-marker-handle",
    "--ex-band-drape",
    "--ex-band-shadow",
  ],
  accent: ["--ex-accent", "--ex-accent-border", "--ex-on-accent"],
};

/**
 * The band's own tokens, mapped from a palette's generic ones. Their :root
 * defaults chain with var() to the generic tokens, so an unpinned band follows
 * whatever the rest of the theme does; pinning writes concrete values here.
 */
const BAND_MAP = {
  "--ex-band-bg": "--ex-panel",
  "--ex-band-border": "--ex-border",
  "--ex-band-card": "--ex-card",
  "--ex-band-text": "--ex-text",
  "--ex-band-text-soft": "--ex-text-soft",
  "--ex-band-faint": "--ex-text-faint",
};

/** Category ids in panel order, with their config keys derived as theme<Cap>. */
export const CATEGORY_KEYS = [
  "canvas",
  "strips",
  "waves",
  "captions",
  "text",
  "controls",
  "accent",
  "band",
];

/** The variant names one category may be pinned to (study panel options). */
export function categoryOptions(cat) {
  const palettes = Object.keys(PALETTES);
  if (cat === "waves") return [...palettes, ...Object.keys(WAVE_EXTRAS)];
  if (cat === "accent") return [...palettes, ...Object.keys(ACCENT_EXTRAS)];
  return palettes;
}

const _configKey = (cat) => "theme" + cat[0].toUpperCase() + cat.slice(1);

/**
 * Resolve the preset plus any per-category pins, write the CSS tokens, and
 * return the waveform colours. Unknown names warn and fall back, because a
 * typo'd query param should degrade to the real exhibit rather than a broken
 * one. Categories that resolve to "dark" are skipped — the :root defaults ARE
 * dark — which keeps the shipped look at zero inline tokens.
 *
 * @param {object} config  the resolved exhibit config (readConfig())
 */
export function applyTheme(config) {
  let presetName = config.theme;
  if (!PALETTES[presetName]) {
    console.warn(`exhibit: unknown theme "${presetName}" — using dark`);
    presetName = "dark";
  }
  const root = document.documentElement.style;

  const resolve = (cat) => {
    const pin = config[_configKey(cat)];
    if (!pin) return presetName;
    if (categoryOptions(cat).includes(pin)) return pin;
    console.warn(`exhibit: unknown ${_configKey(cat)} "${pin}" — following the preset`);
    return presetName;
  };

  for (const [cat, slice] of Object.entries(CATEGORY_SLICES)) {
    const name = resolve(cat);
    const extra = cat === "accent" ? ACCENT_EXTRAS[name] : null;
    if (extra) {
      for (const token of slice) root.setProperty(token, extra[token]);
    } else if (name !== "dark") {
      for (const token of slice) {
        const value = PALETTES[name].tokens[token];
        // Optional tokens (see the header): a palette that does not carry one
        // must LEAVE the :root default, not write "undefined" over it.
        if (value != null) root.setProperty(token, value);
      }
    }
  }

  // The band only gets concrete values when explicitly pinned — otherwise its
  // var() defaults follow the applied theme (see BAND_MAP).
  if (config[_configKey("band")]) {
    const name = resolve("band");
    for (const [bandToken, source] of Object.entries(BAND_MAP)) {
      root.setProperty(bandToken, PALETTES[name].tokens[source]);
    }
  }

  const waveName = resolve("waves");
  return WAVE_EXTRAS[waveName] || PALETTES[waveName].wave;
}

/** The preset's diverging annotation series (see each palette's `series`). */
export function annotationSeries(config) {
  const name = PALETTES[config.theme] ? config.theme : "dark";
  return PALETTES[name].series;
}

/**
 * Replace AUTHORED annotation and group colours with the theme's diverging
 * series (`?annotationColors=theme`). Returns shallow COPIES — the payload's
 * own objects are never mutated, and switching back to authored is just not
 * calling this.
 *
 * Slot assignment, deliberately: the audience's annotations take the FRONT of
 * the series (index = position in the list, so the strongest divergence goes
 * to the colours actually on screen), and each annotation's groups continue
 * AFTER the annotation block. Groups are only visible for the focused
 * annotation, so different annotations' groups may share slots — but a group
 * colour can never collide with an annotation colour, which matters because
 * region fills (annotation-coloured) and strip edges (group-coloured) sit on
 * the same strips at the same time.
 */
export function recolorAnnotations(annotations, series) {
  const n = annotations.length;
  return annotations.map((ann, i) => ({
    ...ann,
    color: series[i % series.length],
    grouping: ann.grouping
      ? {
          ...ann.grouping,
          groups: (ann.grouping.groups || []).map((g, j) => ({
            ...g,
            color: series[(n + j) % series.length],
          })),
        }
      : ann.grouping,
  }));
}
