import { pageKey } from './watch.js';

export const MONITOR_FIELDS = [
  'parentSelector',
  'itemSelector',
  'captchaSelector',
  'errorText',
  'aiPrompt',
];

export const DEFAULT_SETTINGS = {
  telegramToken: '',
  telegramChatId: '',
  openrouterKey: '',
  chatModel: 'google/gemma-4-31b-it',
  sttModel: 'openai/whisper-large-v3',
  sttLanguage: 'ru',
  aiEnabled: false,
  aiPrompt: '',
  parentSelector: '',
  itemSelector: '',
  captchaSelector: '',
  errorText: '500\n502\n503\nService Unavailable',
  features: [],
  macro: [],
  runMacroOnNewItem: false,
  telemost: {
    gridSelector: '',
    tileSelector: '',
    nameSelector: '',
    localMarkers: 'Вы, You',
  },
};

export function mergeSettings(stored) {
  const src = stored && typeof stored === 'object' ? stored : {};
  return {
    ...DEFAULT_SETTINGS,
    ...src,
    telemost: {
      ...DEFAULT_SETTINGS.telemost,
      ...(src.telemost || {}),
    },
    features: Array.isArray(src.features) ? src.features : [],
    macro: Array.isArray(src.macro) ? src.macro : [],
    monitors: src.monitors && typeof src.monitors === 'object' && !Array.isArray(src.monitors)
      ? src.monitors
      : {},
  };
}

function monitorBucket(source) {
  return {
    parentSelector: source?.parentSelector || '',
    itemSelector: source?.itemSelector || '',
    captchaSelector: source?.captchaSelector || '',
    errorText: source?.errorText || DEFAULT_SETTINGS.errorText,
    aiEnabled: Boolean(source?.aiEnabled),
    aiPrompt: source?.aiPrompt || '',
    features: Array.isArray(source?.features) ? source.features : [],
  };
}

function ownsPageAi(bucket) {
  return Boolean(bucket) && (
    Object.prototype.hasOwnProperty.call(bucket, 'aiPrompt')
    || Object.prototype.hasOwnProperty.call(bucket, 'aiEnabled')
  );
}

function hasCustomMonitor(bucket) {
  return Boolean(
    bucket.parentSelector
    || bucket.itemSelector
    || bucket.captchaSelector
    || bucket.features.length
    || bucket.aiEnabled
    || bucket.aiPrompt
    || bucket.errorText !== DEFAULT_SETTINGS.errorText
  );
}

function monitorsEmpty(settings) {
  const monitors = settings?.monitors;
  return !monitors || typeof monitors !== 'object' || Array.isArray(monitors) || !Object.keys(monitors).length;
}

function applyMonitor(settings, bucket) {
  const fields = monitorBucket(bucket);
  const ai = ownsPageAi(bucket)
    ? { aiEnabled: Boolean(bucket.aiEnabled), aiPrompt: bucket.aiPrompt || '' }
    : { aiEnabled: Boolean(settings.aiEnabled), aiPrompt: settings.aiPrompt || '' };
  return {
    ...settings,
    parentSelector: fields.parentSelector,
    itemSelector: fields.itemSelector,
    captchaSelector: fields.captchaSelector,
    errorText: fields.errorText,
    features: fields.features,
    aiEnabled: ai.aiEnabled,
    aiPrompt: ai.aiPrompt,
  };
}

export function settingsForPage(settings, url) {
  const key = pageKey(url);
  if (!key) return applyMonitor(settings, { features: [], aiEnabled: false, aiPrompt: '' });
  const bucket = settings.monitors?.[key];
  if (bucket) return applyMonitor(settings, bucket);
  if (monitorsEmpty(settings)) {
    const root = monitorBucket(settings);
    if (hasCustomMonitor(root)) return applyMonitor(settings, root);
  }
  return applyMonitor(settings, { features: [], aiEnabled: false, aiPrompt: '' });
}

export function migrateRootMonitor(settings, url) {
  const key = pageKey(url);
  if (!key || !monitorsEmpty(settings)) return settings;
  const root = monitorBucket(settings);
  if (!hasCustomMonitor(root)) return settings;
  return {
    ...settings,
    parentSelector: '',
    itemSelector: '',
    captchaSelector: '',
    features: [],
    errorText: DEFAULT_SETTINGS.errorText,
    aiEnabled: false,
    aiPrompt: '',
    monitors: { [key]: root },
  };
}

export function adoptRootAi(settings) {
  if (!settings?.aiEnabled && !settings?.aiPrompt) return settings;
  const monitors = settings.monitors && typeof settings.monitors === 'object' ? settings.monitors : {};
  if (!Object.keys(monitors).length) return settings;
  const next = { ...monitors };
  for (const [key, bucket] of Object.entries(next)) {
    if (!bucket || typeof bucket !== 'object' || ownsPageAi(bucket)) continue;
    next[key] = {
      ...bucket,
      aiEnabled: Boolean(settings.aiEnabled),
      aiPrompt: settings.aiPrompt || '',
    };
  }
  return {
    ...settings,
    aiEnabled: false,
    aiPrompt: '',
    monitors: next,
  };
}
