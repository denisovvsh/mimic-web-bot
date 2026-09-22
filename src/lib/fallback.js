const FALLBACK_AFTER_MS = 8000;

export function shouldFallbackToMixed({ remoteAudio, remoteTiles, hearing, elapsedMs }) {
  if (elapsedMs < FALLBACK_AFTER_MS) return false;
  const serverMix = remoteAudio === 1 && remoteTiles >= 2;
  const missed = remoteAudio === 0;
  const silentTracks = remoteAudio > 0 && hearing === false;
  return serverMix || missed || silentTracks;
}
