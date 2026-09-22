export const CHAT_MODEL = 'google/gemma-4-31b-it';
export const STT_MODEL = 'openai/whisper-large-v3';

export function buildChatBody({ model, messages }) {
  return {
    model: model || CHAT_MODEL,
    messages,
    reasoning: { effort: 'none' },
    provider: {
      sort: 'throughput',
      require_parameters: true,
    },
  };
}

export function relaxChatBody(body, stage) {
  const next = {
    ...body,
    provider: body.provider ? { ...body.provider } : undefined,
  };
  if (stage === 1) {
    if (!next.provider || next.provider.require_parameters !== true) return null;
    next.provider.require_parameters = false;
    return next;
  }
  if (stage === 2) {
    if (!next.provider) return null;
    delete next.provider;
    return next;
  }
  return null;
}

export function isNoEndpointsError(status, body) {
  if (status !== 404) return false;
  const message = body?.error?.message || body?.error || '';
  return /no endpoints found/i.test(String(message));
}

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((part) => textOf(part?.text ?? part)).filter(Boolean).join('\n').trim();
  }
  return '';
}

export function extractChatText(body) {
  const message = body?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') return '';
  const content = textOf(message.content);
  if (content) return content;
  const reasoning = textOf(message.reasoning);
  if (reasoning) return reasoning;
  if (!Array.isArray(message.reasoning_details)) return '';
  return message.reasoning_details
    .map((part) => textOf(part?.text ?? part?.content ?? part))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const step = 0x4000;
  for (let i = 0; i < arr.length; i += step) {
    binary += String.fromCharCode(...arr.subarray(i, i + step));
  }
  return btoa(binary);
}

async function readJson(response) {
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { ok: response.ok, status: response.status, body };
}

async function postChat(apiKey, payload) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const result = await readJson(response);
  if (!result.ok) {
    const error = new Error(result.body?.error?.message || `OpenRouter ${result.status}`);
    error.status = result.status;
    error.body = result.body;
    throw error;
  }
  return result.body;
}

export async function completeChat({ apiKey, model, prompt, data }) {
  let payload = buildChatBody({
    model,
    messages: [
        { role: 'system', content: prompt || 'Обработай JSON.' },
      { role: 'user', content: JSON.stringify(data) },
    ],
  });
  for (let stage = 0; stage <= 2; stage += 1) {
    try {
      const body = await postChat(apiKey, payload);
      return extractChatText(body);
    } catch (error) {
      const relaxed = stage < 2 && isNoEndpointsError(error.status, error.body)
        ? relaxChatBody(payload, stage + 1)
        : null;
      if (!relaxed) throw error;
      payload = relaxed;
    }
  }
  return '';
}

export function whisperLanguage(language) {
  const code = String(language ?? '').trim();
  return code || 'ru';
}

export async function transcribe({ apiKey, model, bytes, language }) {
  const payload = {
    model: model || STT_MODEL,
    input_audio: {
      data: bytesToBase64(bytes),
      format: 'webm',
    },
    language: whisperLanguage(language),
  };
  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const result = await readJson(response);
  if (!result.ok) {
    throw new Error(result.body?.error?.message || `OpenRouter STT ${result.status}`);
  }
  return String(result.body?.text || '');
}
