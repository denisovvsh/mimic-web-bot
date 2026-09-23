import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptAudioSession,
  parentDirectory,
  recordingButtons,
  sessionPathsText,
  shouldPublishPaths,
  toBytes,
} from '../src/lib/audio-chunk.js';

test('пока идёт запись, запуск выключен, остановка включена', () => {
  assert.deepEqual(recordingButtons({ allowed: true, recordingOn: true }), {
    startDisabled: true,
    stopDisabled: false,
  });
  assert.deepEqual(recordingButtons({ allowed: true, recordingOn: false }), {
    startDisabled: false,
    stopDisabled: true,
  });
  assert.equal(recordingButtons({ allowed: false, recordingOn: false }).startDisabled, true);
});

test('после записи видны каталог аудио и файл транскрипта', () => {
  assert.equal(parentDirectory('/home/vadim/Downloads/telemost/1__Анна__a.webm'), '/home/vadim/Downloads/telemost');
  assert.equal(parentDirectory('C:\\Users\\vadim\\Downloads\\telemost\\1.webm'), 'C:\\Users\\vadim\\Downloads\\telemost');
  assert.equal(sessionPathsText({
    directory: '/home/vadim/Downloads/telemost',
    transcript: '/home/vadim/Downloads/telemost/session-1_transcript.txt',
    notes: ['Telegram не настроен — фрагмент не отправлен'],
  }), [
    'Аудио: /home/vadim/Downloads/telemost',
    'Транскрипт: /home/vadim/Downloads/telemost/session-1_transcript.txt',
    'Telegram не настроен — фрагмент не отправлен',
  ].join('\n'));
});

test('поздний путь старой сессии не затирает новую', () => {
  assert.equal(shouldPublishPaths({
    sessionId: 10,
    pathsSession: 20,
    recordingSessionId: null,
  }), false);
  assert.equal(shouldPublishPaths({
    sessionId: 20,
    pathsSession: 20,
    recordingSessionId: null,
  }), true);
  assert.equal(shouldPublishPaths({
    sessionId: 20,
    pathsSession: 20,
    recordingSessionId: 20,
  }), false);
});

test('фрагмент принимается, пока сессия записи жива', () => {
  const session = acceptAudioSession(
    { sessionId: 10 },
    { tab: { id: 3 } },
    [{ sessionId: 10, tabId: 3 }],
  );
  assert.equal(session.sessionId, 10);
});

test('после остановки фрагмент этой сессии всё ещё принимается', () => {
  const session = acceptAudioSession(
    { sessionId: 10 },
    { tab: { id: 3 } },
    [{ sessionId: 10, tabId: 3, until: 1 }],
  );
  assert.equal(session.sessionId, 10);
});

test('чужая сессия и чужая вкладка не записываются', () => {
  assert.equal(acceptAudioSession(
    { sessionId: 11 },
    { tab: { id: 3 } },
    [{ sessionId: 10, tabId: 3 }],
  ), null);
  assert.equal(acceptAudioSession(
    { sessionId: 10 },
    { tab: { id: 4 } },
    [{ sessionId: 10, tabId: 3 }],
  ), null);
});

test('offscreen без вкладки пишет в текущую сессию', () => {
  const session = acceptAudioSession(
    { sessionId: 10 },
    {},
    [{ sessionId: 10, tabId: 3 }],
  );
  assert.equal(session.tabId, 3);
});

test('новая сессия не забирает хвост предыдущей', () => {
  const session = acceptAudioSession(
    { sessionId: 10 },
    { tab: { id: 3 } },
    [
      { sessionId: 20, tabId: 3 },
      { sessionId: 10, tabId: 3 },
    ],
  );
  assert.equal(session.sessionId, 10);
});

test('байты из объекта без length не превращаются в пустой файл', () => {
  const bytes = toBytes({ 0: 26, 1: 69, 2: 223 });
  assert.deepEqual([...bytes], [26, 69, 223]);
});

test('Uint8Array копируется как есть', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const bytes = toBytes(source);
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  assert.notEqual(bytes, source);
});
