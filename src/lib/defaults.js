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
    speakingSelector: '',
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
  };
}
