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

export function uniqueSelector(el) {
  if (!(el instanceof Element)) return '';
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
