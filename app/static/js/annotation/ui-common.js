// V6 annotation — small DOM helpers shared across ui-* modules.

/**
 * Lightweight createElement helper.
 *   el('div', { class: 'foo', onclick: handler }, ['child', el('span', { text: 'x' })])
 *
 * Special attribute keys:
 *   class / className   → element.className
 *   dataset             → Object.assign(element.dataset, value)
 *   style (object)      → Object.assign(element.style, value)
 *   text                → textContent
 *   html                → innerHTML
 *   value / checked /
 *   disabled / selected → set as property (not attribute)
 *   on*                 → addEventListener
 *
 * Children may be strings, Nodes, or falsy values (skipped).
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "class" || k === "className") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected")
      node[k] = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === "string" || typeof c === "number")
      node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
  return node;
}

export function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Three dot spans wrapped in a container. CSS gives each :nth-child its own
 * translateY animation phase so the dots appear to bounce in sequence.
 * Used for in-flight progress text in the drawer's publish bar and the
 * load-from-Solid modal.
 */
export function bouncingDots() {
  return el("span", { class: "lh-v6-dots", "aria-hidden": "true" }, [
    el("span", { class: "lh-v6-dot", text: "." }),
    el("span", { class: "lh-v6-dot", text: "." }),
    el("span", { class: "lh-v6-dot", text: "." }),
  ]);
}

/**
 * Set a status-line node's content from a plain string, swapping a trailing
 * "…" (or "...") for animated bouncing dots so in-flight messages have a
 * subtle motion cue. Terminal-state strings (no trailing ellipsis) render
 * as plain text.
 */
export function setStatusText(node, text) {
  clearChildren(node);
  const m = text.match(/^([\s\S]*?)(…|\.\.\.)\s*$/);
  if (m) {
    if (m[1]) node.appendChild(document.createTextNode(m[1]));
    node.appendChild(bouncingDots());
  } else {
    node.textContent = text;
  }
}

/**
 * If a recording about to be removed from an annotation has a non-empty
 * per-recording note, prompt before discarding it. Returns true if it's
 * safe to proceed (no note, or user confirmed), false if the user
 * cancelled. Uses window.confirm — short, one-shot, doesn't warrant the
 * styled confirm modal.
 */
export function confirmRemoveIfTextful(description) {
  if (!description || !description.trim()) return true;
  const trimmed = description.trim();
  const preview = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
  return window.confirm(
    'This recording has a note attached:\n\n"' +
      preview +
      '"\n\nRemove the recording from this annotation? The note will be discarded.',
  );
}

/**
 * Custom confirmation dialog for destructive pod-side actions. Returns a
 * Promise that resolves to true if the user clicks Delete, false otherwise
 * (Cancel, backdrop click, or Escape). Layered above other modals (high
 * z-index) and visually alarming so a misclick stands out. Caller passes
 * the annotation title for the bold callout.
 */
export function confirmDeleteFromPod(title) {
  return new Promise((resolve) => {
    let settled = false;
    function settle(answer) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(answer);
    }
    function onKey(e) {
      if (e.key === "Escape") settle(false);
      else if (e.key === "Enter") settle(true);
    }

    const cancelBtn = el("button", {
      class: "lh-v6-confirm-cancel",
      type: "button",
      text: "Cancel",
      onclick: () => settle(false),
    });
    const deleteBtn = el("button", {
      class: "lh-v6-confirm-delete",
      type: "button",
      text: "Delete from pod",
      onclick: () => settle(true),
    });

    const dialog = el(
      "div",
      { class: "lh-v6-confirm-dialog", role: "alertdialog", "aria-labelledby": "lh-v6-confirm-h" },
      [
        el("div", { class: "lh-v6-confirm-header" }, [
          el("span", { class: "lh-v6-confirm-warning", text: "⚠", "aria-hidden": "true" }),
          el("h2", { id: "lh-v6-confirm-h", class: "lh-v6-confirm-title", text: "Delete this annotation?" }),
        ]),
        el("div", { class: "lh-v6-confirm-body" }, [
          el("p", { class: "lh-v6-confirm-target" }, [
            "You are about to permanently delete ",
            el("strong", { text: '"' + title + '"' }),
            " from your Solid pod.",
          ]),
          el("p", { class: "lh-v6-confirm-detail", text: "This removes the MusicalMaterial, Extract, Selections, and every related OA Annotation. If a local copy is loaded in this session, it will also be removed." }),
          el("p", { class: "lh-v6-confirm-warn", text: "This cannot be undone." }),
        ]),
        el("div", { class: "lh-v6-confirm-actions" }, [cancelBtn, deleteBtn]),
      ],
    );

    const overlay = el(
      "div",
      {
        class: "lh-v6-confirm-overlay",
        onclick: (e) => { if (e.target === overlay) settle(false); },
      },
      dialog,
    );
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    cancelBtn.focus(); // safer default focus than the destructive button
  });
}

/**
 * Confirmation dialog for re-pinning an annotation's grouping to the current
 * application grouping. Renders the diff produced by state.diffGrouping so the
 * change is a deliberate, informed decision. Resolves true to proceed, false
 * to cancel (Cancel, backdrop, or Escape). Enter confirms.
 *
 * `diff` is the object returned by state.diffGrouping; `published` toggles the
 * pod-impact line.
 */
export function confirmRepin(diff, published) {
  return new Promise((resolve) => {
    let settled = false;
    function settle(answer) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(answer);
    }
    function onKey(e) {
      if (e.key === "Escape") settle(false);
      else if (e.key === "Enter") settle(true);
    }

    const lines = [];
    const pushLine = (cls, text) =>
      lines.push(el("li", { class: "lh-v6-repin-line " + cls, text }));

    diff.added.forEach((g) =>
      pushLine("added", "+ New group: " + (g.label || "(untitled)")),
    );
    diff.renamed.forEach((g) =>
      pushLine("renamed", "↻ Renamed: “" + g.from + "” → “" + g.to + "” (note kept)"),
    );
    diff.removed.forEach((g) =>
      pushLine(
        "removed",
        "− Group leaves: “" +
          (g.label || "(untitled)") +
          "”" +
          (g.hasNote ? " — its note moves to “Notes from removed groups”" : ""),
      ),
    );
    diff.affectedComparisons.forEach((c) =>
      pushLine("removed", "− Comparison removed: " + c.left + " vs. " + c.right),
    );
    if (diff.restoredNoteCount > 0) {
      pushLine(
        "added",
        "↩ " +
          diff.restoredNoteCount +
          " previously-removed note(s) re-attach to a returning group",
      );
    }
    if (lines.length === 0) {
      pushLine("neutral", "No group changes — the grouping is already current.");
    }

    const bodyChildren = [
      el("p", {
        class: "lh-v6-confirm-target",
        text: "Re-pin this annotation's grouping to the current view?",
      }),
      el("ul", { class: "lh-v6-repin-list" }, lines),
    ];
    if (published && diff.podDeleteCount > 0) {
      bodyChildren.push(
        el("p", {
          class: "lh-v6-confirm-warn",
          text:
            "On the next Update to Solid, " +
            diff.podDeleteCount +
            " published annotation resource(s) will be deleted from your pod.",
        }),
      );
    }
    bodyChildren.push(
      el("p", {
        class: "lh-v6-confirm-detail",
        text:
          "Recordings, regions and per-recording notes are unaffected. Detached notes stay recoverable until you save over them.",
      }),
    );

    const cancelBtn = el("button", {
      class: "lh-v6-confirm-cancel",
      type: "button",
      text: "Cancel",
      onclick: () => settle(false),
    });
    const okBtn = el("button", {
      class: "lh-v6-confirm-ok",
      type: "button",
      text: "Update grouping",
      onclick: () => settle(true),
    });

    const dialog = el(
      "div",
      { class: "lh-v6-confirm-dialog lh-v6-repin-dialog", role: "alertdialog", "aria-labelledby": "lh-v6-repin-h" },
      [
        el("div", { class: "lh-v6-confirm-header" }, [
          el("span", { class: "lh-v6-confirm-warning", text: "↻", "aria-hidden": "true" }),
          el("h2", { id: "lh-v6-repin-h", class: "lh-v6-confirm-title", text: "Update groups to current view" }),
        ]),
        el("div", { class: "lh-v6-confirm-body" }, bodyChildren),
        el("div", { class: "lh-v6-confirm-actions" }, [cancelBtn, okBtn]),
      ],
    );

    const overlay = el(
      "div",
      {
        class: "lh-v6-confirm-overlay",
        onclick: (e) => { if (e.target === overlay) settle(false); },
      },
      dialog,
    );
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    okBtn.focus();
  });
}
