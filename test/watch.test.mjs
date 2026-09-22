import test from 'node:test';
import assert from 'node:assert/strict';
import { pathMatchesSelector } from '../src/lib/selector.js';
import { isTelemostUrl, meetingEnded, pageKey, samePage } from '../src/lib/watch.js';
import { adoptRootAi, migrateRootMonitor, settingsForPage } from '../src/lib/defaults.js';

test('цели мониторинга не смешиваются между страницами', () => {
  const shop = 'https://shop.example/list?q=1';
  const other = 'https://other.example/list';
  const settings = {
    monitors: {
      [pageKey(shop)]: { parentSelector: '.shop', features: [{ key: 'цена', selector: '.price' }] },
    },
    parentSelector: '.old',
    features: [{ key: 'чужое', selector: '.x' }],
  };
  assert.equal(settingsForPage(settings, shop).parentSelector, '.shop');
  assert.equal(settingsForPage(settings, other).parentSelector, '');
  assert.deepEqual(settingsForPage(settings, other).features, []);
});

test('пока страницы не разложены, читаются селекторы из корня', () => {
  const shop = 'https://shop.example/list?q=1';
  const settings = {
    monitors: {},
    parentSelector: '.old',
    features: [{ key: 'цена', selector: '.price' }],
  };
  assert.equal(settingsForPage(settings, shop).parentSelector, '.old');
  assert.equal(settingsForPage(settings, shop).features[0].key, 'цена');
});

test('корневые селекторы один раз переходят на одну страницу', () => {
  const shop = 'https://shop.example/list?q=1';
  const other = 'https://other.example/list';
  const migrated = migrateRootMonitor({
    monitors: {},
    parentSelector: '.old',
    itemSelector: '.row',
    features: [{ key: 'цена', selector: '.price' }],
  }, shop);
  assert.equal(migrated.parentSelector, '');
  assert.deepEqual(migrated.features, []);
  assert.equal(migrated.monitors[pageKey(shop)].parentSelector, '.old');
  assert.equal(settingsForPage(migrated, shop).features[0].selector, '.price');
  assert.equal(settingsForPage(migrated, other).parentSelector, '');
  assert.equal(migrateRootMonitor(migrated, other), migrated);
});

test('промпт и чекбокс не смешиваются между страницами', () => {
  const shop = 'https://shop.example/list?q=1';
  const other = 'https://other.example/list';
  const settings = {
    aiEnabled: true,
    aiPrompt: 'общий',
    monitors: {
      [pageKey(shop)]: { parentSelector: '.shop', aiEnabled: true, aiPrompt: 'только магазин' },
      [pageKey(other)]: { parentSelector: '.other', aiEnabled: false, aiPrompt: '' },
    },
  };
  assert.equal(settingsForPage(settings, shop).aiPrompt, 'только магазин');
  assert.equal(settingsForPage(settings, shop).aiEnabled, true);
  assert.equal(settingsForPage(settings, other).aiPrompt, '');
  assert.equal(settingsForPage(settings, other).aiEnabled, false);
});

test('старый промпт из корня копируется в уже сохранённые страницы', () => {
  const shop = 'https://shop.example/list?q=1';
  const other = 'https://other.example/list';
  const adopted = adoptRootAi({
    aiEnabled: true,
    aiPrompt: 'общий',
    monitors: {
      [pageKey(shop)]: { parentSelector: '.shop' },
    },
  });
  assert.equal(adopted.aiPrompt, '');
  assert.equal(adopted.aiEnabled, false);
  assert.equal(adopted.monitors[pageKey(shop)].aiPrompt, 'общий');
  assert.equal(settingsForPage(adopted, shop).aiEnabled, true);
  assert.equal(settingsForPage(adopted, other).aiPrompt, '');
});

test('селектор и путь от родителя совпадают хвостом в любую сторону', () => {
  const fromParent = 'section > div:nth-of-type(1) > div:nth-of-type(3) > span';
  const shortSaved = 'div:nth-of-type(3) > span';
  assert.equal(pathMatchesSelector(fromParent, shortSaved), true);
  assert.equal(pathMatchesSelector('section > div:nth-of-type(9) > span', shortSaved), false);
  assert.equal(pathMatchesSelector(fromParent, 'span'), false);
  const inside = 'section > div:nth-of-type(3) > span';
  const savedAbove = 'div:nth-of-type(1) > section > div:nth-of-type(3) > span';
  assert.equal(pathMatchesSelector(inside, savedAbove), true);
  assert.equal(pathMatchesSelector('section > div:nth-of-type(9) > span', savedAbove), false);
  assert.equal(pathMatchesSelector('span', savedAbove), true);
  assert.equal(pathMatchesSelector('div', 'section > div'), true);
  const directChild = 'div:nth-of-type(1) > section > div:nth-of-type(3)';
  assert.equal(pathMatchesSelector('div:nth-of-type(3)', directChild), true);
  assert.equal(pathMatchesSelector('div:nth-of-type(9)', directChild), false);
});

test('телемост определяется по домену адреса', () => {
  assert.equal(isTelemostUrl('https://telemost.yandex.ru/j/1'), true);
  assert.equal(isTelemostUrl('https://telemost.yandex.ru.evil.com/j/1'), false);
  assert.equal(isTelemostUrl('https://example.com/?u=telemost.yandex.ru'), false);
  assert.equal(isTelemostUrl(''), false);
});

test('служебный адрес не забирает селекторы и промпт', () => {
  assert.equal(pageKey('chrome://newtab/'), '');
  assert.equal(pageKey('about:blank'), '');
  const settings = {
    monitors: {},
    parentSelector: '.old',
    aiEnabled: true,
    aiPrompt: 'общий',
  };
  assert.equal(settingsForPage(settings, 'chrome://newtab/').parentSelector, '');
  assert.equal(settingsForPage(settings, 'chrome://newtab/').aiPrompt, '');
  assert.equal(settingsForPage(settings, 'chrome://newtab/').aiEnabled, false);
  assert.equal(migrateRootMonitor(settings, 'chrome://newtab/'), settings);
  assert.equal(settingsForPage(settings, 'https://shop.example/list').parentSelector, '.old');
});

test('тот же адрес страницы совпадает без хэша', () => {
  assert.equal(
    samePage('https://shop.example/list?q=1#top', 'https://shop.example/list?q=1'),
    true,
  );
  assert.equal(
    samePage('https://shop.example/list?q=1', 'https://shop.example/other?q=1'),
    false,
  );
});

test('запись кончается, когда сетка участников уже была и пропала', () => {
  assert.equal(meetingEnded({
    seenMeeting: true,
    gridRequired: true,
    gridFound: false,
    missingForMs: 2000,
  }), true);
  assert.equal(meetingEnded({
    seenMeeting: true,
    gridRequired: true,
    gridFound: true,
    missingForMs: 5000,
  }), false);
  assert.equal(meetingEnded({
    seenMeeting: false,
    gridRequired: true,
    gridFound: false,
    missingForMs: 5000,
  }), false);
});

test('без селектора сетки запись кончается, когда плитки уже были и пропали', () => {
  assert.equal(meetingEnded({
    seenMeeting: true,
    gridRequired: false,
    gridFound: true,
    seenTiles: true,
    tileCount: 0,
    missingForMs: 2000,
  }), true);
  assert.equal(meetingEnded({
    seenMeeting: true,
    gridRequired: false,
    gridFound: true,
    seenTiles: false,
    tileCount: 0,
    missingForMs: 5000,
  }), false);
  assert.equal(meetingEnded({
    seenMeeting: true,
    gridRequired: false,
    gridFound: true,
    seenTiles: true,
    tileCount: 1,
    missingForMs: 5000,
  }), false);
});
