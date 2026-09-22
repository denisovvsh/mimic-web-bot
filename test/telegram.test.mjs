import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPageLink, fitCaption, pageLinkLabel } from '../src/lib/telegram.js';

test('подпись ссылки — адрес вкладки без хэша', () => {
  assert.equal(
    pageLinkLabel('https://htx.com/buy-usdt-rub?fiat=rub#top'),
    'htx.com/buy-usdt-rub?fiat=rub',
  );
});

test('ссылка дописывается после текста и не подменяется разметкой модели', () => {
  const url = 'https://htx.com/buy-usdt-rub?fiat=rub#top';
  const [part] = appendPageLink('цена < 82\n</a><a href="https://evil.example">', url);
  assert.match(part, /цена &lt; 82/);
  assert.match(part, /&lt;a href="https:\/\/evil\.example"&gt;/);
  assert.equal(part.split('<a ').length, 2);
  assert.equal(part.endsWith(`<a href="${url}">htx.com/buy-usdt-rub?fiat=rub</a>`), true);
});

test('длинный адрес в подписи не режет тег ссылки', () => {
  const url = `https://shop.example/${'a'.repeat(800)}?q=1`;
  const caption = fitCaption('Ошибка сервера', url);
  assert.ok(caption.length <= 1024);
  assert.equal(caption.endsWith('</a>'), true);
  assert.equal((caption.match(/<a /g) || []).length, 1);
  assert.match(caption, /открыть вкладку/);
});

test('адрес длиннее лимита подписи не попадает обрывком тега', () => {
  const url = `https://shop.example/${'b'.repeat(1200)}`;
  const caption = fitCaption('Ошибка сервера', url);
  assert.ok(caption.length <= 1024);
  assert.equal(caption.includes('<a '), false);
  assert.match(caption, /Ошибка сервера/);
});

test('длинное сообщение не разрывает ссылку', () => {
  const url = 'https://shop.example/list';
  const parts = appendPageLink('x'.repeat(5000), url);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 4096));
  assert.equal(parts.filter((part) => part.includes('<a href=')).length, 1);
  assert.match(parts.at(-1), /<a href="https:\/\/shop\.example\/list">shop\.example\/list<\/a>$/);
});
