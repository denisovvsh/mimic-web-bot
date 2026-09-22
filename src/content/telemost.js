(() => {
  const previous = globalThis.__mimicTelemostApi;
  if (previous?.alive) {
    let live = false;
    try { live = previous.alive(); } catch { live = false; }
    if (live) return;
    try { previous.dispose(); } catch { /* старый контекст уже мёртв */ }
  }

  let disposed = false;

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
    armed = false;
    try { stopObserve(); } catch { /* наблюдатель уже снят */ }
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* контекст снят */ }
    try { window.removeEventListener('message', onWindowMessage); } catch { /* слушатель уже снят */ }
    if (globalThis.__mimicTelemostApi?.dispose === dispose) globalThis.__mimicTelemostApi = null;
  }

  function reply(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch {
      dispose();
    }
  }

  function notify(message) {
    if (!alive()) {
      dispose();
      return Promise.resolve();
    }
    try {
      return chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      dispose();
      return Promise.resolve();
    }
  }

  globalThis.__mimicTelemostApi = { alive, dispose };

  let telemost = {};
  let armed = false;
  let armedAt = 0;
  let observer = null;
  let scanTimer = 0;
  let remoteAudio = 0;
  let hearing = true;
  let lastSpeakerKey = '';
  let shouldFallbackToMixed = () => false;

  import(chrome.runtime.getURL('src/lib/fallback.js')).then((mod) => {
    shouldFallbackToMixed = mod.shouldFallbackToMixed;
  }).catch(() => {});
  let fallbackSent = false;
  let fallbackAttemptAt = 0;
  let seenMeeting = false;
  let seenTiles = false;
  let gridMissingSince = 0;
  let endSent = false;
  let meetingEnded = () => false;
  let pageReadyAt = document.readyState === 'complete' ? Date.now() : 0;
  document.addEventListener('readystatechange', () => {
    if (document.readyState === 'complete') pageReadyAt = Date.now();
  });
  const namesSeen = new Set();

  import(chrome.runtime.getURL('src/lib/watch.js')).then((mod) => {
    meetingEnded = mod.meetingEnded;
  }).catch(() => {});

  function onMessage(message, _sender, sendResponse) {
    try {
    if (message?.target !== 'telemost') return;
    if (!alive()) {
      dispose();
      return;
    }
    if (message.type === 'arm') {
      telemost = message.settings?.telemost || {};
      armed = true;
      armedAt = Date.now();
      fallbackSent = false;
      namesSeen.clear();
      window.postMessage({
        source: 'mimic-isolated',
        type: 'arm',
        sessionId: message.sessionId,
      }, '*');
      startObserve();
      reply(sendResponse, { ok: true });
      return true;
    }
    if (message.type === 'settings') {
      telemost = message.settings?.telemost || telemost;
      reply(sendResponse, { ok: true });
      return true;
    }
    if (message.type === 'selectors-check') {
      const list = Array.isArray(message.selectors) ? message.selectors : [];
      const states = list.map((selector) => {
        try {
          const value = String(selector || '').trim();
          if (!value) return 'empty';
          const found = document.querySelector(value);
          if (found) return 'ok';
          if (!pageReadyAt || Date.now() - pageReadyAt < 5000) return 'pending';
          return 'missing';
        } catch {
          return 'invalid';
        }
      });
      reply(sendResponse, { ok: true, states });
      return true;
    }
    if (message.type === 'disarm' || message.type === 'disarm-tracks') {
      window.postMessage({ source: 'mimic-isolated', type: message.type }, '*');
      if (message.type === 'disarm') {
        armed = false;
        stopObserve();
      }
      reply(sendResponse, { ok: true });
      return true;
    }
    return false;
    } catch {
      try { dispose(); } catch { /* контекст снят */ }
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener('pagehide', () => {
    try { dispose(); } catch { /* страница закрывается */ }
  }, { once: true });

  function onWindowMessage(event) {
    try {
    if (event.source !== window || event.data?.source !== 'mimic-main') return;
    if (event.data.type === 'tracks') {
      remoteAudio = Number(event.data.remote) || 0;
      if (typeof event.data.hearing === 'boolean') hearing = event.data.hearing;
      return;
    }
    if (event.data.type === 'audio' && event.data.buffer) {
      notify({
        type: 'audio-chunk',
        buffer: event.data.buffer,
        speaker: event.data.speaker,
        startedAt: event.data.startedAt,
        endedAt: event.data.endedAt,
        trackId: event.data.trackId,
        sessionId: event.data.sessionId,
      });
    }
    } catch {
      try { dispose(); } catch { /* контекст снят */ }
    }
  }

  window.addEventListener('message', onWindowMessage);

  function startObserve() {
    stopObserve();
    observer = new MutationObserver(() => {
      try {
        scan();
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
    });
    const root = document.documentElement || document;
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-speaking'],
    });
    scanTimer = setInterval(() => {
      try {
        if (!alive()) {
          dispose();
          return;
        }
        if (armed) scan();
      } catch {
        try { dispose(); } catch { /* контекст снят */ }
      }
    }, 300);
    scan();
  }

  function stopObserve() {
    observer?.disconnect();
    observer = null;
    clearInterval(scanTimer);
    scanTimer = 0;
    lastSpeakerKey = '';
  }

  function scan() {
    if (!alive()) {
      dispose();
      return;
    }
    if (!armed || endSent) return;
    const gridSelector = String(telemost.gridSelector || '').trim();
    const gridRequired = Boolean(gridSelector);
    let grid = document;
    let gridFound = true;
    if (gridRequired) {
      try {
        grid = document.querySelector(gridSelector);
      } catch {
        grid = null;
      }
      gridFound = Boolean(grid);
    }
    const tileSelector = String(telemost.tileSelector || '').trim();
    const trackTiles = Boolean(tileSelector);
    const tiles = grid ? findTiles(grid) : [];
    if (trackTiles && tiles.length > 0) seenTiles = true;
    const meetingVisible = gridRequired ? gridFound : trackTiles && tiles.length > 0;
    if (meetingVisible) {
      seenMeeting = true;
      gridMissingSince = 0;
    } else if (seenMeeting && (gridRequired || trackTiles)) {
      if (!gridMissingSince) gridMissingSince = Date.now();
      if (meetingEnded({
        seenMeeting,
        gridRequired,
        gridFound,
        seenTiles,
        tileCount: tiles.length,
        missingForMs: Date.now() - gridMissingSince,
      })) {
        endSent = true;
        armed = false;
        notify({
          type: 'conference-ended',
          reason: 'Сетка участников недоступна, запись остановлена',
        });
      }
      return;
    }
    const speakers = [];
    let remoteTiles = 0;
    for (const tile of tiles) {
      const name = tileName(tile);
      if (!name) continue;
      const local = isLocal(name);
      if (!local) {
        remoteTiles += 1;
        namesSeen.add(name);
      }
      if (isSpeaking(tile)) speakers.push({ name, local });
    }
    const speakerKey = JSON.stringify(speakers);
    if (speakerKey !== lastSpeakerKey) {
      lastSpeakerKey = speakerKey;
      window.postMessage({ source: 'mimic-isolated', type: 'speakers', speakers }, '*');
      notify({ type: 'speakers', speakers });
    }
    maybeFallback(remoteTiles);
  }

  function maybeFallback(remoteTiles) {
    if (!armed || fallbackSent) return;
    if (!shouldFallbackToMixed({
      remoteAudio,
      remoteTiles,
      hearing,
      elapsedMs: Date.now() - armedAt,
    })) return;
    if (Date.now() - fallbackAttemptAt < 2000) return;
    fallbackAttemptAt = Date.now();
    notify({
      type: 'fallback-mixed',
      speakers: [...namesSeen],
    }).then((response) => {
      if (response?.ok) fallbackSent = true;
    });
  }

  function findTiles(root) {
    const tileSelector = String(telemost.tileSelector || '').trim();
    if (tileSelector) {
      try {
        return [...root.querySelectorAll(tileSelector)];
      } catch {
        return [];
      }
    }
    const tiles = [];
    for (const video of root.querySelectorAll('video')) {
      const tile = tileRoot(video);
      if (tile && !tiles.includes(tile)) tiles.push(tile);
    }
    return tiles;
  }

  function tileRoot(video) {
    let node = video.parentElement;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      if (tileName(node)) return node;
      node = node.parentElement;
    }
    return video.parentElement;
  }

  function tileName(el) {
    const nameSelector = String(telemost.nameSelector || '').trim();
    if (nameSelector) {
      try {
        const named = el.querySelector(nameSelector);
        const text = named?.innerText?.trim().split('\n')[0] || '';
        if (text) return text.slice(0, 80);
      } catch {
        return '';
      }
    }
    const named = el.querySelector('[class*="name"], [class*="Name"], [data-testid*="name"]');
    const text = named?.innerText?.trim().split('\n')[0] || '';
    return text.slice(0, 80);
  }

  function isLocal(name) {
    const markers = String(telemost.localMarkers || 'Вы')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return markers.some((marker) => name === marker || name.startsWith(`${marker} `));
  }

  function isSpeaking(el) {
    const speakingSelector = String(telemost.speakingSelector || '').trim();
    if (speakingSelector) {
      try {
        return el.matches(speakingSelector) || Boolean(el.querySelector(speakingSelector));
      } catch {
        return false;
      }
    }
    const nodes = [el, ...el.querySelectorAll('[class], [style]')].slice(0, 40);
    return nodes.some((node) => {
      const blob = `${node.className || ''} ${[...node.attributes].map((attr) => `${attr.name}=${attr.value}`).join(' ')}`;
      return /speak|voice-active|mic-on|audio-level|active-speaker/i.test(blob);
    });
  }
})();
