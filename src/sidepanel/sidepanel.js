import { mergeSettings } from '../lib/defaults.js';

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
const TELEMOST_FIELDS = ['gridSelector', 'tileSelector', 'speakingSelector', 'nameSelector'];
const statusNode = document.querySelector('#status');
const featuresNode = document.querySelector('#features');
const macroNode = document.querySelector('#macro-steps');

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
document.querySelector('#rec-start').addEventListener('click', startRecording);
document.querySelector('#rec-stop').addEventListener('click', () => send({ type: 'recording-stop' }));

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
  if (event.target.matches('input, textarea')) scheduleSave();
});

featuresNode.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pick-feature]');
  if (!button) return;
  const row = button.closest('.feature');
  pickSelector('feature', [...featuresNode.children].indexOf(row));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'status' && message.text) setStatus(message.text);
  if (message?.type === 'picked') applyPicked(message);
  if (message?.type === 'macro-updated') renderMacro(message.steps || []);
});

load();

async function load() {
  const stored = await chrome.storage.local.get('settings');
  fill(mergeSettings(stored.settings));
}

function fill(settings) {
  for (const id of TEXT_FIELDS) {
    const node = document.getElementById(id);
    if (node && document.activeElement !== node) node.value = settings[id] ?? '';
  }
  document.querySelector('#aiEnabled').checked = Boolean(settings.aiEnabled);
  document.querySelector('#runMacroOnNewItem').checked = Boolean(settings.runMacroOnNewItem);
  for (const id of TELEMOST_FIELDS) {
    const node = document.getElementById(id);
    if (node && document.activeElement !== node) node.value = settings.telemost?.[id] ?? '';
  }
  if (document.activeElement !== document.querySelector('#localMarkers')) {
    document.querySelector('#localMarkers').value = settings.telemost?.localMarkers ?? '';
  }
  featuresNode.replaceChildren();
  for (const feature of settings.features) addFeature(feature.key, feature.selector);
  renderMacro(settings.macro);
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
  await chrome.storage.local.set({
    settings: mergeSettings({ ...snapshot, macro }),
  });
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
  row.append(keyInput, selectorInput, pick, remove);
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
  await save();
  const tab = await activeTab();
  if (!tab?.id) return;
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

async function startRecording() {
  await save();
  const tab = await activeTab();
  if (!tab?.id || !/telemost\.yandex\.ru/.test(tab.url || '')) {
    setStatus('Откройте вкладку Яндекс.Телемоста');
    return;
  }
  let streamId = '';
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    setStatus(`Захват вкладки: ${error.message}. Дорожки WebRTC всё равно пишутся.`);
  }
  const response = await send({ type: 'recording-start', tabId: tab.id, streamId });
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
  statusNode.textContent = text;
}
