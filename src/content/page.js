(() => {
  if (globalThis.__mimicPage) return;
  globalThis.__mimicPage = true;

  const queue = [];
  let handle = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'page') return;
    if (!handle) {
      queue.push({ message, sendResponse });
      return true;
    }
    Promise.resolve(handle(message))
      .then((result) => sendResponse(result ?? { ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  boot().catch((error) => {
    for (const item of queue.splice(0)) {
      item.sendResponse({ ok: false, error: error.message });
    }
  });

  async function boot() {
    const [defaults, human, selectorApi, serverError] = await Promise.all([
      import(chrome.runtime.getURL('src/lib/defaults.js')),
      import(chrome.runtime.getURL('src/lib/human.js')),
      import(chrome.runtime.getURL('src/lib/selector.js')),
      import(chrome.runtime.getURL('src/lib/server-error.js')),
    ]);
    const api = createPage({
      mergeSettings: defaults.mergeSettings,
      human,
      uniqueSelector: selectorApi.uniqueSelector,
      findServerErrorText: serverError.findServerErrorText,
    });
    handle = api.handle;
    for (const item of queue.splice(0)) {
      Promise.resolve(handle(item.message))
        .then((result) => item.sendResponse(result ?? { ok: true }))
        .catch((error) => item.sendResponse({ ok: false, error: error.message }));
    }
  }

  function createPage({ mergeSettings, human, uniqueSelector, findServerErrorText }) {
    let monitor = null;
    let seen = new WeakSet();
    let hashes = new Set();
    let tripped = false;
    let playing = false;
    let recordingMacro = false;
    let steps = [];
    let picker = null;
    let box = null;

    async function loadSettings() {
      const stored = await chrome.storage.local.get('settings');
      return mergeSettings(stored.settings);
    }

    async function handle(message) {
      if (message.type === 'pick-start') return startPick(message.field, message.featureIndex);
      if (message.type === 'monitor-start') return startMonitor();
      if (message.type === 'monitor-stop') {
        stopMonitor();
        return { ok: true };
      }
      if (message.type === 'macro-record-start') return startMacroRecord();
      if (message.type === 'macro-record-stop') return stopMacroRecord();
      if (message.type === 'macro-play') return playMacro();
      return { ok: true };
    }

    function startPick(field, featureIndex) {
      stopPick();
      picker = { field, featureIndex };
      box = document.createElement('div');
      box.id = 'mimic-hover-box';
      box.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:2147483647',
        'border:2px solid #d92d20',
        'background:rgba(217,45,32,.18)',
        'box-sizing:border-box',
      ].join(';');
      (document.documentElement || document.body).appendChild(box);
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKey, true);
      status('Наведите на элемент и кликните');
      return { ok: true };
    }

    function onPickMove(event) {
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || el === box || !box) return;
      const rect = el.getBoundingClientRect();
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    }

    function onPickClick(event) {
      if (!picker) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const selected = uniqueSelector(el);
      chrome.runtime.sendMessage({
        type: 'picked',
        field: picker.field,
        featureIndex: picker.featureIndex,
        selector: selected,
      }).catch(() => {});
      stopPick();
      status(selected ? `Селектор: ${selected}` : 'Не удалось построить селектор');
    }

    function onPickKey(event) {
      if (event.key === 'Escape') stopPick();
    }

    function stopPick() {
      picker = null;
      box?.remove();
      box = null;
      document.removeEventListener('mousemove', onPickMove, true);
      document.removeEventListener('click', onPickClick, true);
      document.removeEventListener('keydown', onPickKey, true);
    }

    async function startMonitor() {
      const settings = await loadSettings();
      if (!settings.parentSelector || !settings.itemSelector) {
        status('Нужны селекторы родителя и элемента');
        return { ok: false };
      }
      let parent = null;
      try {
        parent = document.querySelector(settings.parentSelector);
      } catch {
        status('Селектор родителя некорректен');
        return { ok: false };
      }
      if (!parent) {
        status('Родительский элемент не найден');
        return { ok: false };
      }
      stopMonitor();
      tripped = false;
      seen = new WeakSet();
      hashes = new Set();
      if (guard(settings)) return { ok: false };
      monitor = new MutationObserver((records) => {
        if (guard(settings)) return;
        for (const record of records) collectAdded(record.addedNodes, settings);
      });
      monitor.observe(parent, { childList: true, subtree: true });
      status('Мониторинг запущен');
      return { ok: true };
    }

    function stopMonitor() {
      monitor?.disconnect();
      monitor = null;
    }

    function collectAdded(nodes, settings) {
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        let items = [];
        try {
          if (node.matches(settings.itemSelector)) items.push(node);
          items.push(...node.querySelectorAll(settings.itemSelector));
        } catch {
          status('Селектор элемента некорректен');
          return;
        }
        for (const item of items) {
          if (seen.has(item)) continue;
          seen.add(item);
          const data = extractItem(item, settings);
          const hash = JSON.stringify(data);
          if (hashes.has(hash)) continue;
          hashes.add(hash);
          chrome.runtime.sendMessage({ type: 'item-found', data, url: location.href }).catch(() => {});
        }
      }
    }

    function extractItem(item, settings) {
      const data = {};
      const features = Array.isArray(settings.features) ? settings.features : [];
      for (const feature of features) {
        if (!feature?.key) continue;
        if (!feature.selector) {
          data[feature.key] = '';
          continue;
        }
        try {
          data[feature.key] = item.querySelector(feature.selector)?.innerText?.trim() || '';
        } catch {
          data[feature.key] = '';
        }
      }
      if (!features.length) data.text = item.innerText?.trim().slice(0, 500) || '';
      return data;
    }

    function guard(settings) {
      const captcha = findCaptcha(settings);
      if (captcha) {
        trip('Обнаружена капча');
        return true;
      }
      const server = findServerError(settings);
      if (server) {
        trip(`Ошибка сервера: ${server}`);
        return true;
      }
      return false;
    }

    function findCaptcha(settings) {
      const selector = String(settings.captchaSelector || '').trim();
      if (!selector) return false;
      try {
        return Boolean(document.querySelector(selector));
      } catch {
        return false;
      }
    }

    function findServerError(settings) {
      return findServerErrorText(document.body?.innerText || '', settings.errorText);
    }

    function trip(reason) {
      if (tripped) return;
      tripped = true;
      playing = false;
      stopMonitor();
      chrome.runtime.sendMessage({ type: 'failsafe', reason, url: location.href }).catch(() => {});
    }

    async function startMacroRecord() {
      stopPick();
      recordingMacro = true;
      steps = [];
      document.addEventListener('click', onMacroClick, true);
      document.addEventListener('input', onMacroInput, true);
      document.addEventListener('change', onMacroInput, true);
      status('Запись макроса. Повторите действия на странице');
      return { ok: true };
    }

    function stopMacroRecord() {
      recordingMacro = false;
      document.removeEventListener('click', onMacroClick, true);
      document.removeEventListener('input', onMacroInput, true);
      document.removeEventListener('change', onMacroInput, true);
      chrome.runtime.sendMessage({ type: 'macro-save', steps }).catch(() => {});
      status(`Макрос сохранён: ${steps.length}`);
      return { ok: true };
    }

    function onMacroClick(event) {
      if (!recordingMacro || picker) return;
      const el = event.target instanceof Element ? event.target : null;
      if (!el || el.id === 'mimic-hover-box') return;
      const selected = uniqueSelector(el);
      if (!selected) return;
      steps.push({ type: 'click', selector: selected, value: '' });
      status(`Шаг: клик ${selected}`);
    }

    function onMacroInput(event) {
      if (!recordingMacro || picker) return;
      const el = event.target;
      if (!isTextField(el)) return;
      const selected = uniqueSelector(el);
      if (!selected) return;
      const step = { type: 'input', selector: selected, value: fieldValue(el) };
      const last = steps[steps.length - 1];
      if (last && last.type === 'input' && last.selector === selected) last.value = step.value;
      else steps.push(step);
    }

    function isTextField(el) {
      if (!(el instanceof Element)) return false;
      if (el.isContentEditable) return true;
      if (el instanceof HTMLTextAreaElement) return true;
      if (!(el instanceof HTMLInputElement)) return false;
      return !['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(el.type);
    }

    function fieldValue(el) {
      if (el.isContentEditable) return el.innerText || '';
      return el.value || '';
    }

    async function playMacro() {
      if (playing) return { ok: true, skipped: true };
      const settings = await loadSettings();
      const macro = Array.isArray(settings.macro) ? settings.macro : [];
      if (!macro.length) {
        status('Макрос пуст');
        return { ok: false };
      }
      playing = true;
      tripped = false;
      for (let index = 0; index < macro.length; index += 1) {
        const step = macro[index];
        if (!playing || tripped) return { ok: false };
        if (index > 0) await human.sleep(human.randInt(400, 1500));
        if (!playing || tripped) return { ok: false };
        if (guard(settings)) return { ok: false };
        const el = await waitForSelector(step.selector, 5000);
        if (!el) {
          trip(`Не найден элемент «${step.selector}»`);
          return { ok: false };
        }
        if (step.type === 'input') await human.typeInto(el, step.value ?? '');
        else human.clickLikeUser(el);
      }
      playing = false;
      status('Макрос выполнен');
      return { ok: true };
    }

    function waitForSelector(selector, timeout) {
      let found = null;
      try {
        found = document.querySelector(selector);
      } catch {
        return Promise.resolve(null);
      }
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const obs = new MutationObserver(() => {
          let el = null;
          try {
            el = document.querySelector(selector);
          } catch {
            el = null;
          }
          if (!el) return;
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        const timer = setTimeout(() => {
          obs.disconnect();
          resolve(null);
        }, timeout);
      });
    }

    function status(text) {
      chrome.runtime.sendMessage({ type: 'status', text }).catch(() => {});
    }

    return { handle };
  }
})();
