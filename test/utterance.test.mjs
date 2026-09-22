import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioFilename,
  createUtteranceController,
  joinSpeakerNames,
  sanitizeSpeakerName,
} from '../src/lib/utterance.js';

test('пауза короче 800 мс до 20 с не режет файл', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 0, 'Анна');
  ctl.noteSilence('a', 5_000);
  ctl.tick(5_700);
  const closed = ctl.drainActions().filter((action) => action.kind === 'close');
  assert.equal(closed.length, 0);
  assert.equal(ctl.getTrack('a').phase, 'pausing');
});

test('тишина 800 мс до 20 с закрывает реплику', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 0, 'Анна');
  ctl.noteSilence('a', 5_000);
  ctl.tick(5_800);
  const closed = ctl.drainActions().filter((action) => action.kind === 'close');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, 'end');
  assert.equal(closed[0].at - closed[0].startedAt, 5_800);
});

test('пауза 500 мс на 10-й секунде не закрывает', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 0, 'Анна');
  ctl.drainActions();
  ctl.noteSilence('a', 10_000);
  ctl.tick(10_500);
  assert.deepEqual(ctl.drainActions(), []);
  assert.equal(ctl.getTrack('a').phase, 'pausing');
});

test('пауза 500 мс на 20-й секунде закрывает только этот трек', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 0, 'Анна');
  ctl.noteSpeech('b', 0, 'Борис');
  ctl.noteSilence('a', 20_000);
  ctl.tick(20_500);
  const actions = ctl.drainActions();
  const closed = actions.filter((action) => action.kind === 'close');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].trackId, 'a');
  assert.equal(closed[0].reason, 'soft-pause');
  assert.equal(closed[0].at - closed[0].startedAt, 20_500);
  assert.ok(closed[0].at - closed[0].startedAt <= 30_000);
  assert.equal(ctl.getTrack('b').phase, 'recording');
  assert.equal(ctl.getTrack('a').phase, 'idle');
});

test('короткая пауза до порога не начинает новый файл', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 0, 'Анна');
  ctl.noteSilence('a', 5_000);
  ctl.noteSpeech('a', 5_400, 'Анна');
  const kinds = ctl.drainActions().map((action) => action.kind);
  assert.deepEqual(kinds, ['open']);
  assert.equal(ctl.getTrack('a').phase, 'recording');
  assert.equal(ctl.getTrack('a').startedAt, 0);
});

test('без паузы в окне 20–30 с файл обрывается ровно на 30 с', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 0, 'Анна');
  ctl.tick(29_999);
  assert.equal(ctl.drainActions().filter((action) => action.kind === 'close').length, 0);
  ctl.tick(30_000);
  const actions = ctl.drainActions();
  const closed = actions.find((action) => action.kind === 'close');
  const reopened = actions.find((action) => action.kind === 'open' && action.at === 30_000);
  assert.equal(closed.reason, 'hard-cap');
  assert.equal(closed.at - closed.startedAt, 30_000);
  assert.ok(reopened);
  assert.equal(ctl.getTrack('a').phase, 'recording');
  assert.equal(ctl.getTrack('a').startedAt, 30_000);
});

test('поздний tick не растягивает файл дольше 30 с', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 1_000, 'Анна');
  ctl.tick(50_000);
  const closed = ctl.drainActions().find((action) => action.kind === 'close');
  assert.equal(closed.at - closed.startedAt, 30_000);
});

test('endTrack закрывает только указанный трек', () => {
  const ctl = createUtteranceController();
  ctl.noteSpeech('a', 0, 'Анна');
  ctl.noteSpeech('b', 0, 'Борис');
  ctl.endTrack('a', 1500);
  const closed = ctl.drainActions().filter((action) => action.kind === 'close');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].trackId, 'a');
  assert.equal(closed[0].reason, 'end');
  assert.equal(ctl.getTrack('b').phase, 'recording');
});

test('stop без сессии игнорируется', () => {
  const ctl = createUtteranceController();
  ctl.noteSilence('missing', 1_000);
  ctl.tick(2_000);
  assert.deepEqual(ctl.drainActions(), []);
});

test('имя файла и смешанные спикеры', () => {
  assert.equal(sanitizeSpeakerName('Анна/Борис'), 'Анна_Борис');
  assert.equal(sanitizeSpeakerName('../secret'), 'secret');
  assert.equal(sanitizeSpeakerName('   '), 'unknown');
  assert.equal(joinSpeakerNames(['Анна', 'Борис', 'Анна']), 'Анна+Борис');
  assert.equal(joinSpeakerNames(['', '  ']), 'unknown');
  assert.equal(
    audioFilename({ startedAt: 5, speaker: 'Анна', trackId: 't1' }),
    'telemost/5__Анна__t1.webm',
  );
});
