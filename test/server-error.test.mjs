import test from 'node:test';
import assert from 'node:assert/strict';
import { findServerErrorText } from '../src/lib/server-error.js';

const pattern = '500\n502\n503\nService Unavailable';

test('цена 500 не считается ошибкой сервера', () => {
  assert.equal(findServerErrorText('Цена 500 ₽', pattern), '');
  assert.equal(findServerErrorText('от 500 руб', pattern), '');
  assert.equal(
    findServerErrorText('Цена 500 ₽\nПодробнее: https://shop.example/item', pattern),
    '',
  );
});

test('код ответа рядом со словом об ошибке останавливает автоматизацию', () => {
  assert.equal(findServerErrorText('Ошибка 500', pattern), '500');
  assert.equal(findServerErrorText('502 Bad Gateway', pattern), '502');
  assert.equal(findServerErrorText('HTTP 500', pattern), '500');
  assert.equal(findServerErrorText('HTTP/1.1 503', pattern), '503');
  assert.equal(findServerErrorText('Сервис недоступен: Service Unavailable', pattern), 'Service Unavailable');
});
