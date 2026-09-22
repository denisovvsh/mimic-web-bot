import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTranscript,
  shouldKeepTranscript,
  transcriptFilename,
} from '../src/lib/transcript.js';

test('транскрипт сортируется по старту, а не по порядку ответов', () => {
  const text = renderTranscript([
    { start: 3_000, end: 4_000, speaker: 'Борис', text: 'позже' },
    { start: 1_000, end: 2_000, speaker: 'Анна', text: 'раньше' },
  ]);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}\] Анна: раньше$/);
  assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}–\d{2}:\d{2}:\d{2}\] Борис: позже$/);
});

test('пустая расшифровка не пишется, ошибка STT остаётся', () => {
  assert.equal(shouldKeepTranscript('  \n'), false);
  assert.equal(shouldKeepTranscript(''), false);
  assert.equal(shouldKeepTranscript('(фрагмент не расшифрован)'), true);
});

test('имя текстового файла сессии одно', () => {
  assert.equal(transcriptFilename(1700000000000), 'telemost/session-1700000000000_transcript.txt');
});
