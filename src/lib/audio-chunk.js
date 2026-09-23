export function recordingButtons({ allowed, recordingOn }) {
  return {
    startDisabled: !allowed || Boolean(recordingOn),
    stopDisabled: !recordingOn,
  };
}

export function parentDirectory(filename) {
  const value = String(filename || '').trim();
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (index <= 0) return '';
  return value.slice(0, index);
}

export function shouldPublishPaths({ sessionId, pathsSession, recordingSessionId }) {
  if (!sessionId) return false;
  if (recordingSessionId && recordingSessionId === sessionId) return false;
  if (pathsSession && sessionId < pathsSession) return false;
  return true;
}

export function sessionPathsText({ directory, transcript, notes } = {}) {
  const lines = [];
  if (directory) lines.push(`Аудио: ${directory}`);
  if (transcript) lines.push(`Транскрипт: ${transcript}`);
  for (const note of notes || []) {
    if (note) lines.push(note);
  }
  return lines.join('\n');
}

export function acceptAudioSession(message, sender, sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  for (const session of list) {
    if (!session?.sessionId) continue;
    if (message?.sessionId && message.sessionId !== session.sessionId) continue;
    if (sender?.tab?.id && session.tabId && sender.tab.id !== session.tabId) continue;
    return session;
  }
  return null;
}

export function toBytes(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (buffer?.type === 'Buffer' && Array.isArray(buffer.data)) return Uint8Array.from(buffer.data);
  if (Array.isArray(buffer)) return Uint8Array.from(buffer);
  if (buffer && typeof buffer === 'object') {
    const indexes = [];
    for (const key of Object.keys(buffer)) {
      if (/^\d+$/.test(key)) indexes.push(Number(key));
    }
    if (indexes.length) {
      let length = Number.isInteger(buffer.length) ? buffer.length : 0;
      if (!length) {
        for (const index of indexes) if (index + 1 > length) length = index + 1;
      }
      const bytes = new Uint8Array(length);
      for (const index of indexes) {
        if (index >= 0 && index < length) bytes[index] = buffer[index] & 255;
      }
      return bytes;
    }
  }
  return new Uint8Array();
}
