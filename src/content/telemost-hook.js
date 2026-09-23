(() => {
  if (window.__mimicHook) return;
  window.__mimicHook = true;

  const SPEECH_RMS = 0.02;
  const pendingTracks = [];
  const pendingMessages = [];
  let onTrack = (track, local) => {
    if (track?.kind === 'audio') pendingTracks.push({ track, local });
  };
  let onWindowMessage = (data) => pendingMessages.push(data);

  let pickOn = false;
  let pickBox = null;
  let uniqueSelector = () => '';

  function extensionBase() {
    try {
      const getURL = chrome?.runtime?.getURL;
      if (typeof getURL === 'function') return getURL.call(chrome.runtime, '');
    } catch {
      /* в основном мире страницы этого метода нет */
    }
    return document.documentElement?.dataset?.mimicExt || '';
  }

  function extensionUrl(path) {
    let base = String(extensionBase() || '').trim();
    const file = String(path || '').replace(/^\/+/, '');
    if (!base || !file) return '';
    if (!base.endsWith('/')) base += '/';
    try {
      return new URL(file, base).href;
    } catch {
      return '';
    }
  }

  function whenExtensionUrl(path) {
    const ready = extensionUrl(path);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const url = extensionUrl(path);
        if (url || Date.now() - started > 2000) {
          clearInterval(timer);
          resolve(url);
        }
      }, 20);
    });
  }

  const selectorReady = whenExtensionUrl('src/lib/selector.js')
    .then((url) => (url ? import(url) : null))
    .then((mod) => { if (mod?.uniqueSelector) uniqueSelector = mod.uniqueSelector; })
    .catch(() => {});

  function pickTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (node instanceof Element && node.id !== 'mimic-hover-box') return node;
    }
    const found = document.elementFromPoint(event.clientX, event.clientY);
    if (found instanceof Element && found.id !== 'mimic-hover-box') return found;
    return null;
  }

  function showPickBox(el) {
    if (!pickBox?.isConnected) {
      pickBox = document.getElementById('mimic-hover-box');
      if (!pickBox) {
        pickBox = document.createElement('div');
        pickBox.id = 'mimic-hover-box';
        pickBox.style.cssText = [
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
      }
      const parent = document.documentElement || document.body;
      if (pickBox.parentNode !== parent) parent.append(pickBox);
      try {
        if (typeof pickBox.showPopover === 'function') {
          pickBox.popover = 'manual';
          if (!pickBox.matches(':popover-open')) pickBox.showPopover();
        }
      } catch {
        /* рамка остаётся в документе */
      }
    }
    const rect = el.getBoundingClientRect();
    pickBox.style.left = `${rect.left}px`;
    pickBox.style.top = `${rect.top}px`;
    pickBox.style.width = `${rect.width}px`;
    pickBox.style.height = `${rect.height}px`;
  }

  function clearPick() {
    pickOn = false;
    try { pickBox?.remove(); } catch { /* узел уже снят */ }
    pickBox = null;
  }

  document.addEventListener('pointermove', (event) => {
    if (!pickOn) return;
    const el = pickTarget(event);
    if (el) showPickBox(el);
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (!pickOn || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const el = pickTarget(event);
    clearPick();
    selectorReady.then(() => {
      let selector = '';
      try { selector = el ? uniqueSelector(el) : ''; } catch { selector = ''; }
      window.postMessage({ source: 'mimic-main', type: 'pick-result', selector }, '*');
    });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!pickOn || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    clearPick();
    window.postMessage({ source: 'mimic-main', type: 'pick-cancel' }, '*');
  }, true);

  installPatches();
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'mimic-isolated') return;
    if (event.data.type === 'pick-arm') {
      pickOn = true;
      return;
    }
    if (event.data.type === 'pick-disarm') {
      clearPick();
      return;
    }
    onWindowMessage(event.data);
  });

  boot().catch(() => {});

  function installPatches() {
    const Original = window.RTCPeerConnection;
    if (typeof Original === 'function' && !Original.__mimic) {
      function Wrapped(config) {
        const pc = new Original(config);
        pc.addEventListener('track', (event) => onTrack(event.track, false));
        const addTrack = pc.addTrack?.bind(pc);
        if (addTrack) {
          pc.addTrack = (track, ...rest) => {
            onTrack(track, true);
            return addTrack(track, ...rest);
          };
        }
        const addTransceiver = pc.addTransceiver?.bind(pc);
        if (addTransceiver) {
          pc.addTransceiver = (trackOrKind, init) => {
            const result = addTransceiver(trackOrKind, init);
            const track = trackOrKind instanceof MediaStreamTrack ? trackOrKind : result?.sender?.track;
            onTrack(track, true);
            return result;
          };
        }
        return pc;
      }
      Wrapped.prototype = Original.prototype;
      Object.setPrototypeOf(Wrapped, Original);
      Wrapped.__mimic = true;
      window.RTCPeerConnection = Wrapped;
    }

    const media = navigator.mediaDevices;
    if (media?.getUserMedia && !media.getUserMedia.__mimic) {
      const originalGetUserMedia = media.getUserMedia.bind(media);
      const wrappedGetUserMedia = async (constraints) => {
        const stream = await originalGetUserMedia(constraints);
        if (constraints?.audio) {
          for (const track of stream.getAudioTracks()) onTrack(track, true);
        }
        return stream;
      };
      wrappedGetUserMedia.__mimic = true;
      media.getUserMedia = wrappedGetUserMedia;
    }
  }

  async function boot() {
    const [utteranceUrl, fallbackUrl] = await Promise.all([
      whenExtensionUrl('src/lib/utterance.js'),
      whenExtensionUrl('src/lib/fallback.js'),
    ]);
    if (!utteranceUrl || !fallbackUrl) return;
    const [{ createUtteranceController }, { levelsReadable }] = await Promise.all([
      import(utteranceUrl),
      import(fallbackUrl),
    ]);
    const ctl = createUtteranceController();
    const tracks = new Map();
    let audioCtx = null;
    let mode = 'off';
    let sessionId = 0;
    let chain = Promise.resolve();
    let unknownSeq = 0;
    let domSpeakers = [];
    let publishedKey = '';
    let publishedAt = 0;
    const recorders = new Map();

    window.addEventListener('pointerdown', () => audioCtx?.resume().catch(() => {}), true);

    function context() {
      if (!audioCtx) audioCtx = new AudioContext();
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
      return audioCtx;
    }

    function watchTrack(track, local) {
      if (!track || track.kind !== 'audio') return;
      const trackId = track.id || `audio-${Math.random().toString(36).slice(2)}`;
      if (tracks.has(trackId)) return;
      const ctx = context();
      const stream = new MediaStream([track]);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(analyser);
      source.connect(silent);
      silent.connect(ctx.destination);
      const sink = attachSink(stream, ctx);
      const info = {
        id: trackId,
        track,
        stream,
        source,
        silent,
        analyser,
        bucket: new Uint8Array(analyser.fftSize),
        local: Boolean(local),
        speaker: '',
        unknownLabel: '',
        hot: false,
        sink: sink.element,
        elementSource: sink.elementSource,
        elementMute: sink.elementMute,
      };
      tracks.set(trackId, info);
      track.addEventListener('ended', () => {
        ctl.endTrack(trackId, Date.now());
        drain();
        chain = chain.then(() => {
          releaseTrack(info);
          tracks.delete(trackId);
          publishCounts(true);
        });
      });
    }

    // Chrome не декодирует чужой WebRTC-трек в Analyser, пока его не играет audio-элемент.
    // Громкость элемента ненулевая, в динамики звук не идёт: выход забран в GainNode.
    function attachSink(stream, ctx) {
      const el = document.createElement('audio');
      el.dataset.mimicSink = '1';
      el.srcObject = stream;
      el.volume = 1;
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
      let elementSource = null;
      let elementMute = null;
      try {
        elementSource = ctx.createMediaElementSource(el);
        elementMute = ctx.createGain();
        elementMute.gain.value = 0;
        elementSource.connect(elementMute);
        elementMute.connect(ctx.destination);
      } catch {
        el.volume = 0.001;
      }
      mountSink(el);
      el.play().catch(() => {});
      return { element: el, elementSource, elementMute };
    }

    function mountSink(el) {
      if (!el || el.isConnected) return;
      const parent = document.documentElement || document.body;
      if (parent) parent.append(el);
    }

    function detachSink(info) {
      const el = info?.sink;
      if (!el) return;
      try { el.pause(); } catch { /* уже остановлен */ }
      try { el.srcObject = null; } catch { /* поток уже снят */ }
      try { el.remove(); } catch { /* узел уже снят */ }
      info.sink = null;
    }

    function releaseTrack(info) {
      detachSink(info);
      try { info.elementSource?.disconnect(); } catch { /* уже отключён */ }
      try { info.elementMute?.disconnect(); } catch { /* уже отключён */ }
      try { info.silent?.disconnect(); } catch { /* уже отключён */ }
      try { info.source?.disconnect(); } catch { /* уже отключён */ }
    }

    onTrack = watchTrack;
    for (const item of pendingTracks.splice(0)) watchTrack(item.track, item.local);

    function publishCounts(force) {
      let remote = 0;
      let local = 0;
      for (const info of tracks.values()) {
        if (info.local) local += 1;
        else remote += 1;
      }
      const hearing = levelsReadable({ contextRunning: audioCtx?.state === 'running' });
      const now = Date.now();
      const key = `${remote}:${local}:${hearing ? 1 : 0}`;
      if (!force && key === publishedKey && now - publishedAt < 1000) return;
      publishedKey = key;
      publishedAt = now;
      window.postMessage({
        source: 'mimic-main',
        type: 'tracks',
        remote,
        local,
        hearing,
      }, '*');
    }

    function assign(info, name) {
      info.speaker = name;
      ctl.setSpeaker(info.id, name);
    }

    let labelTracks = () => [];
    whenExtensionUrl('src/lib/watch.js').then((url) => (url ? import(url) : null)).then((mod) => {
      if (mod?.labelTracks) labelTracks = mod.labelTracks;
    }).catch(() => {});

    function bindSpeakers() {
      const rows = [...tracks.values()].map((info) => ({
        id: info.id,
        local: info.local,
        speaker: info.speaker,
        hot: info.hot,
      }));
      for (const assignment of labelTracks(rows, domSpeakers)) {
        const info = tracks.get(assignment.id);
        if (info) assign(info, assignment.name);
      }
    }

    function rememberSpeakers() {
      for (const info of tracks.values()) {
        if (info.track.readyState !== 'live') {
          info.hot = false;
          continue;
        }
        info.hot = rms(info.analyser, info.bucket) >= SPEECH_RMS;
      }
      bindSpeakers();
    }

    function labelOf(info, action) {
      if (info?.speaker) return info.speaker;
      if (action.speaker && action.speaker !== 'unknown') return action.speaker;
      if (info && !info.unknownLabel) {
        unknownSeq += 1;
        info.unknownLabel = `unknown-${unknownSeq}`;
      }
      return info?.unknownLabel || 'unknown';
    }

    function drain() {
      for (const action of ctl.drainActions()) {
        chain = chain.then(() => apply(action), () => apply(action));
      }
    }

    async function apply(action) {
      if (mode !== 'tracks' && action.kind === 'open') return;
      if (action.kind === 'open') {
        await startRecorder(action);
        return;
      }
      if (action.kind === 'close') await stopRecorder(action);
    }

    async function startRecorder(action) {
      const info = tracks.get(action.trackId);
      if (!info) return;
      await stopRecorder({ ...action, kind: 'close', at: action.at, startedAt: action.at, speaker: action.speaker });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const chunks = [];
      const rec = new MediaRecorder(info.stream, { mimeType: mime });
      rec.addEventListener('dataavailable', (event) => {
        if (event.data?.size) chunks.push(event.data);
      });
      rec.start(250);
      recorders.set(action.trackId, { rec, chunks, startedAt: action.at });
    }

    async function stopRecorder(action) {
      const session = recorders.get(action.trackId);
      if (!session) return;
      recorders.delete(action.trackId);
      const blob = await blobFrom(session);
      if (!blob || blob.size < 64) return;
      const info = tracks.get(action.trackId);
      window.postMessage({
        source: 'mimic-main',
        type: 'audio',
        buffer: new Uint8Array(await blob.arrayBuffer()),
        speaker: labelOf(info, action),
        startedAt: session.startedAt,
        endedAt: action.at,
        trackId: action.trackId,
        local: info ? Boolean(info.local) : true,
        sessionId,
      }, '*');
    }

    function blobFrom(session) {
      if (session.rec.state === 'inactive') {
        return Promise.resolve(session.chunks.length ? new Blob(session.chunks, { type: 'audio/webm' }) : null);
      }
      return new Promise((resolve) => {
        session.rec.addEventListener('stop', () => {
          resolve(session.chunks.length ? new Blob(session.chunks, { type: 'audio/webm' }) : null);
        }, { once: true });
        session.rec.stop();
      });
    }

    function elementTrackLocal(track) {
      try {
        return Boolean(track.getSettings?.().deviceId);
      } catch {
        return false;
      }
    }

    function collectElementTracks() {
      for (const node of document.querySelectorAll('audio, video')) {
        if (node.dataset.mimicSink) continue;
        const stream = node.srcObject;
        if (!stream || typeof stream.getAudioTracks !== 'function') continue;
        for (const track of stream.getAudioTracks()) watchTrack(track, elementTrackLocal(track));
      }
    }

    function handleMessage(data) {
      if (data.type === 'arm') {
        mode = 'tracks';
        sessionId = data.sessionId || Date.now();
        context();
        collectElementTracks();
        publishCounts(true);
        return;
      }
      if (data.type === 'speakers') {
        domSpeakers = Array.isArray(data.speakers) ? data.speakers : [];
        rememberSpeakers();
        return;
      }
      if (data.type === 'disarm' || data.type === 'disarm-tracks') {
        mode = 'off';
        ctl.flush(Date.now());
        drain();
        chain = chain.then(() => publishCounts());
      }
    }

    onWindowMessage = handleMessage;
    for (const message of pendingMessages.splice(0)) handleMessage(message);

    let elementScan = 0;
    setInterval(() => {
      const now = Date.now();
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
      if (mode === 'tracks') {
        elementScan += 1;
        if (elementScan % 20 === 1) collectElementTracks();
        for (const info of tracks.values()) {
          if (info.sink) {
            mountSink(info.sink);
            if (info.sink.paused) info.sink.play().catch(() => {});
          }
          if (info.track.readyState !== 'live') {
            ctl.noteSilence(info.id, now);
            continue;
          }
          info.hot = rms(info.analyser, info.bucket) >= SPEECH_RMS;
          if (info.hot) ctl.noteSpeech(info.id, now, info.speaker || undefined);
          else ctl.noteSilence(info.id, now);
        }
        ctl.tick(now);
        drain();
      }
      publishCounts();
    }, 50);
  }

  function rms(analyser, bucket) {
    analyser.getByteTimeDomainData(bucket);
    let sum = 0;
    for (let i = 0; i < bucket.length; i += 1) {
      const value = (bucket[i] - 128) / 128;
      sum += value * value;
    }
    return Math.sqrt(sum / bucket.length);
  }
})();
