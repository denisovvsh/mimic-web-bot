function uniqueAttrSelector(el) {
  const attrs = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label'];
  for (const attr of attrs) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const selector = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
    if (document.querySelectorAll(selector).length === 1) return selector;
  }
  return '';
}

export function pathMatchesSelector(relativePath, selector) {
  const relative = String(relativePath || '').trim();
  const target = String(selector || '').trim();
  if (!relative || !target) return false;
  if (target === relative) return true;
  const targetParts = target.split(/\s*>\s*/).filter(Boolean);
  if (targetParts.length < 2) return false;
  return relative.endsWith(` > ${target}`) || target.endsWith(` > ${relative}`);
}

export function pathFromAncestor(ancestor, node) {
  if (!ancestor || !node || ancestor === node) return '';
  const parts = [];
  let current = node;
  while (current && current !== ancestor) {
    const parent = current.parentElement;
    if (!parent) return '';
    let part = current.tagName.toLowerCase();
    const same = [...parent.children].filter((child) => child.tagName === current.tagName);
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
    parts.unshift(part);
    if (parts.length > 30) return '';
    current = parent;
  }
  return current === ancestor ? parts.join(' > ') : '';
}

export function findWithin(root, selector) {
  const value = String(selector || '').trim();
  if (!value || !root) return null;
  try {
    if (root !== document && typeof root.matches === 'function' && root.matches(value)) return root;
  } catch {
    return undefined;
  }
  try {
    const direct = root.querySelector(value);
    if (direct) return direct;
  } catch {
    return undefined;
  }
  if (typeof root.querySelectorAll !== 'function') return null;
  let best = null;
  let bestLength = 0;
  for (const node of root.querySelectorAll('*')) {
    const relative = pathFromAncestor(root, node);
    if (!pathMatchesSelector(relative, value)) continue;
    if (relative.length <= bestLength) continue;
    best = node;
    bestLength = relative.length;
  }
  return best;
}

export function uniqueSelector(el) {
  try {
    return buildSelector(el);
  } catch {
    return '';
  }
}

function buildSelector(el) {
  if (!(el instanceof Element) || !el.isConnected) return '';
  if (el.id) {
    const byId = `#${CSS.escape(el.id)}`;
    if (document.querySelectorAll(byId).length === 1) return byId;
  }
  const byAttr = uniqueAttrSelector(el);
  if (byAttr) return byAttr;

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    const candidate = parts.join(' > ');
    if (document.querySelectorAll(candidate).length === 1) return candidate;
    node = node.parentElement;
  }
  return parts.join(' > ');
}
