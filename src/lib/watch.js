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

export function labelTracks(tracks, hints) {
  const list = Array.isArray(tracks) ? tracks : [];
  const hot = list.filter((track) => track.hot);
  if (hot.length !== 1) return [];
  const target = hot[0];
  const usedElsewhere = new Set(
    list.filter((track) => track.id !== target.id && track.speaker).map((track) => track.speaker),
  );
  const free = (Array.isArray(hints) ? hints : []).filter((hint) => hint?.name && !usedElsewhere.has(hint.name));
  if (!free.length) return [];
  let name = '';
  if (free.length === 1) name = free[0].name;
  else {
    const matched = free.filter((hint) => Boolean(hint.local) === Boolean(target.local));
    if (matched.length === 1) name = matched[0].name;
  }
  if (!name || name === target.speaker) return [];
  return [{ id: target.id, name }];
}

export function speakingByFrame(tiles, rest = {}) {
  const nextRest = { ...rest };
  const named = (Array.isArray(tiles) ? tiles : []).filter((tile) => tile && tile.name && tile.style);
  if (!named.length) return { speakers: [], rest: nextRest };
  if (named.length === 1) {
    const tile = named[0];
    const known = nextRest[tile.name];
    if (!known) {
      nextRest[tile.name] = tile.style;
      return { speakers: [], rest: nextRest };
    }
    if (tile.style === known) return { speakers: [], rest: nextRest };
    return { speakers: [{ name: tile.name, local: Boolean(tile.local) }], rest: nextRest };
  }
  const counts = new Map();
  for (const tile of named) counts.set(tile.style, (counts.get(tile.style) || 0) + 1);
  let common = '';
  let commonCount = 0;
  for (const [style, count] of counts) {
    if (count > commonCount) {
      common = style;
      commonCount = count;
    }
  }
  if (counts.size === 1) {
    for (const tile of named) nextRest[tile.name] = tile.style;
    return { speakers: [], rest: nextRest };
  }
  const speakers = [];
  for (const tile of named) {
    if (tile.style === common && commonCount > 1) nextRest[tile.name] = tile.style;
    const known = Object.prototype.hasOwnProperty.call(rest, tile.name) ? rest[tile.name] : '';
    if (known && tile.style !== known) speakers.push({ name: tile.name, local: Boolean(tile.local) });
    else if (!known && commonCount > 1 && tile.style !== common) {
      speakers.push({ name: tile.name, local: Boolean(tile.local) });
    }
  }
  return { speakers, rest: nextRest };
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
