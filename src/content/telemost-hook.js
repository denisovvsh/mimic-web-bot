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
  const selectorReady = import(chrome.runtime.getURL('src/lib/selector.js'))
    .then((mod) => { uniqueSelector = mod.uniqueSelector; })
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
    const { createUtteranceController } = await import(chrome.runtime.getURL('src/lib/utterance.js'));
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
      source.connect(analyser);
      const info = {
        id: trackId,
        track,
        stream,
        analyser,
        bucket: new Uint8Array(analyser.fftSize),
        local: Boolean(local),
        speaker: '',
        unknownLabel: '',
        hot: false,
      };
      tracks.set(trackId, info);
      track.addEventListener('ended', () => {
        ctl.endTrack(trackId, Date.now());
        drain();
        chain = chain.then(() => {
          tracks.delete(trackId);
          publishCounts(true);
        });
      });
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
      const hearing = audioCtx?.state === 'running';
      const key = `${remote}:${local}:${hearing ? 1 : 0}`;
      const now = Date.now();
      if (!force && key === publishedKey && now - publishedAt < 1000) return;
      publishedKey = key;
      publishedAt = now;
      window.postMessage({
        source: 'mimic-main',
        type: 'tracks',
        remote,
        local,
        hearing: audioCtx?.state === 'running',
      }, '*');
    }

    function assign(info, name) {
      info.speaker = name;
      ctl.setSpeaker(info.id, name);
    }

    function bindSpeakers() {
      const hot = [...tracks.values()].filter((info) => info.hot && !info.speaker);
      const used = new Set([...tracks.values()].map((info) => info.speaker).filter(Boolean));
      const free = domSpeakers.filter((speaker) => speaker.name && !used.has(speaker.name));
      if (hot.length === 1 && free.length === 1) {
        assign(hot[0], free[0].name);
        return;
      }
      const hotLocal = hot.filter((info) => info.local);
      const hotRemote = hot.filter((info) => !info.local);
      const freeLocal = free.filter((speaker) => speaker.local);
      const freeRemote = free.filter((speaker) => !speaker.local);
      if (hotLocal.length === 1 && freeLocal.length === 1) assign(hotLocal[0], freeLocal[0].name);
      if (hotRemote.length === 1 && freeRemote.length === 1) assign(hotRemote[0], freeRemote[0].name);
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

    function handleMessage(data) {
      if (data.type === 'arm') {
        mode = 'tracks';
        sessionId = data.sessionId || Date.now();
        audioCtx?.resume().catch(() => {});
        publishCounts();
        return;
      }
      if (data.type === 'speakers') {
        domSpeakers = Array.isArray(data.speakers) ? data.speakers : [];
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

    setInterval(() => {
      const now = Date.now();
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
      if (mode === 'tracks') {
        for (const info of tracks.values()) {
          if (info.track.readyState !== 'live') {
            ctl.noteSilence(info.id, now);
            continue;
          }
          info.hot = rms(info.analyser, info.bucket) >= SPEECH_RMS;
          if (info.hot) ctl.noteSpeech(info.id, now, info.speaker || undefined);
          else ctl.noteSilence(info.id, now);
        }
        bindSpeakers();
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
