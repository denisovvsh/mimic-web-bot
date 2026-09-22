const ERROR_NEARBY = /ошибк|error|unavailable|gateway|timeout|сервер/i;
const HTTP_STATUS = /HTTP(?:\/\d+(?:\.\d+)?)?\s*$/i;
const NEARBY_CHARS = 80;

export function findServerErrorText(body, pattern) {
  const text = String(body || '');
  const lines = String(pattern || '')
    .split(/\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^\d{3}$/.test(line)) {
      if (codeNearError(text, line)) return line;
    } else if (text.toLowerCase().includes(line.toLowerCase())) {
      return line;
    }
  }
  return '';
}

function codeNearError(text, code) {
  const re = new RegExp(`(^|\\s)${code}(\\s|$)`, 'g');
  let match = re.exec(text);
  while (match) {
    const start = Math.max(0, match.index - NEARBY_CHARS);
    const end = Math.min(text.length, match.index + match[0].length + NEARBY_CHARS);
    const before = text.slice(Math.max(0, match.index - 20), match.index);
    if (HTTP_STATUS.test(before)) return true;
    if (ERROR_NEARBY.test(text.slice(start, end))) return true;
    match = re.exec(text);
  }
  return false;
}
