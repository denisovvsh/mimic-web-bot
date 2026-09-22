export function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
}

function keyEvent(type, key) {
  return new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
}

function pointer(el) {
  const rect = el.getBoundingClientRect();
  return {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
}

export function hover(el) {
  const init = pointer(el);
  el.dispatchEvent(new MouseEvent('mouseenter', init));
  el.dispatchEvent(new MouseEvent('mouseover', init));
}

export function clickLikeUser(el) {
  hover(el);
  const init = pointer(el);
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.click();
}

export async function typeInto(el, text) {
  el.focus();
  const valueText = String(text ?? '');
  if (el.isContentEditable) {
    for (const ch of valueText) {
      await sleep(randInt(70, 200));
      el.dispatchEvent(keyEvent('keydown', ch));
      el.dispatchEvent(keyEvent('keypress', ch));
      el.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: ch,
        inputType: 'insertText',
      }));
      document.execCommand('insertText', false, ch);
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: ch,
        inputType: 'insertText',
      }));
      el.dispatchEvent(keyEvent('keyup', ch));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  let value = '';
  for (const ch of valueText) {
    await sleep(randInt(70, 200));
    el.dispatchEvent(keyEvent('keydown', ch));
    el.dispatchEvent(keyEvent('keypress', ch));
    value += ch;
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: ch,
      inputType: 'insertText',
    }));
    el.dispatchEvent(keyEvent('keyup', ch));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
