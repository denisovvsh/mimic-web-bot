import { mergeSettings, migrateRootMonitor, settingsForPage } from '../lib/defaults.js';
import { acceptAudioSession, parentDirectory, sessionPathsText, shouldPublishPaths, toBytes } from '../lib/audio-chunk.js';
import { audioFilename } from '../lib/utterance.js';
import {
  formatClock,
  renderTranscript,
  shouldKeepTranscript,
  transcriptFilename,
} from '../lib/transcript.js';
import { completeChat, transcribe } from '../lib/openrouter.js';
import { samePage } from '../lib/watch.js';
import {
  fitCaption,
  sendDocument,
  sendMessage,
  sendPhoto,
} from '../lib/telegram.js';

const STT_FAIL = '(фрагмент не расшифрован)';
const CHUNK_DRAIN_MS = 8000;
let recording = null;
let lingering = [];
let stopQueue = Promise.resolve();
const savedFiles = new Map();
let pathChain = Promise.resolve();
let pathsSession = 0;
let mixed = false;
let warnedNoKey = false;
let monitorWatch = null;
let sessionLoaded = false;
let loadingSession = null;
let transcriptQueue = Promise.resolve();

async function ensureSession() {
  if (sessionLoaded) return;
  if (!loadingSession) {
    loadingSession = chrome.storage.session.get(['recordingSession', 'monitorWatch'])
      .then((stored) => {
        if (sessionLoaded) return;
        const saved = stored?.recordingSession;
        if (saved?.recording?.tabId) {
          recording = saved.recording;
          mixed = Boolean(saved.mixed);
          claimPaths(recording.sessionId);
        }
        monitorWatch = stored?.monitorWatch || null;
        sessionLoaded = true;
        publishIndicators();
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
  await chrome.storage.session.set({ recordingSession, monitorWatch }).catch(() => {});
  await publishIndicators();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureSession().then(async () => {
    if (recording?.tabId === tabId) await stopRecording();
    if (monitorWatch?.active && monitorWatch.tabId === tabId) {
      await pauseMonitor('вкладка закрыта');
    }
  }).catch(() => {});
});

let tabUpdateChain = Promise.resolve();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'loading' && info.status !== 'complete') return;
  tabUpdateChain = tabUpdateChain
    .then(() => ensureSession())
    .then(() => onTabUpdated(tabId, info, tab))
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  ensureSession().then(() => {
    if (!recording?.tabId) return;
    messageFrames(recording.tabId, {
      target: 'telemost',
      type: 'settings',
      settings: changes.settings.newValue,
    }).catch(() => {});
  }).catch(() => {});
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
      return {
        ok: true,
        recording,
        mixed,
        recordingOn: Boolean(recording),
        recordingTabId: recording?.tabId ?? null,
        monitor: monitorPhase(),
        monitorWatch: monitorWatch
          ? {
            active: Boolean(monitorWatch.active),
            url: monitorWatch.url || '',
            tabId: monitorWatch.tabId ?? null,
            phase: monitorWatch.phase || 'off',
          }
          : null,
      };
    case 'recording-start':
      return startRecording(message);
    case 'recording-stop':
      return stopRecording();
    case 'capture-ended':
      if (recording) return stopRecording();
      return { ok: true };
    case 'audio-chunk':
      await saveAudioChunk(message, sender);
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
      return beginMonitor(message.tabId);
    case 'monitor-stop':
      return endMonitor(message.tabId);
    case 'conference-ended':
      if (!recording || (sender.tab?.id && sender.tab.id !== recording.tabId)) return { ok: true };
      await status(message.reason || 'Конференция завершена');
      return stopRecording();
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
      await deliverPick(message.tabId, {
        type: 'pick-start',
        field: message.field,
        featureIndex: message.featureIndex ?? null,
      });
      return { ok: true };
    case 'picked':
      disarmPick(sender.tab?.id).catch(() => {});
      return { ok: true };
    case 'selectors-probe':
      return probeFrames(message);
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

function monitorPhase() {
  if (!monitorWatch?.active) return 'off';
  return monitorWatch.phase === 'waiting' ? 'wait' : 'on';
}

async function publishIndicators() {
  await chrome.runtime.sendMessage({
    type: 'indicators',
    monitor: monitorPhase(),
    recordingOn: Boolean(recording),
    recordingTabId: recording?.tabId ?? null,
    monitorWatch: monitorWatch
      ? {
        active: Boolean(monitorWatch.active),
        url: monitorWatch.url || '',
        tabId: monitorWatch.tabId ?? null,
        phase: monitorWatch.phase || 'off',
      }
      : null,
  }).catch(() => {});
}

async function stopMonitorTab(tabId) {
  if (!tabId) return;
  await chrome.tabs.sendMessage(tabId, { target: 'page', type: 'monitor-stop' }).catch(() => {});
}

async function beginMonitor(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) return { ok: false, error: 'Нет адреса вкладки' };
  await adoptRootMonitor(tab.url);
  const previousId = monitorWatch?.active ? monitorWatch.tabId : null;
  if (previousId && previousId !== tabId) await stopMonitorTab(previousId);
  const response = await askPage(tabId, { type: 'monitor-start' });
  if (response?.ok === false) {
    if (previousId && previousId !== tabId) {
      monitorWatch = null;
      await persistSession();
    }
    return response;
  }
  monitorWatch = { active: true, url: tab.url, tabId, phase: 'on', navigating: false };
  await persistSession();
  await status('Мониторинг включён');
  return { ok: true };
}

async function endMonitor(tabId) {
  const watchedId = monitorWatch?.tabId;
  monitorWatch = null;
  await persistSession();
  await stopMonitorTab(watchedId);
  if (tabId && tabId !== watchedId) await stopMonitorTab(tabId);
  await status('Мониторинг выключен');
  return { ok: true };
}

async function pauseMonitor(reason) {
  if (!monitorWatch?.active) return;
  const url = monitorWatch.url;
  monitorWatch = { ...monitorWatch, tabId: null, phase: 'waiting', navigating: false };
  await persistSession();
  await status(`Мониторинг остановлен: ${reason}`);
  const settings = await getSettings();
  if (!settings.telegramToken || !settings.telegramChatId) return;
  try {
    await sendMessage(
      settings.telegramToken,
      settings.telegramChatId,
      `Мониторинг остановлен: ${reason}`,
      { url },
    );
  } catch (error) {
    await status(`Telegram: ${error.message}`);
  }
}

async function resumeMonitor(tabId, url) {
  if (!monitorWatch?.active || monitorWatch.phase !== 'waiting') return;
  if (!samePage(url, monitorWatch.url)) return;
  const response = await askPage(tabId, { type: 'monitor-start' });
  if (!monitorWatch?.active || monitorWatch.phase !== 'waiting') return;
  if (response?.ok === false) return;
  monitorWatch = { ...monitorWatch, tabId, phase: 'on', navigating: false };
  await persistSession();
  await status('Мониторинг возобновлён');
}

async function askPage(tabId, message) {
  try {
    return await deliverPage(tabId, message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function onTabUpdated(tabId, info, tab) {
  if (info.status === 'loading') {
    if (recording?.tabId === tabId) {
      recording = { ...recording, navigating: true };
      await persistSession();
    }
    if (monitorWatch?.active && monitorWatch.tabId === tabId && monitorWatch.phase === 'on') {
      monitorWatch = { ...monitorWatch, navigating: true };
      await persistSession();
    }
    return;
  }
  if (info.status !== 'complete' || !tab?.url) return;
  if (recording?.tabId === tabId && recording.navigating) await stopRecording();
  if (monitorWatch?.active && monitorWatch.tabId === tabId && monitorWatch.phase === 'on' && monitorWatch.navigating) {
    if (!samePage(tab.url, monitorWatch.url)) {
      await pauseMonitor('адрес вкладки изменился');
      return;
    }
    monitorWatch = { ...monitorWatch, navigating: false };
    await persistSession();
    const response = await askPage(tabId, { type: 'monitor-start' });
    if (!monitorWatch?.active || monitorWatch.tabId !== tabId || monitorWatch.phase !== 'on') return;
    if (response?.ok === false) return;
    await status('Мониторинг возобновлён');
    return;
  }
  await resumeMonitor(tabId, tab.url);
}

async function adoptRootMonitor(url) {
  const settings = await getSettings();
  const migrated = migrateRootMonitor(settings, url);
  if (migrated === settings) return;
  await chrome.storage.local.set({ settings: migrated });
}

async function startRecording({ tabId, streamId }) {
  if (recording?.tabId) await stopRecording();
  const sessionId = Date.now();
  recording = { sessionId, tabId, navigating: false };
  claimPaths(sessionId);
  mixed = false;
  warnedNoKey = false;
  await persistSession();
  await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
  await chrome.action.setBadgeText({ text: 'REC' });
  let heard = Boolean(streamId);
  try {
    await injectFrames(tabId, ['src/content/telemost-hook.js'], 'MAIN');
    const scriptFrames = await injectFrames(tabId, ['src/content/telemost.js']);
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
    const armTargets = scriptFrames.length ? scriptFrames : await tabFrames(tabId);
    let pending = [...armTargets];
    let lastError = null;
    for (let attempt = 0; attempt < 5 && pending.length; attempt += 1) {
      const failed = [];
      for (const frameId of pending) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            target: 'telemost',
            type: 'arm',
            sessionId,
            settings,
          }, { frameId });
        } catch (error) {
          lastError = error;
          failed.push(frameId);
        }
      }
      pending = failed;
      if (pending.length) await delay(80);
    }
    if (pending.length === armTargets.length) throw lastError || new Error('Вкладка Телемоста не отвечает');
  } catch (error) {
    const failed = recording;
    if (failed) retainSession(failed);
    recording = null;
    mixed = false;
    await persistSession();
    if (failed?.tabId) await messageFrames(failed.tabId, { target: 'telemost', type: 'disarm' });
    await sendOffscreen({ type: 'stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    await chrome.action.setBadgeText({ text: '' });
    throw error;
  }
  await status(heard ? 'Запись созвона включена' : 'Запись дорожек включена, захват вкладки недоступен');
  return { ok: true, sessionId };
}

function stopRecording() {
  const run = stopQueue.then(() => performStop());
  stopQueue = run.then(() => {}, () => {});
  return run;
}

function retainSession(session) {
  if (!session?.sessionId) return;
  const now = Date.now();
  lingering = lingering.filter((item) => item.until > now && item.sessionId !== session.sessionId);
  lingering.push({
    sessionId: session.sessionId,
    tabId: session.tabId,
    until: now + CHUNK_DRAIN_MS,
  });
}

function openSessions() {
  const now = Date.now();
  lingering = lingering.filter((item) => item.until > now);
  return [recording, ...lingering].filter(Boolean);
}

async function performStop() {
  await ensureSession();
  const current = recording;
  if (current?.tabId) {
    await messageFrames(current.tabId, { target: 'telemost', type: 'disarm' });
  }
  await sendOffscreen({ type: 'stop' }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
  if (current) retainSession(current);
  if (!current || recording?.sessionId === current.sessionId) {
    recording = null;
    mixed = false;
    await persistSession();
  }
  await chrome.action.setBadgeText({ text: '' });
  if (current) {
    const shown = await publishFiles(current.sessionId);
    if (!shown) await status('Запись остановлена');
  } else {
    await status('Запись остановлена');
  }
  return { ok: true };
}

function filesOf(sessionId) {
  let info = savedFiles.get(sessionId);
  if (!info) {
    info = { directory: '', transcript: '', notes: [] };
    savedFiles.set(sessionId, info);
  }
  return info;
}

async function noteSession(sessionId, text) {
  const info = filesOf(sessionId);
  const added = Boolean(text) && !info.notes.includes(text);
  if (added) info.notes.push(text);
  if (recording?.sessionId === sessionId) {
    if (added) await status(text);
    return;
  }
  await publishFiles(sessionId);
}

function publishFiles(sessionId) {
  const run = pathChain.then(() => sendPaths(sessionId), () => sendPaths(sessionId));
  pathChain = run.then(() => {}, () => {});
  return run;
}

function claimPaths(sessionId) {
  if (sessionId > pathsSession) pathsSession = sessionId;
}

async function sendPaths(sessionId) {
  const visible = () => shouldPublishPaths({
    sessionId,
    pathsSession,
    recordingSessionId: recording?.sessionId,
  });
  if (!visible()) return '';
  const text = sessionPathsText(filesOf(sessionId));
  if (!text || !visible()) return '';
  claimPaths(sessionId);
  await status(text);
  return text;
}

async function rememberDownload(sessionId, id, kind, fallback) {
  const filename = (await downloadFilename(id)) || fallback || '';
  if (!filename) return;
  const info = filesOf(sessionId);
  if (kind === 'transcript') info.transcript = filename;
  else {
    const directory = parentDirectory(filename);
    if (directory) info.directory = directory;
  }
  await publishFiles(sessionId);
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
  await messageFrames(recording.tabId, {
    target: 'telemost',
    type: 'disarm-tracks',
  });
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

async function saveAudioChunk(message, sender) {
  if (!message?.buffer) return;
  const session = acceptAudioSession(message, sender, openSessions());
  if (!session) return;
  const bytes = toBytes(message.buffer);
  if (bytes.byteLength < 64) return;
  const sessionId = message.sessionId || session.sessionId;
  const speaker = message.speaker || 'unknown';
  const filename = audioFilename({
    startedAt: message.startedAt,
    speaker,
    trackId: message.trackId || 'track',
  });
  let audioId = 0;
  try {
    audioId = await downloadBytes(filename, bytes, 'audio/webm', 'uniquify');
  } catch (error) {
    await noteSession(sessionId, `Скачивание: ${error.message}`);
  }
  const settings = await getSettings();
  const caption = `${speaker} ${formatClock(message.startedAt)}–${formatClock(message.endedAt)}`;
  const token = String(settings.telegramToken || '').trim();
  const chatId = String(settings.telegramChatId || '').trim();
  const telegramTask = (async () => {
    if (!token || !chatId) {
      await noteSession(sessionId, 'Telegram не настроен — фрагмент не отправлен');
      return;
    }
    await sendDocument(token, chatId, {
      filename: filename.split('/').pop(),
      bytes,
      mime: 'audio/webm',
      caption,
    });
  })().catch((error) => noteSession(sessionId, `Telegram: ${error.message}`));
  const textTask = (async () => {
    if (!settings.openrouterKey) return '';
    return transcribe({
      apiKey: settings.openrouterKey,
      model: settings.sttModel,
      bytes,
      language: settings.sttLanguage,
    });
  })().catch(async (error) => {
    await noteSession(sessionId, `Расшифровка: ${error.message}`);
    return STT_FAIL;
  });
  const pathTask = audioId ? rememberDownload(sessionId, audioId, 'audio', filename) : Promise.resolve();
  const [, text] = await Promise.all([telegramTask, textTask, pathTask]);
  if (!settings.openrouterKey) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      await noteSession(sessionId, 'Нет ключа OpenRouter — файл транскрипта не пишется');
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
    .catch((error) => noteSession(sessionId, `Транскрипт: ${error.message}`));
  return transcriptQueue;
}

async function appendTranscript(sessionId, line) {
  const key = `transcript:${sessionId}`;
  const stored = await chrome.storage.local.get(key);
  const lines = Array.isArray(stored[key]) ? stored[key] : [];
  lines.push(line);
  await chrome.storage.local.set({ [key]: lines });
  const text = renderTranscript(lines);
  const relative = transcriptFilename(sessionId);
  const id = await downloadBytes(relative, new TextEncoder().encode(text), 'text/plain', 'overwrite');
  await rememberDownload(sessionId, id, 'transcript', relative);
}

async function onItemFound(message, sender) {
  const pageUrl = sender.tab?.url || message.url || '';
  const settings = settingsForPage(await getSettings(), pageUrl);
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
      await sendMessage(settings.telegramToken, settings.telegramChatId, text, { url: pageUrl });
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
  return sendPage(tabId, 0, message);
}

async function tabFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const ids = (frames || []).map((frame) => frame.frameId);
    if (ids.length) return ids;
  } catch {
    /* список кадров недоступен */
  }
  return [0];
}

async function injectFrames(tabId, files, world) {
  const injected = [];
  for (const frameId of await tabFrames(tabId)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files,
        ...(world ? { world } : {}),
      });
      injected.push(frameId);
    } catch {
      /* кадр недоступен */
    }
  }
  return injected;
}

async function messageFrames(tabId, message) {
  const frames = await tabFrames(tabId);
  await Promise.all(frames.map((frameId) =>
    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {})
  ));
}

function betterState(left, right) {
  const rank = { ok: 5, pending: 4, invalid: 3, missing: 2, empty: 1 };
  return (rank[right] || 0) > (rank[left] || 0) ? right : (left || right || '');
}

function mergeStates(rows) {
  let merged = [];
  for (const row of rows) {
    const list = Array.isArray(row) ? row : [];
    const count = Math.max(merged.length, list.length);
    const next = [];
    for (let index = 0; index < count; index += 1) next[index] = betterState(merged[index], list[index]);
    merged = next;
  }
  return merged;
}

async function probeFrames(message) {
  const frames = await tabFrames(message.tabId);
  const replies = [];
  for (const frameId of frames) {
    try {
      const reply = await chrome.tabs.sendMessage(message.tabId, {
        target: message.frameTarget,
        type: 'selectors-check',
        selectors: message.selectors,
        parent: message.parent,
        item: message.item,
        features: message.features,
      }, { frameId });
      if (reply?.ok) replies.push(reply);
    } catch {
      /* в этом кадре скрипта нет */
    }
  }
  if (!replies.length) return { ok: false };
  if (message.frameTarget === 'page') {
    return {
      ok: true,
      parent: mergeStates(replies.map((reply) => [reply.parent]))[0],
      item: mergeStates(replies.map((reply) => [reply.item]))[0],
      features: mergeStates(replies.map((reply) => reply.features)),
    };
  }
  return { ok: true, states: mergeStates(replies.map((reply) => reply.states)) };
}

async function deliverPick(tabId, message) {
  const injected = await injectFrames(tabId, ['src/content/page.js']);
  if (!injected.length) throw new Error('Не удалось связаться со страницей');
  let lastError = null;
  let delivered = false;
  for (const frameId of injected) {
    try {
      await sendPage(tabId, frameId, message);
      delivered = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!delivered) throw lastError || new Error('Не удалось связаться со страницей');
  return { ok: true };
}

async function disarmPick(tabId) {
  if (!tabId) return;
  await messageFrames(tabId, { target: 'page', type: 'pick-stop' });
}

async function sendPage(tabId, frameId, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, { target: 'page', ...message }, { frameId });
    } catch (error) {
      lastError = error;
      await delay(80);
    }
  }
  throw lastError || new Error('Не удалось связаться со страницей');
}

function downloadBytes(filename, bytes, mime, conflictAction) {
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    url = '';
  }
  const saved = url
    ? downloadUrl(url, filename, conflictAction).finally(() => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    : Promise.reject(new Error('blob'));
  return saved.catch(() => downloadUrl(dataUrl(bytes, mime), filename, conflictAction));
}

function downloadFilename(id) {
  if (!id) return Promise.resolve('');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (filename) => {
      if (settled) return;
      settled = true;
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch { /* слушатель уже снят */ }
      resolve(filename || '');
    };
    const onChanged = (delta) => {
      if (delta.id !== id) return;
      if (delta.filename?.current) {
        finish(delta.filename.current);
        return;
      }
      if (delta.state?.current !== 'complete' && delta.state?.current !== 'interrupted') return;
      chrome.downloads.search({ id }, (items) => finish(items?.[0]?.filename || ''));
    };
    try {
      chrome.downloads.onChanged.addListener(onChanged);
    } catch {
      finish('');
      return;
    }
    chrome.downloads.search({ id }, (items) => {
      const name = items?.[0]?.filename || '';
      if (name) finish(name);
    });
    setTimeout(() => {
      chrome.downloads.search({ id }, (items) => finish(items?.[0]?.filename || ''));
    }, 4000);
  });
}

function downloadUrl(url, filename, conflictAction) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction, saveAs: false }, (id) => {
      const error = chrome.runtime.lastError;
      if (error || !id) reject(new Error(error?.message || 'Скачивание не началось'));
      else resolve(id);
    });
  });
}

function dataUrl(bytes, mime) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(binary)}`;
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
