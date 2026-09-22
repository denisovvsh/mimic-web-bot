(() => {
  const previous = globalThis.__mimicPageApi;
  if (previous?.alive) {
    let live = false;
    try { live = previous.alive(); } catch { live = false; }
    if (live) return;
    try { previous.dispose(); } catch { /* старый контекст уже мёртв */ }
  }

  const queue = [];
  let handle = null;
  let disposed = false;
  let pageDispose = () => {};

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* контекст снят */ }
    try { pageDispose(); } catch { /* наблюдатели уже отключены */ }
    if (globalThis.__mimicPageApi?.dispose === dispose) globalThis.__mimicPageApi = null;
  }

  function notify(message) {
    if (!alive()) {
      dispose();
      return;
    }
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      dispose();
    }
  }

  function reply(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch {
      dispose();
    }
  }

  function onMessage(message, _sender, sendResponse) {
    if (message?.target !== 'page') return;
    if (!alive()) {
      dispose();
      return;
    }
    if (!handle) {
      queue.push({ message, sendResponse });
      return true;
    }
    Promise.resolve(handle(message))
      .then((result) => reply(sendResponse, result ?? { ok: true }))
      .catch((error) => reply(sendResponse, { ok: false, error: error.message }));
    return true;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__mimicPageApi = { alive, dispose };
  window.addEventListener('pagehide', () => {
    try { dispose(); } catch { /* страница закрывается */ }
  }, { once: true });

  boot().catch((error) => {
    for (const item of queue.splice(0)) {
      try { item.sendResponse({ ok: false, error: error.message }); } catch { /* вкладка закрыта */ }
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
      settingsForPage: defaults.settingsForPage,
      human,
      uniqueSelector: selectorApi.uniqueSelector,
      findWithin: selectorApi.findWithin,
      findServerErrorText: serverError.findServerErrorText,
      alive,
      dispose,
    });
    pageDispose = api.dispose;
    handle = api.handle;
    for (const item of queue.splice(0)) {
      Promise.resolve(handle(item.message))
        .then((result) => reply(item.sendResponse, result ?? { ok: true }))
        .catch((error) => reply(item.sendResponse, { ok: false, error: error.message }));
    }
  }

  function createPage({ mergeSettings, settingsForPage, human, uniqueSelector, findWithin, findServerErrorText, alive, dispose }) {
    let monitor = null;
    let parentWait = null;
    let cancelParentWait = null;
    let monitorGeneration = 0;
    let seen = new WeakSet();
    let hashes = new Set();
    let tripped = false;
    let playing = false;
    let recordingMacro = false;
    let steps = [];
    let picker = null;
    let box = null;

    let pageReadyAt = document.readyState === 'complete' ? Date.now() : 0;
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'complete') pageReadyAt = Date.now();
    });

    function selectorState(root, selector) {
      const value = String(selector || '').trim();
      if (!value) return { state: 'empty', node: null };
      const node = findWithin(root || document, value);
      if (node === undefined) return { state: 'invalid', node: null };
      if (node) return { state: 'ok', node };
      if (!pageReadyAt || Date.now() - pageReadyAt < 5000) return { state: 'pending', node: null };
      return { state: 'missing', node: null };
    }

    function checkSelectors(message) {
      const parent = selectorState(document, message?.parent);
      const item = parent.node
        ? selectorState(parent.node, message?.item)
        : { state: parent.state === 'ok' ? 'missing' : parent.state, node: null };
      const features = Array.isArray(message?.features) ? message.features : [];
      return {
        ok: true,
        parent: parent.state,
        item: item.state,
        features: features.map((selector) => {
          if (!String(selector || '').trim()) return 'empty';
          if (!item.node) return parent.state === 'pending' || item.state === 'pending' ? 'pending' : 'empty';
          return selectorState(item.node, selector).state;
        }),
      };
    }

    async function loadSettings() {
      const stored = await chrome.storage.local.get('settings');
      return settingsForPage(mergeSettings(stored.settings), location.href);
    }

    async function handle(message) {
      if (message.type === 'pick-start') return startPick(message.field, message.featureIndex);
      if (message.type === 'pick-stop') {
        stopPick();
        return { ok: true };
      }
      if (message.type === 'monitor-start') return startMonitor();
      if (message.type === 'monitor-stop') {
        stopMonitor();
        return { ok: true };
      }
      if (message.type === 'macro-record-start') return startMacroRecord();
      if (message.type === 'macro-record-stop') return stopMacroRecord();
      if (message.type === 'macro-play') return playMacro();
      if (message.type === 'selectors-check') return checkSelectors(message);
      return { ok: true };
    }

    function startPick(field, featureIndex) {
      stopPick();
      picker = { field, featureIndex };
      box = document.createElement('div');
      box.id = 'mimic-hover-box';
      box.style.cssText = [
        'position:fixed',
        'margin:0',
        'inset:auto',
        'padding:0',
        'overflow:hidden',
        'pointer-events:none',
        'z-index:2147483647',
        'border:2px solid #d92d20',
        'background:rgba(217,45,32,.18)',
        'box-sizing:border-box',
        'width:0',
        'height:0',
      ].join(';');
      mountPickBox();
      window.addEventListener('message', onPickResult);
      window.postMessage({ source: 'mimic-isolated', type: 'pick-arm' }, '*');
      document.addEventListener('pointermove', onPickMove, true);
      document.addEventListener('pointerdown', onPickPointerDown, true);
      document.addEventListener('keydown', onPickKey, true);
      status('Наведите на элемент и кликните');
      return { ok: true };
    }

    function mountPickBox() {
      if (!box) return;
      const parent = document.documentElement || document.body;
      if (!parent) return;
      if (box.parentNode !== parent) parent.appendChild(box);
      try {
        if (typeof box.showPopover === 'function') {
          box.popover = 'manual';
          if (!box.matches(':popover-open')) box.showPopover();
        }
      } catch {
        /* рамка остаётся в документе */
      }
    }

    function unlisten(type, handler) {
      try {
        document.removeEventListener(type, handler, true);
      } catch {
        /* контекст снят */
      }
    }

    function onPickMove(event) {
      try {
        if (!alive()) {
          dispose();
          return;
        }
        const el = pickElement(event);
        if (!el || !box) return;
        mountPickBox();
        const rect = el.getBoundingClientRect();
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
    }

    function pickElement(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (node instanceof Element && node !== box && node.id !== 'mimic-hover-box') return node;
      }
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (!el || el === box || el.id === 'mimic-hover-box') return null;
      return el;
    }

    function finishPick(selected) {
      const current = picker;
      if (!current) return;
      notify({
        type: 'picked',
        field: current.field,
        featureIndex: current.featureIndex,
        selector: selected,
      });
      stopPick();
      status(selected ? `Селектор: ${selected}` : 'Не удалось построить селектор');
    }

    function onPickResult(event) {
      try {
        if (event.source !== window || event.data?.source !== 'mimic-main') return;
        if (!alive()) {
          dispose();
          return;
        }
        if (event.data.type === 'pick-cancel') {
          stopPick();
          return;
        }
        if (event.data.type !== 'pick-result' || !picker) return;
        finishPick(event.data.selector || '');
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
    }

    function onPickPointerDown(event) {
      try {
        if (!alive()) {
          dispose();
          return;
        }
        if (!picker || event.button !== 0) return;
        const onTelemost = location.hostname === 'telemost.yandex.ru';
        if (!onTelemost) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        }
        const selected = uniqueSelector(pickElement(event));
        if (onTelemost && !selected) return;
        finishPick(selected);
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
    }

    function onPickKey(event) {
      try {
        if (!alive()) {
          dispose();
          return;
        }
        if (event.key === 'Escape') stopPick();
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
    }

    function stopPick() {
      picker = null;
      try { box?.remove(); } catch { /* контекст снят */ }
      box = null;
      try { window.removeEventListener('message', onPickResult); } catch { /* слушатель уже снят */ }
      window.postMessage({ source: 'mimic-isolated', type: 'pick-disarm' }, '*');
      unlisten('pointermove', onPickMove);
      unlisten('pointerdown', onPickPointerDown);
      unlisten('keydown', onPickKey);
    }

    async function startMonitor() {
      const settings = await loadSettings();
      if (!settings.parentSelector || !settings.itemSelector) {
        status('Нужны селекторы родителя и элемента');
        return { ok: false };
      }
      try {
        document.querySelector(settings.parentSelector);
      } catch {
        status('Селектор родителя некорректен');
        return { ok: false };
      }
      cancelParentWait?.();
      monitor?.disconnect();
      const generation = ++monitorGeneration;
      tripped = false;
      seen = new WeakSet();
      hashes = new Set();
      status('Жду появления списка на странице');
      const parent = await waitForParent(settings.parentSelector, generation);
      if (!parent || generation !== monitorGeneration) return { ok: false };
      if (guard(settings)) return { ok: false };
      monitor = new MutationObserver((records) => {
        try {
          if (!alive()) {
            dispose();
            return;
          }
          if (guard(settings)) return;
          for (const record of records) collectAdded(record.addedNodes, settings);
        } catch {
          try { monitor?.disconnect(); } catch { /* контекст снят */ }
        }
      });
      monitor.observe(parent, { childList: true, subtree: true });
      status('Мониторинг запущен');
      return { ok: true };
    }

    function waitForParent(selector, generation) {
      let parent = null;
      try {
        parent = document.querySelector(selector);
      } catch {
        return Promise.resolve(null);
      }
      if (parent) return Promise.resolve(parent);
      return new Promise((resolve) => {
        const finish = (value) => {
          parentWait?.disconnect();
          parentWait = null;
          if (cancelParentWait === cancel) cancelParentWait = null;
          resolve(value);
        };
        const cancel = () => finish(null);
        cancelParentWait = cancel;
        parentWait = new MutationObserver(() => {
          try {
            if (!alive()) {
              try { parentWait?.disconnect(); } catch { /* контекст снят */ }
              finish(null);
              return;
            }
            if (generation !== monitorGeneration) {
              finish(null);
              return;
            }
            let found = null;
            try {
              found = document.querySelector(selector);
            } catch {
              found = null;
            }
            if (found) finish(found);
          } catch {
            try { parentWait?.disconnect(); } catch { /* контекст снят */ }
            finish(null);
          }
        });
        parentWait.observe(document.documentElement, { childList: true, subtree: true });
      });
    }

    function stopMonitor() {
      monitorGeneration += 1;
      cancelParentWait?.();
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
          notify({ type: 'item-found', data, url: location.href });
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
      notify({ type: 'failsafe', reason, url: location.href });
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
      unlisten('click', onMacroClick);
      unlisten('input', onMacroInput);
      unlisten('change', onMacroInput);
      notify({ type: 'macro-save', steps });
      status(`Макрос сохранён: ${steps.length}`);
      return { ok: true };
    }

    function onMacroClick(event) {
      try {
        if (!alive()) {
          dispose();
          return;
        }
        if (!recordingMacro || picker) return;
        const el = event.target instanceof Element ? event.target : null;
        if (!el || el.id === 'mimic-hover-box') return;
        const selected = uniqueSelector(el);
        if (!selected) return;
        steps.push({ type: 'click', selector: selected, value: '' });
        status(`Шаг: клик ${selected}`);
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
    }

    function onMacroInput(event) {
      try {
        if (!alive()) {
          dispose();
          return;
        }
        if (!recordingMacro || picker) return;
        const el = event.target;
        if (!isTextField(el)) return;
        const selected = uniqueSelector(el);
        if (!selected) return;
        const step = { type: 'input', selector: selected, value: fieldValue(el) };
        const last = steps[steps.length - 1];
        if (last && last.type === 'input' && last.selector === selected) last.value = step.value;
        else steps.push(step);
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
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
          try {
            if (!alive()) {
              obs.disconnect();
              clearTimeout(timer);
              resolve(null);
              return;
            }
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
          } catch {
            try { obs.disconnect(); } catch { /* контекст снят */ }
            clearTimeout(timer);
            resolve(null);
          }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        const timer = setTimeout(() => {
          obs.disconnect();
          resolve(null);
        }, timeout);
      });
    }

    function status(text) {
      notify({ type: 'status', text });
    }

    function disposePage() {
      stopMonitor();
      stopPick();
      recordingMacro = false;
      unlisten('click', onMacroClick);
      unlisten('input', onMacroInput);
      unlisten('change', onMacroInput);
    }

    return { handle, dispose: disposePage };
  }
})();
