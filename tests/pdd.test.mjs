import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findRefs, resolveGoodsId, fetchItem, priceUzs, parseSkus, renderCard, createBot, shotToItem, bytesToBase64, DEFAULT_SETTINGS, UserError } from '../supabase/functions/pdd/core.ts';

const item = JSON.parse(readFileSync(new URL('./fixtures/tmapi_pdd_item.json', import.meta.url))).data;
const rates = { cny: 1780, usd: 12000, source: 'тест' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('share text: finds Pinduoduo links, goods_id and bare ids; ignores other sites', () => {
 const refs = findRefs('Смотри https://mobile.yangkeduo.com/goods2.html?ps=2k7DidU5zU и https://example.com/x?goods_id=1 и https://mobile.yangkeduo.com/goods.html?goods_id=1011098534168&x=1');
 assert.deepEqual(refs, [{ url: 'https://mobile.yangkeduo.com/goods2.html?ps=2k7DidU5zU' }, { goodsId: '1011098534168', url: 'https://mobile.yangkeduo.com/goods.html?goods_id=1011098534168&x=1' }]);
 assert.deepEqual(findRefs(' 971047862955 '), [{ goodsId: '971047862955' }]);
 assert.deepEqual(findRefs('привет'), []);
});

test('short ps link is unpacked from the 307 redirect', async () => {
 const f = async (url, init) => {
  assert.equal(init.redirect, 'manual');
  return new Response('', { status: 307, headers: { location: 'https://mobile.yangkeduo.com/goods2.html?refer_share_id=x&goods_id=1011098534168&_oak=1' } });
 };
 assert.equal(await resolveGoodsId('https://mobile.yangkeduo.com/goods2.html?ps=2k7DidU5zU', f), '1011098534168');
 await assert.rejects(resolveGoodsId('https://mobile.yangkeduo.com/goods.html?ps=x', async () => new Response('login')), UserError);
});

test('TMAPI quota error is explained to the owner', async () => {
 await assert.rejects(fetchItem('1', 'k', async () => json({ code: 4393, message: 'insufficient quota' })), /квота/);
 assert.equal((await fetchItem('1', 'k', async (url, init) => { assert.equal(init.headers.apikey, 'k'); assert.match(url, /item_id=1$/); return json({ code: 200, data: item }); })).title, item.title);
});

test('price formula: yuan, cargo by weight, markup, rounding up', () => {
 const s = { ...DEFAULT_SETTINGS, markupPct: 30, cargoUsdPerKg: 7, roundTo: 1000 };
 const r = priceUzs(100, 1, rates, s); // 178000 × 1.3 = 231400, + карго 84000 = 315400 → вверх до 316000
 assert.deepEqual(r, { cost: 262000, cargo: 84000, price: 316000 });
 const { dims, skus } = parseSkus(item);
 assert.deepEqual(dims, ['型号', '套餐']);
 assert.equal(skus.length, 6);
 assert.equal(skus[0].yuan, 211.5);
});

test('card shows translated grouped variants and prices; works without AI', () => {
 const ai = { title: 'Рубанок', category: 'Инструменты', description: 'Описание', specs: [{ name: 'Материал', value: 'алюминий' }], dims: [{ cn: '型号', ru: 'Модель' }, { cn: '套餐', ru: 'Комплект' }], values: [{ cn: '礼包 一', ru: 'Набор 1' }], weight_kg: 2, notes: ['Китайская вилка'] };
 const text = renderCard({ goods_id: '99215544343', raw: item, ai, weight_kg: null, fetched_at: '' }, DEFAULT_SETTINGS, rates);
 assert.match(text, /<b>Рубанок<\/b>/);
 assert.match(text, /Модель \/ Комплект/);
 assert.match(text, /• Набор 1 — <b>[\d ]+<\/b> <i>\(¥211\.5\)<\/i>/);
 assert.match(text, /Китайская вилка/);
 assert.match(text, /Пиндодо ID: <code>99215544343<\/code>/);
 assert.ok(text.length < 4096);
 const plain = renderCard({ goods_id: '1', raw: item, ai: null, weight_kg: null, fetched_at: '' }, DEFAULT_SETTINGS, rates);
 assert.match(plain, /Перевод ИИ не получен/);
 assert.match(plain, /日本质造电刨/);
});

const SHOT_CARD = { title_cn: '男士运动鞋', title: 'Кроссовки мужские', description: 'd', category: 'Обувь', specs: [{ name: 'Подошва', value: 'ЭВА' }], variant_dim: 'Цвет',
 variants: [{ name: 'Чёрный', yuan: 39.9, available: true }, { name: 'Серо-голубой', yuan: 45.9, available: true }, { name: 'Хаки', yuan: 0, available: false }],
 options: [{ name: 'Размер', values: ['39', '40', '41'] }], china_shipping_yuan: 0, material: 'Сетка, ЭВА', dimensions: '', capacity: '', package: '1 пара',
 photo: { shot: 1, box_2d: [100, 100, 600, 900] }, weight_kg: 0.8, notes: ['Маломерят'], missing: '' };

function harness() {
 const sent = [], items = {}; let settings = {}, shots = [];
 const store = {
  getSettings: async () => ({ ...DEFAULT_SETTINGS, ...settings }), saveSettings: async s => { settings = structuredClone(s); },
  getItem: async id => items[id] ? structuredClone(items[id]) : null, saveItem: async r => { items[r.goods_id] = structuredClone(r); },
  addShot: async sh => { shots.push(sh); },
  takeShots: async (chat, mid) => { const mine = shots.filter(x => x.chat_id === chat); if (!mine.length || mine.at(-1).message_id !== mid) return null; shots = shots.filter(x => x.chat_id !== chat); return mine; },
 };
 const visionBodies = [], photos = []; let imageCalls = 0;
 let tmapiCalls = 0;
 const f = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://api.telegram.org/file/')) return new Response(new Uint8Array([1, 2, 3]));
  if (url.startsWith('https://api.telegram.org/')) {
   const method = url.split('/').pop();
   const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
   sent.push({ method, ...body });
   if (method === 'sendPhoto') return json({ ok: true, result: { message_id: sent.length, photo: [{ file_id: 'small' }, { file_id: 'ramp-photo' }] } });
   if (method === 'getFile') return json({ ok: true, result: { file_path: `photos/${body.file_id}.jpg` } });
   return json({ ok: true, result: { message_id: sent.length } });
  }
  if (url.includes('yangkeduo.com')) return new Response('', { status: 307, headers: { location: 'https://mobile.yangkeduo.com/goods2.html?goods_id=99215544343' } });
  if (url.includes('api.tmapi.top')) { tmapiCalls++; return json({ code: 200, data: item }); }
  if (url.includes('generativelanguage') && init.body.includes('responseModalities')) { imageCalls++; return json({ error: { message: 'Quota exceeded, limit: 0' } }, 429); }
  if (url.includes('generativelanguage') && init.body.includes('inline_data')) { visionBodies.push(JSON.parse(init.body)); return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(SHOT_CARD) }] } }] }); }
  if (url.includes('generativelanguage')) return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Рубанок', description: 'd', category: 'c', specs: [], dims: [], values: [], weight_kg: 2, notes: [] }) }] } }] });
  if (url.includes('cbu.uz')) return json([{ Rate: url.includes('CNY') ? '1780.00' : '12000.00', Date: '23.10.2026' }]);
  throw new Error('unexpected ' + url);
 };
 const makePhoto = async (bytes, box) => { photos.push({ bytes, box }); return new Uint8Array([9, 9]); };
 const bot = createBot({ token: 'T', tmapiKey: 'k', geminiKey: 'g', store, fetch: f, shotWaitMs: 20, makePhoto });
 const msg = (id, text, extra = {}) => bot.handleUpdate({ message: { message_id: 1, from: { id }, chat: { id, type: 'private' }, text, ...extra } });
 return { bot, sent, items, msg, visionBodies, photos, get imageCalls() { return imageCalls; }, get settings() { return settings; }, get tmapiCalls() { return tmapiCalls; } };
}

test('bot: first /start claims ownership, strangers are refused', async () => {
 const h = harness();
 await h.msg(5, '/start');
 assert.deepEqual(h.settings.owners, [5]);
 await h.msg(6, 'https://mobile.yangkeduo.com/goods2.html?ps=a');
 assert.match(h.sent.at(-1).text, /Бот закрытый. Ваш ID: <code>6<\/code>/);
 assert.equal(h.tmapiCalls, 0);
 await h.msg(5, '/allow 6');
 assert.deepEqual(h.settings.owners, [5, 6]);
});

test('bot: link → photos + card; settings commands; weight reply edits the card; cache avoids paid calls', async () => {
 const h = harness();
 await h.msg(5, '/start');
 await h.msg(5, '/markup 50');
 assert.equal(h.settings.markupPct, 50);
 await h.msg(5, 'Скопировал: https://mobile.yangkeduo.com/goods2.html?ps=2k7DidU5zU');
 assert.ok(h.sent.some(m => m.method === 'sendMediaGroup' && m.media.length === 8));
 const card = h.sent.findLast(m => m.method === 'sendMessage');
 assert.match(card.text, /<b>Рубанок<\/b>/);
 assert.match(card.text, /×1\.5 \+ /);
 assert.equal(card.reply_markup.inline_keyboard[0][0].callback_data, 're:99215544343');
 assert.ok(h.sent.some(m => m.method === 'deleteMessage'));
 await h.msg(5, 'вес 1,5', { reply_to_message: { message_id: 42, text: card.text.replace(/<[^>]+>/g, '') } });
 assert.equal(h.items['99215544343'].weight_kg, 1.5);
 const edit = h.sent.findLast(m => m.method === 'editMessageText');
 assert.equal(edit.message_id, 42);
 assert.match(edit.text, /1\.5 кг \(задан вами\)/);
 await h.bot.handleUpdate({ callback_query: { id: 'c', from: { id: 5 }, data: 're:99215544343', message: { message_id: 42, chat: { id: 5 } } } });
 await h.msg(5, 'https://mobile.yangkeduo.com/goods.html?goods_id=99215544343');
 assert.equal(h.tmapiCalls, 1);
});

test('screenshots: variants keep prices, sold-out goes to notes, sizes to specs', () => {
 const { raw, ai } = shotToItem(SHOT_CARD);
 assert.equal(raw.source, 'screenshot');
 assert.deepEqual(parseSkus(raw).skus.map(k => k.yuan), [39.9, 45.9]);
 assert.ok(ai.notes.includes('Нет в наличии: Хаки'));
 assert.deepEqual(ai.specs.at(-1), { name: 'Размер', value: '39, 40, 41' });
 assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=');
});

test('bot: album of screenshots → one recognition call → one priced card', async () => {
 const h = harness();
 await h.msg(5, '/start');
 const photo = (mid, id, extra = {}) => h.bot.handleUpdate({ message: { message_id: mid, from: { id: 5 }, chat: { id: 5, type: 'private' }, media_group_id: 'g', photo: [{ file_id: id + 's' }, { file_id: id }], ...extra } });
 await Promise.all([photo(10, 'a', { caption: 'https://mobile.yangkeduo.com/goods.html?goods_id=1011098534168' }), photo(11, 'b')]);
 assert.equal(h.visionBodies.length, 1);
 assert.equal(h.visionBodies[0].contents[0].parts.filter(p => p.inline_data).length, 2);
 assert.ok(h.sent.some(m => m.method === 'getFile' && m.file_id === 'a'), 'largest photo size is used');
 const card = h.sent.findLast(m => m.method === 'sendMessage');
 assert.match(card.text, /<b>Кроссовки мужские<\/b>/);
 assert.match(card.text, /• Чёрный — <b>[\d ]+<\/b> <i>\(¥39\.9\)<\/i>/);
 assert.match(card.text, /Нет в наличии: Хаки/);
 assert.match(card.text, /со скриншотов/);
 const id = card.text.match(/ID карточки: <code>(\d+)<\/code>/)[1];
 assert.equal(card.reply_markup.inline_keyboard[1][0].url, 'https://mobile.yangkeduo.com/goods.html?goods_id=1011098534168');
 await h.msg(5, 'вес 2', { reply_to_message: { message_id: 50, text: card.text.replace(/<[^>]+>/g, '') } });
 assert.equal(h.items[id].weight_kg, 2);
 assert.ok(!h.sent.some(m => m.method === 'sendMediaGroup'));
 assert.equal(h.imageCalls, 1, 'paid drawing tried once, then crop');
 assert.deepEqual(h.photos.map(p => p.box), [[100, 100, 600, 900]]);
 assert.ok(h.sent.findIndex(m => m.method === 'sendPhoto') < h.sent.indexOf(card), 'branded photo goes before the card');
 assert.equal(h.items[id].raw.photo_file_id, 'ramp-photo');
 assert.match(card.text, /• Материал: Сетка, ЭВА/);
 assert.match(card.text, /• Комплектация: 1 пара/);
 assert.doesNotMatch(card.text, /Размеры: \n/);
 assert.match(card.text, /Карго в цене: [\d ]+ сум/);
});
