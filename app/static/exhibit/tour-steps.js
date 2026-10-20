// exhibit/tour-steps.js
//
// The exhibit's tour as DATA (roadmap 27; the drawing is ../js/tour/tour.js,
// shared with the listen interface). Four fragments:
//
//   arrival    — auto-started on the touch that lowers the attract band, on the
//                half that was touched: the concept, the stripes, the switch,
//                the audience switch, the chips, the way into the explorers.
//   listening  — the toolbar's "?": stripes, switch, strap, zoom.
//   reading    — the annotation panel's "?": audience, chips.
//   exploring  — the explorer overlay's "?": the explorer, and Back.
//
// EVERY FRAGMENT ENDS THE SAME WAY (user, 2026-09-23): "tap ? to see these
// hints again", pointing at the "?" that runs this very fragment — never "the
// tour ends here". Without the buttons (?tour=arrival) the closing card is
// centred and says the same.
//
// A target that is not on this table (no strap, no zoom buttons, explorers not
// configured) makes the step vanish rather than point at nothing — tour.js
// drops such steps when the fragment starts, so the dots count what the
// visitor will see. Text keys resolve through the host's resolver, which picks
// the kids variant where the reader's audience is "kids" and a `.kids` key
// exists (strings.js).
//
// ZERO imports, like strings.js: the host passes what a target needs.

/**
 * @param {object} opts
 * @param {{ el: HTMLElement, index: number }} opts.vp   the viewport
 * @param {object} opts.config
 * @param {() => string} opts.activeName   the audible recording's label
 */
export function buildTourSteps({ vp, config, activeName }) {
  const q = (selector) => () => vp.el.querySelector(selector);
  const explorersOn = () => Boolean(config.viewSwitch) || (config.bandTap && config.bandTap !== "off");
  const buttonsOn = config.tour === "buttons" || config.tour === "both";
  // The closing step's target: this fragment's own "?", when there is one.
  const closing = (selector) => (buttonsOn ? q(selector) : null);
  // This reader's copy of the band's facts: under the mirrored band the
  // clusters are one per reader in viewport order (middle-band.js); a single
  // cluster is everybody's.
  const bandCluster = () => {
    const clusters = document.querySelectorAll(".middle-band .mb-cluster");
    if (!clusters.length) return null;
    return clusters.length === 1 ? clusters[0] : (clusters[vp.index] ?? clusters[0]);
  };

  return [
    { id: "intro", fragment: ["arrival"], target: null, title: "tour.intro.title", body: "tour.intro", complete: "next" },
    {
      id: "stripes",
      fragment: ["arrival", "listening"],
      target: q(".strips"),
      body: "tour.stripes",
      vars: () => ({ name: activeName() }),
      complete: "next",
      // The loop sits at the reader's LEFT, round what names the stripes: the
      // medallion rail (when there is one) and the captions, the strips' full
      // height (user, 2026-09-23) — not a patch in the waveforms' middle.
      loopBox: ({ rectOf }) => {
        const strips = vp.el.querySelector(".strips");
        if (!strips) return null;
        const s = rectOf(strips);
        const strap = vp.el.querySelector(".vp-strap");
        const label = vp.el.querySelector(".strip .strip-label");
        const left = strap ? Math.min(s.left, rectOf(strap).left) : s.left;
        const lr = label ? rectOf(label) : null;
        const right = lr ? lr.left + lr.width + 12 : s.left + Math.min(340, s.width);
        // Half again as wide as the captions need (user, 2026-09-23), so the loop
        // takes in the start of the waveforms too.
        const width = Math.min(Math.max(120, right - left) * 1.5, s.left + s.width - left);
        return { left, top: s.top, width, height: s.height };
      },
    },
    {
      id: "switch",
      fragment: ["arrival", "listening"],
      target: q(".strips"),
      body: "tour.switch",
      complete: { signal: "switched" },
      variants: { requested: "tour.switch.requested", denied: "tour.switch.denied" },
    },
    {
      // The listening marker (marker.js): the glass on its hook. Completes when
      // the visitor places it — a drag onto a stripe, or a lift and a tap.
      id: "marker",
      fragment: ["arrival", "listening"],
      target: q(".marker-glass"),
      body: "tour.marker",
      complete: { signal: "marked" },
    },
    { id: "strap", fragment: ["listening"], target: q(".vp-strap"), body: "tour.strap", complete: "next" },
    { id: "zoom", fragment: ["listening"], target: q(".zoom-ctl"), body: "tour.zoom", complete: "next" },
    {
      id: "audience",
      fragment: ["arrival", "reading"],
      target: q(".audience-switch"),
      body: "tour.audience",
      complete: { signal: "audience" },
    },
    { id: "chips", fragment: ["arrival", "reading"], target: q(".ann-chips"), body: "tour.chips", complete: { signal: "shown" } },
    {
      id: "explore",
      fragment: ["arrival"],
      target: () => (explorersOn() ? bandCluster() : null),
      body: "tour.explore",
      complete: { signal: "view" },
    },
    { id: "explorer", fragment: ["exploring"], target: q(".vp-view"), body: "tour.explorer", complete: "next" },
    { id: "back", fragment: ["exploring"], target: q(".view-back"), body: "tour.back", complete: "next" },
    // The closing steps, one per fragment, each pointing at its own "?".
    { id: "done", fragment: ["arrival", "listening"], target: closing(".vp-help"), body: "tour.done", complete: "next" },
    { id: "done", fragment: ["reading"], target: closing(".ann-help"), body: "tour.done", complete: "next" },
    { id: "done", fragment: ["exploring"], target: closing(".view-help"), body: "tour.done", complete: "next" },
  ];
}
