import { recordingButtons } from '../lib/audio-chunk.js';
import { mergeSettings, MONITOR_FIELDS, migrateRootMonitor, adoptRootAi, settingsForPage, DEFAULT_SETTINGS } from '../lib/defaults.js';
import { isTelemostUrl, pageKey, samePage } from '../lib/watch.js';

const TEXT_FIELDS = [
  'telegramToken',
  'telegramChatId',
  'openrouterKey',
  'chatModel',
  'sttModel',
  'sttLanguage',
  'aiPrompt',
  'parentSelector',
  'itemSelector',
  'captchaSelector',
  'errorText',
  'localMarkers',
];
const GLOBAL_FIELDS = TEXT_FIELDS.filter((id) => !MONITOR_FIELDS.includes(id) && id !== 'localMarkers');
const TELEMOST_FIELDS = ['gridSelector', 'tileSelector', 'nameSelector'];
const featuresNode = document.querySelector('#features');
const macroNode = document.querySelector('#macro-steps');
let boundTabId = null;
let boundUrl = '';
let boundPageKey = '';
let currentWatch = null;
let recordingOn = false;
let recordingTabId = null;
let telemostAllowed = false;

document.querySelector('#add-feature').addEventListener('click', () => {
  addFeature('', '');
  save();
});
document.querySelector('#monitor-start').addEventListener('click', () => withTab('monitor-start'));
document.querySelector('#monitor-stop').addEventListener('click', () => withTab('monitor-stop'));
document.querySelector('#macro-rec').addEventListener('click', () => withTab('macro-record-start'));
document.querySelector('#macro-stop').addEventListener('click', () => withTab('macro-record-stop'));
document.querySelector('#macro-play').addEventListener('click', () => withTab('macro-play'));
document.querySelector('#macro-clear').addEventListener('click', async () => {
  await save({ macro: [] });
  renderMacro([]);
  setStatus('Макрос очищен');
});
document.querySelector('#rec-start').addEventListener('click', () => {
  if (recordingOn) return;
  let capture = Promise.resolve('');
  try {
    capture = captureTabStream(boundTabId, boundUrl);
  } catch (error) {
    setStatus(`Захват вкладки: ${error.message}. Дорожки WebRTC всё равно пишутся.`);
  }
  startRecording(boundTabId, capture);
});
document.querySelector('#rec-stop').addEventListener('click', () => {
  if (!recordingOn) return;
  if (!window.confirm('Остановить запись созвона?')) return;
  send({ type: 'recording-stop' });
});

document.body.addEventListener('click', (event) => {
  const pick = event.target.closest('[data-pick]');
  if (pick) {
    pickSelector(pick.dataset.pick, null);
    return;
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    remove.parentElement.remove();
    save();
  }
});

document.body.addEventListener('input', (event) => {
  if (!event.target.matches('input, textarea')) return;
  scheduleSave();
  if (event.target.id === 'parentSelector' || event.target.id === 'itemSelector') paintIndicators();
});

featuresNode.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pick-feature]');
  if (!button) return;
  const row = button.closest('.feature');
  pickSelector('feature', [...featuresNode.children].indexOf(row));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'status') setStatus(message.text || '');
  if (message?.type === 'indicators') {
    currentWatch = message.monitorWatch || null;
    recordingOn = Boolean(message.recordingOn);
    recordingTabId = message.recordingTabId ?? null;
    paintIndicators();
  }
  if (message?.type === 'picked') applyPicked(message);
  if (message?.type === 'macro-updated') renderMacro(message.steps || []);
});

chrome.tabs.onActivated.addListener(() => {
  showActiveTab().catch((error) => setStatus(error.message));
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== boundTabId) return;
  if (info.status === 'loading') {
    selectorCheckGen += 1;
    clearListedMisses(['parentSelector', 'itemSelector', 'feature', ...TELEMOST_FIELDS]);
  }
  showActiveTab().catch((error) => setStatus(error.message));
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.recordingSession && !changes.monitorWatch) return;
  refreshIndicators().catch((error) => setStatus(error.message));
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshIndicators().catch((error) => setStatus(error.message));
});

setInterval(() => {
  if (document.visibilityState === 'hidden') return;
  refreshIndicators().catch(() => {});
}, 2000);

const PANEL_IDS = ['panel-telegram', 'panel-openrouter'];
const MODE_KEY = 'panel-mode';

restorePanels();
load();

document.querySelectorAll('.mode-tab').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

async function restorePanels() {
  const stored = await chrome.storage.local.get([...PANEL_IDS, MODE_KEY]);
  for (const id of PANEL_IDS) {
    const panel = document.getElementById(id);
    panel.open = stored[id] === true;
    panel.addEventListener('toggle', () => {
      chrome.storage.local.set({ [id]: panel.open });
    });
  }
  setMode(stored[MODE_KEY] === 'telemost' ? 'telemost' : 'monitor', false);
}

function setMode(mode, save = true) {
  document.querySelector('#pane-monitor').hidden = mode !== 'monitor';
  document.querySelector('#pane-telemost').hidden = mode !== 'telemost';
  document.querySelector('#tab-monitor').classList.toggle('active', mode === 'monitor');
  document.querySelector('#tab-telemost').classList.toggle('active', mode === 'telemost');
  if (save) chrome.storage.local.set({ [MODE_KEY]: mode });
}

async function load() {
  const settings = mergeSettings((await chrome.storage.local.get('settings')).settings);
  fillGlobals(settings);
  await showActiveTab();
  await refreshIndicators();
}

function fillGlobals(settings) {
  for (const id of GLOBAL_FIELDS) {
    const node = document.getElementById(id);
    if (node && document.activeElement !== node) node.value = settings[id] ?? '';
  }
  document.querySelector('#runMacroOnNewItem').checked = Boolean(settings.runMacroOnNewItem);
  for (const id of TELEMOST_FIELDS) {
    const node = document.getElementById(id);
    if (node && document.activeElement !== node) node.value = settings.telemost?.[id] ?? '';
  }
  if (document.activeElement !== document.querySelector('#localMarkers')) {
    document.querySelector('#localMarkers').value = settings.telemost?.localMarkers ?? '';
  }
  renderMacro(settings.macro);
}

function fillMonitor(bucket) {
  const source = bucket || {};
  for (const id of MONITOR_FIELDS) {
    const node = document.getElementById(id);
    if (!node) continue;
    const fallback = id === 'errorText' ? '500\n502\n503\nService Unavailable' : '';
    node.value = source[id] || fallback;
  }
  featuresNode.replaceChildren();
  for (const feature of source.features || []) addFeature(feature.key, feature.selector);
  document.querySelector('#aiEnabled').checked = Boolean(source.aiEnabled);
}

function collect(extra = {}) {
  const settings = {
    aiEnabled: document.querySelector('#aiEnabled').checked,
    runMacroOnNewItem: document.querySelector('#runMacroOnNewItem').checked,
    features: [...featuresNode.querySelectorAll('.feature')].map((row) => ({
      key: row.querySelector('[data-key]').value.trim(),
      selector: row.querySelector('[data-selector]').value.trim(),
    })).filter((feature) => feature.key || feature.selector),
    telemost: {
      localMarkers: document.querySelector('#localMarkers').value,
    },
  };
  for (const id of TEXT_FIELDS) {
    if (id === 'localMarkers') continue;
    settings[id] = document.getElementById(id).value;
  }
  for (const id of TELEMOST_FIELDS) settings.telemost[id] = document.getElementById(id).value;
  return { ...settings, ...extra };
}

let saveTimer = 0;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist().catch((error) => setStatus(error.message));
  }, 150);
}

async function save(extra) {
  return persist(extra);
}

async function persist(extra) {
  clearTimeout(saveTimer);
  const snapshot = collect(extra);
  const current = mergeSettings((await chrome.storage.local.get('settings')).settings);
  const macro = extra && Object.prototype.hasOwnProperty.call(extra, 'macro')
    ? extra.macro
    : current.macro;
  const base = boundPageKey ? adoptRootAi(migrateRootMonitor(current, boundUrl)) : current;
  const monitors = { ...(base.monitors || {}) };
  if (boundPageKey) {
    monitors[boundPageKey] = {
      parentSelector: snapshot.parentSelector,
      itemSelector: snapshot.itemSelector,
      captchaSelector: snapshot.captchaSelector,
      errorText: snapshot.errorText,
      features: snapshot.features,
      aiEnabled: Boolean(snapshot.aiEnabled),
      aiPrompt: snapshot.aiPrompt || '',
    };
  }
  const next = {
    ...snapshot,
    macro,
    monitors,
  };
  if (boundPageKey) {
    next.parentSelector = '';
    next.itemSelector = '';
    next.captchaSelector = '';
    next.features = [];
    next.errorText = DEFAULT_SETTINGS.errorText;
    next.aiEnabled = false;
    next.aiPrompt = '';
  } else {
    next.parentSelector = current.parentSelector;
    next.itemSelector = current.itemSelector;
    next.captchaSelector = current.captchaSelector;
    next.features = current.features;
    next.errorText = current.errorText;
    next.aiEnabled = current.aiEnabled;
    next.aiPrompt = current.aiPrompt;
  }
  await chrome.storage.local.set({
    settings: mergeSettings(next),
  });
}

let showTabChain = Promise.resolve();

function showActiveTab() {
  const run = showTabChain.then(() => refreshActiveTab());
  showTabChain = run.then(() => {}, () => {});
  return run;
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    syncTelemostControls('');
    return;
  }
  const key = pageKey(tab.url || '');
  if (tab.id === boundTabId && key === boundPageKey) {
    syncTelemostControls();
    return;
  }
  if (boundPageKey) await persist();
  boundTabId = tab.id;
  boundUrl = tab.url || '';
  boundPageKey = key;
  let settings = mergeSettings((await chrome.storage.local.get('settings')).settings);
  const migrated = adoptRootAi(migrateRootMonitor(settings, boundUrl));
  if (migrated !== settings) {
    await chrome.storage.local.set({ settings: migrated });
    settings = migrated;
  }
  fillMonitor(settingsForPage(settings, boundUrl));
  syncTelemostControls();
  paintIndicators();
}

function applyRecButtons() {
  const buttons = recordingButtons({ allowed: telemostAllowed, recordingOn });
  const start = document.getElementById('rec-start');
  if (start) start.disabled = buttons.startDisabled;
  const stop = document.getElementById('rec-stop');
  if (stop) stop.disabled = buttons.stopDisabled;
}

function syncTelemostControls(url = boundUrl) {
  const allowed = isTelemostUrl(url);
  telemostAllowed = allowed;
  for (const button of document.querySelectorAll('#pane-telemost [data-pick]')) button.disabled = !allowed;
  applyRecButtons();
  const hint = document.getElementById('telemost-gate');
  if (hint) hint.hidden = allowed;
}

function addFeature(key, selector) {
  const row = document.createElement('div');
  row.className = 'feature';
  const keyInput = document.createElement('input');
  keyInput.placeholder = 'ключ';
  keyInput.dataset.key = '1';
  keyInput.value = key || '';
  const selectorInput = document.createElement('input');
  selectorInput.placeholder = 'селектор';
  selectorInput.dataset.selector = '1';
  selectorInput.value = selector || '';
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.textContent = 'Прицел';
  pick.dataset.pickFeature = String(featuresNode.children.length);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.dataset.remove = '1';
  const miss = document.createElement('p');
  miss.className = 'selector-miss';
  miss.hidden = true;
  row.append(keyInput, selectorInput, pick, remove, miss);
  featuresNode.append(row);
}

function renderMacro(steps) {
  macroNode.replaceChildren();
  for (const step of steps || []) {
    const item = document.createElement('li');
    item.textContent = step.type === 'input'
      ? `ввод ${step.selector} = ${step.value ?? ''}`
      : `клик ${step.selector}`;
    macroNode.append(item);
  }
}

async function applyPicked(message) {
  if (message.field === 'feature') {
    const rows = [...featuresNode.querySelectorAll('.feature')];
    const input = rows[message.featureIndex]?.querySelector('[data-selector]');
    if (input) input.value = message.selector || '';
  } else {
    const input = document.getElementById(message.field);
    if (input) input.value = message.selector || '';
  }
  save();
  setStatus(message.selector ? `Селектор: ${message.selector}` : 'Селектор пуст');
}

async function pickSelector(field, featureIndex) {
  const tab = await activeTab();
  if (!tab?.id) return;
  if (TELEMOST_FIELDS.includes(field) && !isTelemostUrl(tab.url)) return;
  await save();
  const response = await send({ type: 'pick-start', tabId: tab.id, field, featureIndex });
  if (response?.ok === false) setStatus(response.error || 'Прицел не запустился');
}

async function withTab(type) {
  await save();
  const tab = await activeTab();
  if (!tab?.id) return;
  const response = await send({ type, tabId: tab.id });
  if (response?.ok === false) setStatus(response.error || 'Команда не выполнена');
}

function captureTabStream(tabId, url) {
  if (!tabId || !isTelemostUrl(url)) return Promise.resolve('');
  return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }).catch((error) => {
    setStatus(`Захват вкладки: ${error.message}. Дорожки WebRTC всё равно пишутся.`);
    return '';
  });
}

async function startRecording(tabId, capture) {
  await save();
  if (!tabId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || !isTelemostUrl(tab.url)) return;
  const streamId = await capture;
  const response = await send({ type: 'recording-start', tabId: tab.id, streamId: streamId || '' });
  if (response?.ok === false) setStatus(response.error || 'Запись не запустилась');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) setStatus('Нет активной вкладки');
  return tab;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(text) {
  const node = document.getElementById('panel-status');
  if (!node) return;
  const value = text || '';
  node.hidden = !value;
  node.textContent = value;
}

const INDICATOR_LABEL = {
  on: 'Включено',
  off: 'Выключено',
  wait: 'Ждёт вкладку',
};

function paintIndicators() {
  paintIndicator(document.querySelector('#monitor-indicator'), monitorIndicator(currentWatch));
  paintIndicator(
    document.querySelector('#rec-indicator'),
    recordingOn ? 'on' : 'off',
  );
  applyRecButtons();
  checkLiveSelectors().catch(() => {});
}

const MISS_TEXT = {
  missing: 'На странице нет такого элемента. Задайте селектор заново.',
  invalid: 'Селектор некорректен. Задайте цель заново.',
};

let selectorCheckGen = 0;

function showMiss(note, state) {
  if (!note) return;
  const text = MISS_TEXT[state] || '';
  note.hidden = !text;
  note.textContent = text;
}

function clearListedMisses(ids) {
  for (const id of ids) showMiss(document.querySelector(`[data-miss="${id}"]`), '');
  if (ids.includes('feature')) {
    for (const note of featuresNode.querySelectorAll('.selector-miss')) showMiss(note, '');
  }
}

async function probeSelectors(target, selectors, fields) {
  if (!boundTabId) return null;
  try {
    return await send({
      type: 'selectors-probe',
      tabId: boundTabId,
      frameTarget: target,
      selectors,
      ...fields,
    });
  } catch {
    return null;
  }
}

async function checkLiveSelectors() {
  const gen = ++selectorCheckGen;
  const monitorOn = monitorIndicator(currentWatch) === 'on';
  const recordingHere = Boolean(recordingOn && recordingTabId === boundTabId);
  if (!monitorOn) clearListedMisses(['parentSelector', 'itemSelector', 'feature']);
  if (!recordingHere) clearListedMisses(TELEMOST_FIELDS);
  if (!monitorOn && !recordingHere) return;
  if (monitorOn) {
    const rows = [...featuresNode.querySelectorAll('.feature')];
    const inputs = [
      document.getElementById('parentSelector'),
      document.getElementById('itemSelector'),
      ...rows.map((row) => row.querySelector('[data-selector]')),
    ];
    const notes = [
      document.querySelector('[data-miss="parentSelector"]'),
      document.querySelector('[data-miss="itemSelector"]'),
      ...rows.map((row) => row.querySelector('.selector-miss')),
    ];
    const result = await probeSelectors('page', null, {
      parent: inputs[0]?.value || '',
      item: inputs[1]?.value || '',
      features: inputs.slice(2).map((input) => input?.value || ''),
    });
    if (gen !== selectorCheckGen) return;
    if (result?.ok) {
      const states = [result.parent, result.item, ...(result.features || [])];
      notes.forEach((note, index) => {
        const state = states[index];
        showMiss(note, state === 'missing' || state === 'invalid' ? state : '');
      });
    }
  }
  if (!recordingHere) return;
  const telemostFields = TELEMOST_FIELDS;
  const telemostInputs = telemostFields.map((id) => document.getElementById(id));
  const result = await probeSelectors('telemost', telemostInputs.map((input) => input?.value || ''));
  if (gen !== selectorCheckGen || !result?.ok || !Array.isArray(result.states)) return;
  telemostFields.forEach((id, index) => {
    const state = result.states[index];
    showMiss(document.querySelector(`[data-miss="${id}"]`), state === 'missing' || state === 'invalid' ? state : '');
  });
}

function pageHasMonitorSelectors() {
  const parent = document.getElementById('parentSelector')?.value.trim() || '';
  const item = document.getElementById('itemSelector')?.value.trim() || '';
  return Boolean(parent && item);
}

function monitorIndicator(watch) {
  if (!pageHasMonitorSelectors() || !watch?.active || !samePage(watch.url, boundUrl)) return 'off';
  if (watch.phase === 'waiting') return 'wait';
  if (watch.tabId === boundTabId && watch.phase === 'on') return 'on';
  return 'off';
}

function paintIndicator(node, state) {
  if (!node) return;
  node.className = `indicator ${state}`;
  node.textContent = INDICATOR_LABEL[state] || INDICATOR_LABEL.off;
}

async function refreshIndicators() {
  const state = await send({ type: 'status-get' });
  if (!state) return;
  currentWatch = state.monitorWatch || null;
  recordingOn = Boolean(state.recordingOn);
  recordingTabId = state.recordingTabId ?? state.recording?.tabId ?? null;
  paintIndicators();
}
