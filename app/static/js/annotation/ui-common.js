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
 * The shared shell for the app's styled confirmation dialogs: overlay +
 * alertdialog, icon/title header, caller-supplied body, Cancel/confirm actions.
 * Resolves true on confirm, false on Cancel, backdrop click or Escape.
 *
 * Used by the annotation dialogs below and by listen.js's piece-replacement
 * prompt. It lives here because `el` does; if more non-annotation callers
 * appear it should move to a shared ui module.
 *
 * @param {object} opts
 * @param {string} opts.title          heading text
 * @param {Node[]} opts.body           body children
 * @param {string} [opts.icon]         header glyph (decorative)
 * @param {string} [opts.confirmLabel] confirm button text
 * @param {string} [opts.cancelLabel]  cancel button text
 * @param {string} [opts.confirmClass] confirm button class (styling severity)
 * @param {string} [opts.dialogClass]  extra class on the dialog
 * @param {string} [opts.labelId]      id linking heading to aria-labelledby
 * @param {"confirm"|"cancel"} [opts.focus] which button takes initial focus
 * @param {boolean} [opts.enterConfirms] whether Enter confirms
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title,
  body = [],
  icon = "⚠",
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  confirmClass = "lh-v6-confirm-ok",
  dialogClass = "",
  labelId = "lh-v6-confirm-h",
  focus = "confirm",
  enterConfirms = true,
}) {
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
      else if (e.key === "Enter" && enterConfirms) settle(true);
    }

    // A null or empty cancelLabel makes this an acknowledgement rather than a
    // choice: no cancel button, while the overlay click and Escape still dismiss
    // it (both resolve false, which such a caller ignores).
    const cancelBtn =
      cancelLabel == null || cancelLabel === ""
        ? null
        : el("button", {
            class: "lh-v6-confirm-cancel",
            type: "button",
            text: cancelLabel,
            onclick: () => settle(false),
          });
    const confirmBtn = el("button", {
      class: confirmClass,
      type: "button",
      text: confirmLabel,
      onclick: () => settle(true),
    });

    const dialog = el(
      "div",
      {
        class: ("lh-v6-confirm-dialog " + dialogClass).trim(),
        role: "alertdialog",
        "aria-labelledby": labelId,
      },
      [
        el("div", { class: "lh-v6-confirm-header" }, [
          el("span", {
            class: "lh-v6-confirm-warning",
            text: icon,
            "aria-hidden": "true",
          }),
          el("h2", { id: labelId, class: "lh-v6-confirm-title", text: title }),
        ]),
        el("div", { class: "lh-v6-confirm-body" }, body),
        el(
          "div",
          { class: "lh-v6-confirm-actions" },
          cancelBtn ? [cancelBtn, confirmBtn] : [confirmBtn],
        ),
      ],
    );

    const overlay = el(
      "div",
      {
        class: "lh-v6-confirm-overlay",
        onclick: (e) => {
          if (e.target === overlay) settle(false);
        },
      },
      dialog,
    );
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    (focus === "cancel" && cancelBtn ? cancelBtn : confirmBtn).focus();
  });
}

/**
 * Confirmation dialog for destructive pod-side actions. Visually alarming and
 * defaults focus to Cancel so a misclick stands out. Caller passes the
 * annotation title for the bold callout.
 */
export function confirmDeleteFromPod(title) {
  return confirmDialog({
    title: "Delete this annotation?",
    confirmLabel: "Delete from pod",
    confirmClass: "lh-v6-confirm-delete",
    focus: "cancel",
    body: [
      el("p", { class: "lh-v6-confirm-target" }, [
        "You are about to permanently delete ",
        el("strong", { text: '"' + title + '"' }),
        " from your Solid pod.",
      ]),
      el("p", {
        class: "lh-v6-confirm-detail",
        text: "This removes the MusicalMaterial, Extract, Selections, and every related OA Annotation. If a local copy is loaded in this session, it will also be removed.",
      }),
      el("p", { class: "lh-v6-confirm-warn", text: "This cannot be undone." }),
    ],
  });
}

/**
 * Confirmation dialog for re-pinning an annotation's grouping to the current
 * application grouping. Renders the diff produced by state.diffGrouping so the
 * change is a deliberate, informed decision.
 *
 * `diff` is the object returned by state.diffGrouping; `published` toggles the
 * pod-impact line.
 */
export function confirmRepin(diff, published) {
  const lines = [];
  const pushLine = (cls, text) =>
    lines.push(el("li", { class: "lh-v6-repin-line " + cls, text }));

  diff.added.forEach((g) =>
    pushLine("added", "+ New group: " + (g.label || "(untitled)")),
  );
  diff.renamed.forEach((g) =>
    pushLine(
      "renamed",
      "↻ Renamed: “" + g.from + "” → “" + g.to + "” (note kept)",
    ),
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

  const body = [
    el("p", {
      class: "lh-v6-confirm-target",
      text: "Re-pin this annotation's grouping to the current view?",
    }),
    el("ul", { class: "lh-v6-repin-list" }, lines),
  ];
  if (published && diff.podDeleteCount > 0) {
    body.push(
      el("p", {
        class: "lh-v6-confirm-warn",
        text:
          "On the next Update to Solid, " +
          diff.podDeleteCount +
          " published annotation resource(s) will be deleted from your pod.",
      }),
    );
  }
  body.push(
    el("p", {
      class: "lh-v6-confirm-detail",
      text: "Recordings, regions, and per-recording notes are unaffected. Detached notes stay recoverable until you save over them.",
    }),
  );

  return confirmDialog({
    title: "Update groups to current view",
    icon: "↻",
    body,
    confirmLabel: "Update grouping",
    dialogClass: "lh-v6-repin-dialog",
    labelId: "lh-v6-repin-h",
  });
}
