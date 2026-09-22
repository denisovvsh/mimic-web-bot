const GRID_GONE_MS = 2000;

export function pageKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return '';
  }
}

export function isTelemostUrl(url) {
  try {
    return new URL(url).hostname === 'telemost.yandex.ru';
  } catch {
    return false;
  }
}

export function samePage(left, right) {
  const a = pageKey(left);
  const b = pageKey(right);
  return Boolean(a) && a === b;
}

export function meetingEnded({
  seenMeeting,
  gridRequired,
  gridFound,
  seenTiles = false,
  tileCount = 0,
  missingForMs,
}) {
  if (!seenMeeting || missingForMs < GRID_GONE_MS) return false;
  if (gridRequired) return !gridFound;
  return seenTiles && tileCount === 0;
}
