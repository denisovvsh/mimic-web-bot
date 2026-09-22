export const UTTERANCE = {
  normalDebounceMs: 800,
  softSplitAtMs: 20_000,
  softPauseMs: 500,
  hardCapMs: 30_000,
};

export function sanitizeSpeakerName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
  return cleaned || 'unknown';
}

export function joinSpeakerNames(names) {
  const unique = [];
  for (const name of names || []) {
    const clean = sanitizeSpeakerName(name);
    if (!String(name ?? '').trim()) continue;
    if (!unique.includes(clean)) unique.push(clean);
  }
  return unique.join('+') || 'unknown';
}

export function audioFilename({ startedAt, speaker, trackId }) {
  const id = String(trackId || 'track').replace(/[^\w.-]+/g, '').slice(0, 32) || 'track';
  return `telemost/${startedAt}__${sanitizeSpeakerName(speaker)}__${id}.webm`;
}

function blankTrack(speaker) {
  return {
    phase: 'idle',
    speaker: speaker || 'unknown',
    startedAt: 0,
    silenceAt: 0,
  };
}

export function createUtteranceController(options = {}) {
  const cfg = { ...UTTERANCE, ...options };
  const tracks = new Map();
  let actions = [];

  function closeTrack(track, trackId, at, reason) {
    actions.push({
      kind: 'close',
      trackId,
      speaker: track.speaker,
      at,
      startedAt: track.startedAt,
      reason,
    });
    if (reason === 'hard-cap' && track.phase === 'recording') {
      track.startedAt = at;
      track.silenceAt = 0;
      track.phase = 'recording';
      actions.push({
        kind: 'open',
        trackId,
        speaker: track.speaker,
        at,
      });
      return;
    }
    track.phase = 'idle';
    track.silenceAt = 0;
  }

  function noteSpeech(trackId, now, speaker) {
    let track = tracks.get(trackId);
    if (!track) {
      track = blankTrack(speaker);
      tracks.set(trackId, track);
    }
    if (speaker) track.speaker = speaker;
    if (track.phase === 'idle') {
      track.phase = 'recording';
      track.startedAt = now;
      track.silenceAt = 0;
      actions.push({
        kind: 'open',
        trackId,
        speaker: track.speaker,
        at: now,
      });
      return;
    }
    if (track.phase === 'pausing') {
      track.phase = 'recording';
      track.silenceAt = 0;
    }
  }

  function noteSilence(trackId, now) {
    const track = tracks.get(trackId);
    if (!track || track.phase === 'idle') return;
    if (track.phase === 'recording') {
      track.phase = 'pausing';
      track.silenceAt = now;
    }
  }

  function setSpeaker(trackId, speaker) {
    if (!speaker) return;
    let track = tracks.get(trackId);
    if (!track) {
      track = blankTrack(speaker);
      tracks.set(trackId, track);
    }
    track.speaker = speaker;
  }

  function endTrack(trackId, now) {
    const track = tracks.get(trackId);
    if (!track || track.phase === 'idle') return;
    closeTrack(track, trackId, now, 'end');
  }

  function flush(now) {
    for (const [trackId, track] of tracks) {
      if (track.phase === 'idle') continue;
      closeTrack(track, trackId, now, 'end');
    }
  }

  function tick(now) {
    for (const [trackId, track] of tracks) {
      if (track.phase === 'idle') continue;
      const capAt = track.startedAt + cfg.hardCapMs;
      if (track.phase === 'pausing') {
        if (now >= capAt) {
          closeTrack(track, trackId, capAt, 'hard-cap');
          continue;
        }
        const silentFor = now - track.silenceAt;
        if (silentFor >= cfg.normalDebounceMs) {
          closeTrack(track, trackId, now, 'end');
          continue;
        }
        if (now - track.startedAt >= cfg.softSplitAtMs && silentFor >= cfg.softPauseMs) {
          closeTrack(track, trackId, now, 'soft-pause');
        }
        continue;
      }
      if (now >= capAt) closeTrack(track, trackId, capAt, 'hard-cap');
    }
  }

  return {
    noteSpeech,
    noteSilence,
    setSpeaker,
    tick,
    flush,
    endTrack,
    drainActions() {
      const out = actions;
      actions = [];
      return out;
    },
    getTrack(trackId) {
      const track = tracks.get(trackId);
      return track ? { ...track } : null;
    },
  };
}
