import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings } from '../src/lib/defaults.js';
import {
  CHAT_MODEL,
  STT_MODEL,
  buildChatBody,
  extractChatText,
  isNoEndpointsError,
  relaxChatBody,
  whisperLanguage,
} from '../src/lib/openrouter.js';

test('чат и расшифровка используют модели simbyos', () => {
  assert.equal(CHAT_MODEL, 'google/gemma-4-31b-it');
  assert.equal(STT_MODEL, 'openai/whisper-large-v3');
  const settings = mergeSettings({});
  assert.equal(settings.chatModel, CHAT_MODEL);
  assert.equal(settings.sttModel, STT_MODEL);
});

test('оператор OpenRouter сортируется по throughput и требует параметры', () => {
  const body = buildChatBody({
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(body.model, CHAT_MODEL);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.deepEqual(body.provider, {
    sort: 'throughput',
    require_parameters: true,
  });
  assert.equal(body.max_tokens, undefined);
});

test('пустой язык Whisper означает русский', () => {
  assert.equal(whisperLanguage(undefined), 'ru');
  assert.equal(whisperLanguage(''), 'ru');
  assert.equal(whisperLanguage(' en '), 'en');
});

test('404 no endpoints сначала снимает require_parameters, затем оператора', () => {
  const body = buildChatBody({ messages: [] });
  const error = { error: { message: 'No endpoints found' } };
  assert.equal(isNoEndpointsError(404, error), true);
  assert.equal(isNoEndpointsError(400, error), false);
  const stage1 = relaxChatBody(body, 1);
  assert.equal(stage1.provider.require_parameters, false);
  assert.equal(stage1.provider.sort, 'throughput');
  const stage2 = relaxChatBody(stage1, 2);
  assert.equal(stage2.provider, undefined);
});

test('пустой content Gemma читается из reasoning', () => {
  const text = extractChatText({
    choices: [{ message: { content: '', reasoning: 'итог' } }],
  });
  assert.equal(text, 'итог');
});
