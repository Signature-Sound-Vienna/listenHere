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
