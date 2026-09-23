import test from 'node:test';
import assert from 'node:assert/strict';
import { levelsReadable, shouldFallbackToMixed } from '../src/lib/fallback.js';

test('до 8 секунд смешанный захват не включается', () => {
  assert.equal(shouldFallbackToMixed({
    remoteAudio: 0,
    remoteTiles: 3,
    hearing: false,
    elapsedMs: 7999,
  }), false);
});

test('ноль удалённых треков после 8 секунд включает запасной режим', () => {
  assert.equal(shouldFallbackToMixed({
    remoteAudio: 0,
    remoteTiles: 0,
    hearing: true,
    elapsedMs: 8000,
  }), true);
});

test('треки есть, но уровень не читается — это не доказательство, что запись идёт', () => {
  assert.equal(shouldFallbackToMixed({
    remoteAudio: 2,
    remoteTiles: 2,
    hearing: false,
    elapsedMs: 8000,
  }), true);
  assert.equal(shouldFallbackToMixed({
    remoteAudio: 2,
    remoteTiles: 2,
    hearing: true,
    elapsedMs: 8000,
  }), false);
});

test('тишина на дорожке не значит, что уровень не читается', () => {
  assert.equal(levelsReadable({ contextRunning: false }), false);
  assert.equal(levelsReadable({ contextRunning: true }), true);
});

test('один удалённый трек и несколько плиток — смешанный звук сервера', () => {
  assert.equal(shouldFallbackToMixed({
    remoteAudio: 1,
    remoteTiles: 2,
    hearing: true,
    elapsedMs: 8000,
  }), true);
});
