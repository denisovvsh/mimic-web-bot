(() => {
  if (globalThis.__mimicTelemost) return;
  globalThis.__mimicTelemost = true;

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
  const namesSeen = new Set();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'telemost') return;
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
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'settings') {
      telemost = message.settings?.telemost || telemost;
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'disarm' || message.type === 'disarm-tracks') {
      window.postMessage({ source: 'mimic-isolated', type: message.type }, '*');
      if (message.type === 'disarm') {
        armed = false;
        stopObserve();
      }
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'mimic-main') return;
    if (event.data.type === 'tracks') {
      remoteAudio = Number(event.data.remote) || 0;
      if (typeof event.data.hearing === 'boolean') hearing = event.data.hearing;
      return;
    }
    if (event.data.type === 'audio' && event.data.buffer) {
      chrome.runtime.sendMessage({
        type: 'audio-chunk',
        buffer: event.data.buffer,
        speaker: event.data.speaker,
        startedAt: event.data.startedAt,
        endedAt: event.data.endedAt,
        trackId: event.data.trackId,
        sessionId: event.data.sessionId,
      }).catch(() => {});
    }
  });

  function startObserve() {
    stopObserve();
    observer = new MutationObserver(() => scan());
    const root = document.documentElement || document;
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-speaking'],
    });
    scanTimer = setInterval(() => {
      if (armed) scan();
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
    if (!armed) return;
    const tiles = findTiles();
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
      chrome.runtime.sendMessage({ type: 'speakers', speakers }).catch(() => {});
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
    chrome.runtime.sendMessage({
      type: 'fallback-mixed',
      speakers: [...namesSeen],
    }).then((response) => {
      if (response?.ok) fallbackSent = true;
    }).catch(() => {});
  }

  function findTiles() {
    const tileSelector = String(telemost.tileSelector || '').trim();
    if (tileSelector) {
      try {
        return [...document.querySelectorAll(tileSelector)];
      } catch {
        return [];
      }
    }
    let root = document;
    const gridSelector = String(telemost.gridSelector || '').trim();
    if (gridSelector) {
      try {
        root = document.querySelector(gridSelector) || document;
      } catch {
        root = document;
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
