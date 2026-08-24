// exhibit/audience.js
//
// The audience store, and the three-way switch that writes to it.
//
// WHY A STORE AND NOT A VARIABLE. Everything reads audience: annotation filtering
// now, and the four discographic views plus the quizzes later (plan §6.3). A store
// that many views subscribe to is cheap to introduce and expensive to retrofit, so
// it exists from week 1 even though today it has exactly one subscriber.
//
// WHY IT IS KEYED BY VIEWPORT. Audience is resolved PER VIEWPORT, not globally: two
// people sit on opposite sides of the same table and one of them is a child. A
// global "current mode" would be the same design error as a global "current
// language", and both are ruled out by the sharing-boundary table in §6.3. That is
// also why the payload is one merged set filtered per viewport rather than three
// payloads swapped at runtime (§5.3) — there is no single moment at which the
// exhibit is in kids mode.
//
// WHERE THE SWITCH GOES is explicitly a museum-feedback and user-study question, so
// the control is built provisional and easy to move: it renders into whatever
// element it is handed, and the labels are catalogue lookups whose wording is
// expected to change (see strings.js on `audience.expert` staying keyed on the
// payload's id while it displays as "Scholars").

import { t } from "./strings.js";

/** Per-viewport audience, with subscribe. Small on purpose; see the header. */
export class AudienceStore {
  /**
   * @param {string[]} initial      one audience id per viewport
   * @param {string[]} audiences    the ids this build offers, in switch order
   */
  constructor(initial, audiences) {
    this.audiences = audiences;
    this._byViewport = initial.map((id) => (audiences.includes(id) ? id : audiences[0]));
    this._listeners = new Set();
  }

  get(viewport) {
    // Falling back to viewport 0's value rather than to a hardcoded default keeps
    // a misconfigured `?viewports=3&audiences=kids,adults` coherent instead of
    // half-configured, which is the same rule config.js applies to rotations.
    return this._byViewport[viewport] ?? this._byViewport[0];
  }

  set(viewport, id) {
    if (!this.audiences.includes(id)) {
      console.warn(`exhibit: unknown audience "${id}"`);
      return;
    }
    if (this._byViewport[viewport] === id) return;
    this._byViewport[viewport] = id;
    for (const fn of this._listeners) {
      try {
        fn(viewport, id);
      } catch (e) {
        console.warn("exhibit audience: subscriber threw", e);
      }
    }
  }

  /** @returns {() => void} unsubscribe */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** A snapshot, for the test hook and for debugging. */
  all() {
    return this._byViewport.slice();
  }
}

/**
 * Render the three-way switch for one viewport.
 *
 * @param {object} opts
 * @param {number} opts.viewport
 * @param {AudienceStore} opts.store
 * @param {string} opts.language    resolved per viewport, hence passed explicitly
 * @returns {HTMLElement}
 */
export function buildAudienceSwitch({ viewport, store, language }) {
  const bar = document.createElement("div");
  bar.className = "audience-switch";
  bar.dataset.viewport = String(viewport);

  const buttons = new Map();
  for (const id of store.audiences) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "audience-btn";
    b.dataset.audience = id;
    b.textContent = t("audience." + id, language);
    // Finger-sized hit targets are a week-2 item for the iPad, but the switch is
    // the first thing a visitor touches, so it gets them now (see exhibit.css).
    b.addEventListener("click", () => store.set(viewport, id));
    bar.appendChild(b);
    buttons.set(id, b);
  }

  const paint = () => {
    const current = store.get(viewport);
    for (const [id, b] of buttons) {
      const on = id === current;
      b.classList.toggle("is-on", on);
      // The state is in the DOM as well as in the class, so a Playwright check
      // asserts what a screen reader would read rather than what we styled.
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  paint();
  // The switch redraws on ANY viewport's change, not only its own: nothing today
  // makes one half's mode depend on the other's, but this costs one comparison and
  // means a future "both sides follow the same guide" policy has nowhere to hide a
  // stale button.
  store.subscribe(paint);

  return bar;
}
