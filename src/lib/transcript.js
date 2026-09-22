export function formatClock(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatLine({ start, end, speaker, text }) {
  return `[${formatClock(start)}–${formatClock(end)}] ${speaker}: ${text}`;
}

export function shouldKeepTranscript(text) {
  return Boolean(String(text ?? '').trim());
}

export function renderTranscript(lines) {
  const sorted = [...(lines || [])].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return String(a.speaker).localeCompare(String(b.speaker));
  });
  if (!sorted.length) return '';
  return `${sorted.map(formatLine).join('\n')}\n`;
}

export function transcriptFilename(sessionId) {
  return `telemost/session-${sessionId}_transcript.txt`;
}
