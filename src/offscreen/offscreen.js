import { createUtteranceController, joinSpeakerNames } from '../lib/utterance.js';

const MIXED_ID = 'mixed';
const SPEECH_RMS = 0.02;

let held = null;
let ctl = null;
let mode = 'idle';
let sessionId = 0;
let activeNames = [];
let accumulated = new Set();
let timer = 0;
let chain = Promise.resolve();
let session = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;
  handle(message)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handle(message) {
  if (message.type === 'hold') return hold(message.streamId, message.sessionId);
  if (message.type === 'record-mixed') return recordMixed(message.sessionId, message.speakers);
  if (message.type === 'speakers') {
    activeNames = namesOf(message.speakers);
    return { ok: true };
  }
  if (message.type === 'stop') return stopAll();
  return { ok: true };
}

async function hold(streamId, nextSessionId) {
  if (!streamId) throw new Error('Нет streamId');
  if (held) return { ok: true };
  const stream = await openTabStream(streamId);
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) throw new Error('Во вкладке нет аудио');
  const audioOnly = new MediaStream(audioTracks);
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(audioOnly);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  source.connect(ctx.destination);
  await ctx.resume();
  held = {
    stream,
    audioOnly,
    ctx,
    source,
    analyser,
    bucket: new Uint8Array(analyser.fftSize),
  };
  for (const track of audioTracks) {
    track.addEventListener('ended', () => {
      try {
        chrome.runtime.sendMessage({ type: 'capture-ended' }).catch(() => {});
      } catch { /* вкладка или документ уже закрыты */ }
    }, { once: true });
  }
  sessionId = nextSessionId || Date.now();
  mode = 'hold';
  return { ok: true };
}

async function recordMixed(nextSessionId, speakers) {
  if (!held) throw new Error('Поток вкладки не захвачен');
  sessionId = nextSessionId || sessionId;
  activeNames = namesOf(speakers);
  accumulated = new Set(activeNames);
  ctl = createUtteranceController();
  mode = 'mixed';
  if (timer) clearInterval(timer);
  timer = setInterval(tickMixed, 50);
  return { ok: true };
}

function tickMixed() {
  if (mode !== 'mixed' || !held || !ctl) return;
  const now = Date.now();
  const level = rms(held.analyser, held.bucket);
  for (const name of activeNames) accumulated.add(name);
  const speaker = joinSpeakerNames([...accumulated, ...activeNames]);
  ctl.setSpeaker(MIXED_ID, speaker);
  if (level >= SPEECH_RMS) ctl.noteSpeech(MIXED_ID, now, speaker);
  else ctl.noteSilence(MIXED_ID, now);
  ctl.tick(now);
  drain();
}

async function stopAll() {
  if (timer) clearInterval(timer);
  timer = 0;
  if (ctl && mode === 'mixed') {
    ctl.flush(Date.now());
    drain();
  }
  mode = 'idle';
  await chain;
  await closeRecorder();
  if (held) {
    for (const track of held.stream.getTracks()) track.stop();
    await held.ctx.close().catch(() => {});
    held = null;
  }
  ctl = null;
  return { ok: true };
}

function drain() {
  if (!ctl) return;
  for (const action of ctl.drainActions()) {
    chain = chain.then(() => apply(action), () => apply(action));
  }
}

async function apply(action) {
  if (action.kind === 'open') {
    accumulated = new Set(activeNames);
    const speaker = joinSpeakerNames([...accumulated]);
    ctl?.setSpeaker(MIXED_ID, speaker);
    await startRecorder(action.at);
    return;
  }
  if (action.kind === 'close') {
    const speaker = accumulated.size
      ? joinSpeakerNames([...accumulated])
      : (action.speaker || 'unknown');
    await finishRecorder(action, speaker);
  }
}

async function startRecorder(startedAt) {
  await closeRecorder();
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  const chunks = [];
  const rec = new MediaRecorder(held.audioOnly, { mimeType: mime });
  rec.addEventListener('dataavailable', (event) => {
    if (event.data?.size) chunks.push(event.data);
  });
  rec.start(250);
  session = { rec, chunks, startedAt };
}

async function finishRecorder(action, speaker) {
  const blob = await takeBlob();
  if (!blob || blob.size < 64) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await chrome.runtime.sendMessage({
    type: 'audio-chunk',
    buffer: bytes,
    speaker,
    startedAt: action.startedAt,
    endedAt: action.at,
    trackId: MIXED_ID,
    sessionId,
  });
}

function takeBlob() {
  const current = session;
  session = null;
  if (!current) return Promise.resolve(null);
  if (current.rec.state === 'inactive') {
    return Promise.resolve(current.chunks.length ? new Blob(current.chunks, { type: 'audio/webm' }) : null);
  }
  return new Promise((resolve) => {
    current.rec.addEventListener('stop', () => {
      resolve(current.chunks.length ? new Blob(current.chunks, { type: 'audio/webm' }) : null);
    }, { once: true });
    current.rec.stop();
  });
}

async function closeRecorder() {
  if (!session) return;
  await takeBlob();
}

async function openTabStream(streamId) {
  const audio = {
    mandatory: {
      chromeMediaSource: 'tab',
      chromeMediaSourceId: streamId,
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch {
    return navigator.mediaDevices.getUserMedia({
      audio,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
  }
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

function namesOf(speakers) {
  if (!Array.isArray(speakers)) return [];
  return speakers.map((speaker) => (typeof speaker === 'string' ? speaker : speaker?.name)).filter(Boolean);
}
