import { mergeSettings } from '../lib/defaults.js';
import { audioFilename } from '../lib/utterance.js';
import {
  formatClock,
  renderTranscript,
  shouldKeepTranscript,
  transcriptFilename,
} from '../lib/transcript.js';
import { completeChat, transcribe } from '../lib/openrouter.js';
import {
  escapeHtml,
  fitCaption,
  sendDocument,
  sendMessage,
  sendPhoto,
} from '../lib/telegram.js';

const STT_FAIL = '(фрагмент не расшифрован)';
let recording = null;
let mixed = false;
let warnedNoKey = false;
let sessionLoaded = false;
let loadingSession = null;
let transcriptQueue = Promise.resolve();

async function ensureSession() {
  if (sessionLoaded) return;
  if (!loadingSession) {
    loadingSession = chrome.storage.session.get('recordingSession')
      .then((stored) => {
        if (sessionLoaded) return;
        const saved = stored?.recordingSession;
        if (saved?.recording?.tabId) {
          recording = saved.recording;
          mixed = Boolean(saved.mixed);
        }
        sessionLoaded = true;
      })
      .catch(() => {
        sessionLoaded = true;
      });
  }
  await loadingSession;
}

async function persistSession() {
  sessionLoaded = true;
  const recordingSession = recording ? { recording, mixed } : null;
  await chrome.storage.session.set({ recordingSession }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureSession().then(() => {
    if (recording?.tabId === tabId) stopRecording();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  ensureSession().then(() => {
    if (!recording?.tabId) return;
    chrome.tabs.sendMessage(recording.tabId, {
      target: 'telemost',
      type: 'settings',
      settings: changes.settings.newValue,
    }).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== 'worker') return;
  handleMessage(message, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  await ensureSession();
  switch (message?.type) {
    case 'status-get':
      return { ok: true, recording, mixed };
    case 'recording-start':
      return startRecording(message);
    case 'recording-stop':
      return stopRecording();
    case 'capture-ended':
      if (recording) return stopRecording();
      return { ok: true };
    case 'audio-chunk':
      await saveAudioChunk(message);
      return { ok: true };
    case 'fallback-mixed':
      return enableMixed(message.speakers || []);
    case 'speakers':
      if (mixed && recording) {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'speakers',
          speakers: message.speakers || [],
        }).catch(() => {});
      }
      return { ok: true };
    case 'monitor-start':
      await deliverPage(message.tabId, { type: 'monitor-start' });
      return { ok: true };
    case 'monitor-stop':
      await chrome.tabs.sendMessage(message.tabId, { target: 'page', type: 'monitor-stop' }).catch(() => {});
      return { ok: true };
    case 'macro-record-start':
      await deliverPage(message.tabId, { type: 'macro-record-start' });
      return { ok: true };
    case 'macro-record-stop':
      await chrome.tabs.sendMessage(message.tabId, { target: 'page', type: 'macro-record-stop' }).catch(() => {});
      return { ok: true };
    case 'macro-play':
      await deliverPage(message.tabId, { type: 'macro-play' });
      return { ok: true };
    case 'macro-save': {
      const settings = await updateSettings({ macro: Array.isArray(message.steps) ? message.steps : [] });
      await chrome.runtime.sendMessage({ type: 'macro-updated', steps: settings.macro }).catch(() => {});
      return { ok: true };
    }
    case 'pick-start':
      await deliverPage(message.tabId, {
        type: 'pick-start',
        field: message.field,
        featureIndex: message.featureIndex ?? null,
      });
      return { ok: true };
    case 'item-found':
      await onItemFound(message, sender);
      return { ok: true };
    case 'failsafe':
      await onFailsafe(message, sender);
      return { ok: true };
    default:
      return { ok: true };
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return mergeSettings(stored.settings);
}

async function updateSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

async function status(text) {
  await chrome.runtime.sendMessage({ type: 'status', text }).catch(() => {});
}

async function startRecording({ tabId, streamId }) {
  const sessionId = Date.now();
  recording = { sessionId, tabId };
  mixed = false;
  warnedNoKey = false;
  await persistSession();
  await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
  await chrome.action.setBadgeText({ text: 'REC' });
  let heard = Boolean(streamId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/telemost-hook.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/telemost.js'],
    });
    if (streamId) {
      try {
        await ensureOffscreen();
        await sendOffscreen({ type: 'hold', streamId, sessionId });
      } catch (error) {
        heard = false;
        await status(`Проброс звука: ${error.message}`);
      }
    }
    const settings = await getSettings();
    let armed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          target: 'telemost',
          type: 'arm',
          sessionId,
          settings,
        });
        armed = true;
        break;
      } catch (error) {
        lastError = error;
        await delay(80);
      }
    }
    if (!armed) throw lastError || new Error('Вкладка Телемоста не отвечает');
  } catch (error) {
    recording = null;
    mixed = false;
    await persistSession();
    await sendOffscreen({ type: 'stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    await chrome.action.setBadgeText({ text: '' });
    throw error;
  }
  await status(heard ? 'Запись созвона включена' : 'Запись дорожек включена, захват вкладки недоступен');
  return { ok: true, sessionId };
}

async function stopRecording() {
  await ensureSession();
  const current = recording;
  recording = null;
  mixed = false;
  await persistSession();
  await chrome.action.setBadgeText({ text: '' });
  if (current?.tabId) {
    await chrome.tabs.sendMessage(current.tabId, { target: 'telemost', type: 'disarm' }).catch(() => {});
  }
  await sendOffscreen({ type: 'stop' }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
  await status('Запись остановлена');
  return { ok: true };
}

async function enableMixed(speakers) {
  await ensureSession();
  if (!recording) return { ok: false, error: 'Запись не запущена' };
  if (mixed) return { ok: true };
  try {
    await sendOffscreen({
      type: 'record-mixed',
      sessionId: recording.sessionId,
      speakers,
    });
  } catch (error) {
    await status(`Смешанный захват не запустился: ${error.message}`);
    return { ok: false, error: error.message };
  }
  mixed = true;
  await persistSession();
  await chrome.tabs.sendMessage(recording.tabId, {
    target: 'telemost',
    type: 'disarm-tracks',
  }).catch(() => {});
  await status('Один общий аудиотрек: пишу смешанный звук');
  return { ok: true };
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Проброс звука вкладки Телемоста и запасная запись общего потока',
  });
}

async function sendOffscreen(message) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
      if (response?.ok === false) throw new Error(response.error || 'offscreen');
      return response;
    } catch (error) {
      lastError = error;
      await delay(80);
    }
  }
  if (lastError) throw lastError;
}

async function saveAudioChunk(message) {
  if (!message?.buffer) return;
  const bytes = toBytes(message.buffer);
  if (bytes.byteLength < 64) return;
  const sessionId = message.sessionId || recording?.sessionId || Date.now();
  const speaker = message.speaker || 'unknown';
  const filename = audioFilename({
    startedAt: message.startedAt,
    speaker,
    trackId: message.trackId || 'track',
  });
  try {
    await downloadBytes(filename, bytes, 'audio/webm', 'uniquify');
  } catch (error) {
    await status(`Скачивание: ${error.message}`);
  }
  const settings = await getSettings();
  const caption = `${escapeHtml(speaker)} ${formatClock(message.startedAt)}–${formatClock(message.endedAt)}`;
  const telegramTask = (async () => {
    if (!settings.telegramToken || !settings.telegramChatId) return;
    await sendDocument(settings.telegramToken, settings.telegramChatId, {
      filename: filename.split('/').pop(),
      bytes,
      mime: 'audio/webm',
      caption,
    });
  })().catch((error) => status(`Telegram: ${error.message}`));
  const textTask = (async () => {
    if (!settings.openrouterKey) return '';
    return transcribe({
      apiKey: settings.openrouterKey,
      model: settings.sttModel,
      bytes,
      language: settings.sttLanguage,
    });
  })().catch((error) => {
    status(`Расшифровка: ${error.message}`);
    return STT_FAIL;
  });
  const [, text] = await Promise.all([telegramTask, textTask]);
  if (!settings.openrouterKey) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      await status('Нет ключа OpenRouter — текст созвона не пишется');
    }
    return;
  }
  if (text !== STT_FAIL && !shouldKeepTranscript(text)) return;
  await enqueueTranscript(sessionId, {
    start: message.startedAt,
    end: message.endedAt,
    speaker,
    text: text || STT_FAIL,
  });
}

function enqueueTranscript(sessionId, line) {
  transcriptQueue = transcriptQueue
    .then(() => appendTranscript(sessionId, line))
    .catch((error) => status(`Транскрипт: ${error.message}`));
  return transcriptQueue;
}

async function appendTranscript(sessionId, line) {
  const key = `transcript:${sessionId}`;
  const stored = await chrome.storage.local.get(key);
  const lines = Array.isArray(stored[key]) ? stored[key] : [];
  lines.push(line);
  await chrome.storage.local.set({ [key]: lines });
  const text = renderTranscript(lines);
  await downloadBytes(transcriptFilename(sessionId), new TextEncoder().encode(text), 'text/plain', 'overwrite');
}

async function onItemFound(message, sender) {
  const settings = await getSettings();
  let text = JSON.stringify(message.data, null, 2);
  if (settings.aiEnabled) {
    if (!settings.openrouterKey) {
      await status('ИИ включён, но ключ OpenRouter пуст');
    } else {
      try {
        const answer = await completeChat({
          apiKey: settings.openrouterKey,
          model: settings.chatModel,
          prompt: settings.aiPrompt,
          data: message.data,
        });
        if (answer) text = answer;
      } catch (error) {
        await status(`ИИ: ${error.message}`);
      }
    }
  }
  if (settings.telegramToken && settings.telegramChatId) {
    try {
      await sendMessage(settings.telegramToken, settings.telegramChatId, text);
    } catch (error) {
      await status(`Telegram: ${error.message}`);
    }
  } else {
    await status('Карточка найдена, Telegram не настроен');
  }
  if (settings.runMacroOnNewItem && settings.macro.length && sender.tab?.id) {
    await chrome.tabs.sendMessage(sender.tab.id, {
      target: 'page',
      type: 'macro-play',
    }).catch(() => {});
  }
}

async function onFailsafe(message, sender) {
  const tab = sender.tab;
  const settings = await getSettings();
  if (!settings.telegramToken || !settings.telegramChatId) {
    await status(`Сбой: ${message.reason}. Telegram не настроен`);
    return;
  }
  try {
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
    await delay(250);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: 'jpeg', quality: 80 });
    const bytes = dataUrlToBytes(dataUrl);
    const caption = fitCaption(message.reason, tab?.url || message.url || '');
    await sendPhoto(settings.telegramToken, settings.telegramChatId, { bytes, caption });
    await status(`Сбой отправлен в Telegram: ${message.reason}`);
  } catch (error) {
    await status(`Сбой не отправлен: ${error.message}`);
  }
}

async function deliverPage(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/page.js'],
  });
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, { target: 'page', ...message });
    } catch (error) {
      lastError = error;
      await delay(80);
    }
  }
  throw lastError || new Error('Не удалось связаться со страницей');
}

function downloadBytes(filename, bytes, mime, conflictAction) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction, saveAs: false }, (id) => {
      const error = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(url), 20_000);
      if (error) reject(new Error(error.message));
      else resolve(id);
    });
  });
}

function toBytes(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer?.type === 'Buffer' && Array.isArray(buffer.data)) return new Uint8Array(buffer.data);
  return new Uint8Array(buffer);
}

function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
