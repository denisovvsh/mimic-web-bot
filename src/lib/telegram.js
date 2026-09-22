export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

export function pageLinkLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url || '');
  }
}

export function appendPageLink(text, url) {
  const body = escapeHtml(text);
  const href = String(url || '').trim();
  if (!href) return splitTelegramText(body);
  const link = `<a href="${escapeAttr(href)}">${escapeHtml(pageLinkLabel(href))}</a>`;
  if (link.length > TELEGRAM_MESSAGE_LIMIT) return splitTelegramText(body);
  if (!body) return [link];
  const room = TELEGRAM_MESSAGE_LIMIT - link.length - 1;
  if (room < 1) return splitTelegramText(body);
  if (body.length + 1 + link.length <= TELEGRAM_MESSAGE_LIMIT) return [`${body}\n${link}`];
  const parts = [];
  for (let index = 0; index < body.length; index += room) {
    const chunk = body.slice(index, index + room);
    const last = index + room >= body.length;
    parts.push(last ? `${chunk}\n${link}` : chunk);
  }
  return parts;
}

function captionLink(url, label) {
  return `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`;
}

export function fitCaption(reason, url) {
  const href = String(url || '');
  let link = '';
  if (href) {
    link = captionLink(href, pageLinkLabel(href) || 'открыть вкладку');
    if (link.length > 980) link = captionLink(href, 'открыть вкладку');
    if (link.length > 1024) link = '';
  }
  let text = escapeHtml(reason || 'Сбой автоматизации');
  if (!link) return text.slice(0, 1024);
  const budget = 1024 - link.length - 1;
  if (text.length > budget) text = budget > 1 ? `${text.slice(0, budget - 1)}…` : '';
  return text ? `${text}\n${link}` : link;
}

async function readTelegram(response) {
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram ${response.status}`);
  }
  return data;
}

const TELEGRAM_MESSAGE_LIMIT = 4096;

export function splitTelegramText(text) {
  const full = String(text ?? '');
  if (full.length <= TELEGRAM_MESSAGE_LIMIT) return [full];
  const parts = [];
  for (let index = 0; index < full.length; index += TELEGRAM_MESSAGE_LIMIT) {
    parts.push(full.slice(index, index + TELEGRAM_MESSAGE_LIMIT));
  }
  return parts;
}

export async function sendMessage(token, chatId, text, options = {}) {
  const url = options.url || '';
  const parts = url ? appendPageLink(text, url) : splitTelegramText(text);
  let last;
  for (const part of parts) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
        ...(url ? { parse_mode: 'HTML' } : {}),
      }),
    });
    last = await readTelegram(response);
  }
  return last;
}

export async function sendDocument(token, chatId, { filename, bytes, mime, caption }) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, 1024));
    form.append('parse_mode', 'HTML');
  }
  form.append('document', new Blob([bytes], { type: mime || 'application/octet-stream' }), filename);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  return readTelegram(response);
}

export async function sendPhoto(token, chatId, { bytes, caption }) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'fail.jpg');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  return readTelegram(response);
}
