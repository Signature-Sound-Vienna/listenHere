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
