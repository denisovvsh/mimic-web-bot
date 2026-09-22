export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

export function fitCaption(reason, url) {
  const link = `<a href="${escapeAttr(url)}">открыть вкладку</a>`;
  let text = escapeHtml(reason || 'Сбой автоматизации');
  let caption = `${text}\n${link}`;
  if (caption.length <= 1024) return caption;
  const budget = 1024 - link.length - 2;
  text = `${text.slice(0, Math.max(0, budget - 1))}…`;
  caption = `${text}\n${link}`;
  return caption.slice(0, 1024);
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

export async function sendMessage(token, chatId, text) {
  let last;
  for (const part of splitTelegramText(text)) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
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
