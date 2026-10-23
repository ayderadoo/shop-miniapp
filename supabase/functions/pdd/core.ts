// Бот-импортёр Пиндодо: ссылка → goods_id → TMAPI → Gemini → карточка с ценой в сумах.
// Логика без зависимостей: работает и в Supabase Edge (Deno), и локально в Node (scripts/pdd_bot_local.ts).
import { DEMO_ITEM } from "./demo.ts";

export type Settings = {
  owners: number[];            // кому разрешён бот; пусто = первый /start становится владельцем
  rateCny: number | null;      // сум за 1 юань; null = курс ЦБ автоматически
  rateUsd: number | null;      // сум за 1 доллар; null = автоматически
  markupPct: number;           // наценка, %
  cargoUsdPerKg: number;       // карго Китай → Ташкент, $ за кг
  roundTo: number;             // округление цены вверх, сум
};
export const DEFAULT_SETTINGS: Settings = { owners: [], rateCny: null, rateUsd: null, markupPct: 30, cargoUsdPerKg: 7, roundTo: 1000 };

export type ItemRow = { goods_id: string; raw: any; ai: any | null; weight_kg: number | null; fetched_at: string };
export interface Store {
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  getItem(goodsId: string): Promise<ItemRow | null>;
  saveItem(row: ItemRow): Promise<void>;
}
export type Deps = {
  token: string;
  tmapiKey: string;
  geminiKey: string;
  geminiModels?: string[];
  store: Store;
  fetch?: typeof fetch;
  log?: (...a: unknown[]) => void;
};

export const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const ITEM_TTL_MS = 6 * 3600_000;
const RATE_TTL_MS = 6 * 3600_000;
const MAX_VARIANT_LINES = 40;

export class UserError extends Error {}

// ---------- ссылки ----------
const PDD_HOST = /(?:^|\.)(?:yangkeduo|pinduoduo|pdd)\.(?:com|cn)$|(?:^|\.)pinduoduo\.net$/i;

export function findRefs(text: string): { goodsId?: string; url?: string }[] {
  const out: { goodsId?: string; url?: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'，。）)】]+/gi)) {
    const url = m[0];
    let host = "";
    try { host = new URL(url).hostname; } catch { continue; }
    if (!PDD_HOST.test(host)) continue;
    const id = goodsIdFromUrl(url);
    const key = id || url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id ? { goodsId: id, url } : { url });
  }
  if (!out.length) {
    const bare = text.trim().match(/^\d{9,15}$/);
    if (bare) out.push({ goodsId: bare[0] });
  }
  return out;
}

export function goodsIdFromUrl(url: string): string | null {
  const m = url.match(/[?&#](?:goods_id|goodsId)=(\d{6,15})/);
  return m ? m[1] : null;
}

// Короткая ссылка ?ps=... отвечает 307 с полной ссылкой, где есть goods_id; вход в аккаунт не нужен.
export async function resolveGoodsId(url: string, f: typeof fetch = fetch): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const direct = goodsIdFromUrl(current);
    if (direct) return direct;
    const res = await f(current, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const location = res.headers.get("location");
    if (location) { await res.body?.cancel(); current = new URL(location, current).toString(); continue; }
    const body = await res.text();
    const m = body.match(/goods_id["'=:\s]+(\d{6,15})/);
    if (m) return m[1];
    break;
  }
  throw new UserError("Не смог достать номер товара из ссылки. Пришлите ссылку из «Поделиться → Скопировать ссылку» или сам номер товара (goods_id).");
}

// ---------- TMAPI ----------
export async function fetchItem(goodsId: string, apiKey: string, f: typeof fetch = fetch): Promise<any> {
  if (!apiKey) throw new UserError("Не задан ключ TMAPI.");
  let res: Response;
  try {
    res = await f(`http://api.tmapi.top/pdd/item_detail?item_id=${encodeURIComponent(goodsId)}`, {
      headers: { apikey: apiKey }, signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new UserError("TMAPI не ответил за 30 секунд. Попробуйте ещё раз.");
  }
  const json: any = await res.json().catch(() => null);
  if (!json) throw new UserError(`TMAPI вернул ошибку HTTP ${res.status}.`);
  if (json.code === 200 && json.data) return json.data;
  const msg = String(json.msg || json.message || "");
  if (json.code === 4393 || /quota/i.test(msg)) throw new UserError("TMAPI: закончилась квота на ключе (insufficient quota). Пополните баланс в console.tmapi.io или попросите у их поддержки тестовые запросы.");
  if (/key|auth/i.test(msg) || res.status === 401 || res.status === 403) throw new UserError(`TMAPI не принял ключ: ${msg || res.status}.`);
  throw new UserError(`TMAPI: ${msg || "ошибка"} (код ${json.code ?? res.status}). Возможно, товар снят с продажи.`);
}

// ---------- курсы ----------
let rateCache: { at: number; cny: number; usd: number; source: string } | null = null;

export async function autoRates(f: typeof fetch = fetch, now = Date.now()) {
  if (rateCache && now - rateCache.at < RATE_TTL_MS) return rateCache;
  const get = async (url: string) => {
    const r = await f(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  };
  try {
    const [cny, usd]: any[] = await Promise.all([
      get("https://cbu.uz/ru/arkhiv-kursov-valyut/json/CNY/"),
      get("https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/"),
    ]);
    const c = Number(cny?.[0]?.Rate), u = Number(usd?.[0]?.Rate);
    if (c > 0 && u > 0) return rateCache = { at: now, cny: c, usd: u, source: `ЦБ Узбекистана на ${cny[0].Date}` };
  } catch { /* резервный источник ниже */ }
  try {
    const j: any = await get("https://open.er-api.com/v6/latest/USD");
    const u = Number(j?.rates?.UZS), c = u / Number(j?.rates?.CNY);
    if (u > 0 && c > 0) return rateCache = { at: now, cny: c, usd: u, source: "open.er-api.com" };
  } catch { /* ниже ошибка */ }
  throw new UserError("Не удалось получить курс автоматически. Задайте вручную: /rate 1780 и /usd 12650");
}

export async function currentRates(s: Settings, f: typeof fetch = fetch) {
  if (s.rateCny && s.rateUsd) return { cny: s.rateCny, usd: s.rateUsd, source: "заданы вручную" };
  const a = await autoRates(f);
  return { cny: s.rateCny ?? a.cny, usd: s.rateUsd ?? a.usd, source: s.rateCny || s.rateUsd ? `частично вручную, остальное — ${a.source}` : a.source };
}

// ---------- цены ----------
export function priceUzs(yuan: number, weightKg: number, rates: { cny: number; usd: number }, s: Settings) {
  const cost = yuan * rates.cny + weightKg * s.cargoUsdPerKg * rates.usd;
  const step = s.roundTo > 0 ? s.roundTo : 1;
  return { cost: Math.round(cost), price: Math.ceil(cost * (1 + s.markupPct / 100) / step) * step };
}

export function fmtSum(n: number) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export type Sku = { values: string[]; yuan: number; stock: number; available: boolean; img?: string };
export function parseSkus(raw: any): { dims: string[]; skus: Sku[] } {
  const dims: string[] = [];
  const skus: Sku[] = [];
  for (const s of raw?.skus || []) {
    const parts = String(s.props_names || "").split(";").filter(Boolean).map((p: string) => {
      const i = p.indexOf(":");
      return i < 0 ? ["", p.trim()] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
    parts.forEach(([k], i) => { if (!dims[i]) dims[i] = k; });
    const yuan = Number(s.sale_price ?? s.group_price ?? s.origin_price);
    if (!(yuan > 0)) continue;
    const stock = Number(s.stock ?? 0);
    skus.push({ values: parts.map(p => p[1]), yuan, stock, available: stock > 0 && Number(s.status ?? 1) === 1, img: s.sku_img });
  }
  if (!skus.length) {
    const yuan = Number(raw?.price ?? raw?.price_info?.price);
    if (yuan > 0) skus.push({ values: [], yuan, stock: Number(raw?.quantity ?? 0), available: raw?.is_item_onsale !== false });
  }
  return { dims, skus };
}

// ---------- Gemini ----------
const AI_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING", description: "Короткое понятное название на русском, до 70 символов, без маркетинга" },
    description: { type: "STRING", description: "2–4 предложения: что это, для чего, главные особенности" },
    category: { type: "STRING", description: "Категория магазина на русском, 1–3 слова" },
    specs: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, value: { type: "STRING" } }, required: ["name", "value"] } },
    dims: { type: "ARRAY", description: "Перевод названий измерений вариантов", items: { type: "OBJECT", properties: { cn: { type: "STRING" }, ru: { type: "STRING" } }, required: ["cn", "ru"] } },
    values: { type: "ARRAY", description: "Перевод КАЖДОГО значения варианта", items: { type: "OBJECT", properties: { cn: { type: "STRING" }, ru: { type: "STRING" } }, required: ["cn", "ru"] } },
    weight_kg: { type: "NUMBER", description: "Оценка веса одной единицы в упаковке, кг" },
    notes: { type: "ARRAY", items: { type: "STRING" }, description: "Заметки байера: риски и важное для покупателя из Узбекистана" },
  },
  required: ["title", "description", "category", "specs", "dims", "values", "weight_kg", "notes"],
};

const AI_PROMPT = `Ты — помощник байера магазина в Узбекистане, который возит товары с Pinduoduo.
По данным товара (JSON) подготовь карточку на грамотном русском языке.
Правила:
- Убери китайский маркетинговый мусор: «взрыв», «фабрика напрямую», «новинка 2026», «хит», «оригинал», «субсидия», «бесплатная доставка», бренды-пустышки и т.п.
- Технические термины переводи точно (материал, мощность, размеры, ёмкость, напряжение).
- specs: 3–8 полезных характеристик. Не включай «место происхождения», «место отправки», «бренд», если бренд неизвестный.
- dims/values: переведи названия измерений вариантов и каждое значение кратко (цвет, размер, комплектация). Размеры одежды (S/M/L/XL) оставь как есть, добавь ростовку, если она указана.
- weight_kg: реалистичная оценка веса одной штуки с упаковкой.
- notes: 0–4 коротких предупреждения, только если реально важно: китайская вилка/220 В, продаётся упаковкой/набором (сколько штук), размеры маломерят (китайская сетка), предзаказ, нужен китайский аккаунт/приложение, хрупкое, жидкость/батарейки (ограничения карго), разные варианты сильно отличаются. Без общих фраз.
Не выдумывай характеристики, которых нет в данных.`;

export function aiInput(raw: any) {
  const { dims, skus } = parseSkus(raw);
  const values = [...new Set(skus.flatMap(s => s.values))].slice(0, 120);
  return {
    title: raw?.title,
    details: String(raw?.details || "").slice(0, 1500),
    props: (raw?.product_props || []).map((p: any) => `${p.key}: ${(p.values || []).join(", ")}`).slice(0, 30),
    variant_dims: dims,
    variant_values: values,
    price_yuan: raw?.price_info ? [raw.price_info.min_onsale_group_price, raw.price_info.max_onsale_group_price] : raw?.price,
    sales: raw?.side_sales_tip,
    presale: raw?.is_pre_sale ? raw?.pre_sale_stamp || true : false,
  };
}

export async function aiCard(raw: any, apiKey: string, models = GEMINI_MODELS, f: typeof fetch = fetch, log?: Deps["log"]) {
  if (!apiKey) return null;
  if (!models?.length) models = GEMINI_MODELS;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: AI_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(aiInput(raw)) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: AI_SCHEMA, temperature: 0.3 },
  });
  for (const model of models) {
    try {
      const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body,
        signal: AbortSignal.timeout(45000),
      });
      const json: any = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("");
      if (!res.ok || !text) { log?.("gemini", model, res.status, JSON.stringify(json?.error || json).slice(0, 300)); continue; }
      const card = JSON.parse(text);
      if (card?.title) return { ...card, model };
    } catch (e) { log?.("gemini", model, String(e)); }
  }
  return null;
}

// ---------- карточка ----------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function pddUrl(goodsId: string) {
  return `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}`;
}

export function weightOf(row: ItemRow) {
  const w = row.weight_kg ?? Number(row.ai?.weight_kg);
  return w > 0 ? { kg: Math.round(w * 100) / 100, manual: row.weight_kg != null } : { kg: 0.5, manual: false, guess: true };
}

export function renderCard(row: ItemRow, s: Settings, rates: { cny: number; usd: number; source: string }) {
  const raw = row.raw, ai = row.ai;
  const tr = new Map<string, string>((ai?.values || []).map((v: any) => [String(v.cn).trim(), String(v.ru).trim()]));
  const dimTr = new Map<string, string>((ai?.dims || []).map((v: any) => [String(v.cn).trim(), String(v.ru).trim()]));
  const w = weightOf(row);
  const { dims, skus } = parseSkus(raw);
  const priced = skus.map(k => ({ ...k, ...priceUzs(k.yuan, w.kg, rates, s), ru: k.values.map(v => tr.get(v) || v) }));
  const live = priced.filter(p => p.available);
  const pool = live.length ? live : priced;
  const lines: string[] = [];
  lines.push(`<b>${esc(ai?.title || raw?.title)}</b>`);
  if (ai?.category) lines.push(`<i>${esc(ai.category)}</i>`);
  if (ai?.description) lines.push("", esc(ai.description));
  if (pool.length) {
    const min = Math.min(...pool.map(p => p.price)), max = Math.max(...pool.map(p => p.price));
    lines.push("", `💰 <b>${min === max ? fmtSum(min) : `${fmtSum(min)} – ${fmtSum(max)}`} сум</b>`);
  }
  if (priced.length > 1 || (priced[0]?.values.length ?? 0) > 0) {
    lines.push("", `<b>Варианты</b> (${esc(dims.map(d => dimTr.get(d) || d).filter(Boolean).join(" / ") || "вариант")}):`);
    const groups = new Map<string, typeof priced>();
    const grouped = dims.length >= 2;
    for (const p of priced) {
      const key = grouped ? p.ru[0] : "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    let shown = 0;
    for (const [key, list] of groups) {
      if (shown >= MAX_VARIANT_LINES) break;
      if (grouped) lines.push(`▫️ <b>${esc(key)}</b>`);
      for (const p of list) {
        if (shown++ >= MAX_VARIANT_LINES) break;
        const name = (grouped ? p.ru.slice(1) : p.ru).join(", ") || "—";
        lines.push(`${grouped ? "   " : ""}• ${esc(name)} — <b>${fmtSum(p.price)}</b> <i>(¥${p.yuan})</i>${p.available ? "" : " ❌ нет"}`);
      }
    }
    if (priced.length > MAX_VARIANT_LINES) lines.push(`…и ещё ${priced.length - MAX_VARIANT_LINES}`);
  }
  if (ai?.specs?.length) {
    lines.push("", "<b>Характеристики</b>");
    for (const sp of ai.specs.slice(0, 8)) lines.push(`• ${esc(sp.name)}: ${esc(sp.value)}`);
  }
  const notes: string[] = [...(ai?.notes || [])];
  if (Number(raw?.fare) > 0) notes.push(`Доставка по Китаю платная: ¥${raw.fare}`);
  if (raw?.is_item_onsale === false) notes.push("Товар снят с продажи");
  if (skus.length && !live.length) notes.push("Все варианты закончились");
  if (notes.length) {
    lines.push("", "⚠️ <b>Заметка байера</b>");
    for (const n of notes.slice(0, 6)) lines.push(`• ${esc(n)}`);
  }
  if (!ai) lines.push("", "<i>Перевод ИИ не получен — показаны данные как есть. Нажмите «Пересчитать», чтобы попробовать снова.</i>");
  const sample = pool[0];
  lines.push("", "———");
  if (sample) {
    lines.push(`<code>¥${sample.yuan}×${fmtSum(rates.cny)} + ${w.kg} кг×$${s.cargoUsdPerKg}×${fmtSum(rates.usd)} = ${fmtSum(sample.cost)}; +${s.markupPct}%</code>`);
  }
  lines.push(`Вес ~${w.kg} кг (${w.manual ? "задан вами" : "guess" in w ? "по умолчанию" : "оценка ИИ"}) — ответьте на карточку «вес 1.2», чтобы поправить.`);
  lines.push(`Курс: ${esc(rates.source)}`);
  lines.push(`Пиндодо ID: <code>${esc(row.goods_id)}</code>`);
  let text = lines.join("\n");
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  return text;
}

export function cardButtons(row: ItemRow) {
  const id = row.goods_id;
  const first = [{ text: "🔁 Пересчитать", callback_data: `re:${id}` }, { text: "🇨🇳 Оригинал", callback_data: `cn:${id}` }];
  const second: any[] = [{ text: "🔗 Открыть в Пиндодо", url: pddUrl(id) }];
  if (row.raw?.video_url) second.unshift({ text: "🎬 Видео", callback_data: `vid:${id}` });
  return { inline_keyboard: [first, second] };
}

export function originalText(row: ItemRow) {
  const raw = row.raw;
  const lines = [`<b>${esc(raw?.title)}</b>`, ""];
  for (const p of (raw?.product_props || []).slice(0, 20)) lines.push(`• ${esc(p.key)}: ${esc((p.values || []).join(", "))}`);
  if (raw?.shop_info?.shop_name) lines.push("", `Магазин: ${esc(raw.shop_info.shop_name)}`);
  if (raw?.side_sales_tip) lines.push(`Продажи: ${esc(raw.side_sales_tip)}`);
  return lines.join("\n").slice(0, 4000);
}

// ---------- бот ----------
export function createBot(deps: Deps) {
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});

  async function tg(method: string, body: Record<string, unknown> | FormData) {
    const isForm = body instanceof FormData;
    const res = await f(`https://api.telegram.org/bot${deps.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) log("tg", method, json.description);
    return json;
  }
  const say = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
    tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

  async function sendPhotos(chat: number, raw: any) {
    const urls: string[] = [...new Set<string>((raw?.main_imgs || []).filter(Boolean))].slice(0, 8);
    if (!urls.length) return;
    const media = urls.map(u => ({ type: "photo", media: u }));
    const direct = urls.length === 1 ? await tg("sendPhoto", { chat_id: chat, photo: urls[0] }) : await tg("sendMediaGroup", { chat_id: chat, media });
    if (direct.ok) return;
    // Telegram не всегда скачивает картинки с CDN Пиндодо — загружаем сами
    const form = new FormData();
    form.set("chat_id", String(chat));
    const items: any[] = [];
    for (const [i, u] of urls.entries()) {
      try {
        const r = await f(u, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        form.set(`p${i}`, new Blob([await r.arrayBuffer()], { type: "image/jpeg" }), `p${i}.jpg`);
        items.push({ type: "photo", media: `attach://p${i}` });
      } catch { /* пропускаем фото */ }
    }
    if (!items.length) return;
    if (items.length === 1) {
      const one = new FormData();
      one.set("chat_id", String(chat));
      one.set("photo", form.get(items[0].media.slice(9)) as Blob, "p.jpg");
      await tg("sendPhoto", one);
    } else {
      form.set("media", JSON.stringify(items));
      await tg("sendMediaGroup", form);
    }
  }

  async function loadItem(goodsId: string, force = false): Promise<ItemRow> {
    const cached = await deps.store.getItem(goodsId);
    if (cached && !force && (Date.now() - Date.parse(cached.fetched_at) < ITEM_TTL_MS || goodsId === String(DEMO_ITEM.item_id))) {
      if (!cached.ai) {
        cached.ai = await aiCard(cached.raw, deps.geminiKey, deps.geminiModels, f, log);
        if (cached.ai) await deps.store.saveItem(cached);
      }
      return cached;
    }
    const raw = await fetchItem(goodsId, deps.tmapiKey, f);
    const ai = await aiCard(raw, deps.geminiKey, deps.geminiModels, f, log);
    const row: ItemRow = { goods_id: goodsId, raw, ai: ai ?? cached?.ai ?? null, weight_kg: cached?.weight_kg ?? null, fetched_at: new Date().toISOString() };
    await deps.store.saveItem(row);
    return row;
  }

  async function sendCard(chat: number, row: ItemRow, s: Settings, withPhotos = true) {
    const rates = await currentRates(s, f);
    if (withPhotos) await sendPhotos(chat, row.raw);
    await say(chat, renderCard(row, s, rates), { reply_markup: cardButtons(row) });
  }

  async function processLink(chat: number, ref: { goodsId?: string; url?: string }, s: Settings) {
    const wait = await say(chat, "⏳ Получаю товар…");
    try {
      const goodsId = ref.goodsId || await resolveGoodsId(ref.url!, f);
      const row = await loadItem(goodsId);
      await sendCard(chat, row, s);
    } catch (e) {
      log("process", String(e));
      await say(chat, e instanceof UserError ? `❗️ ${esc(e.message)}` : "❗️ Не получилось обработать ссылку. Попробуйте ещё раз через минуту.");
    } finally {
      if (wait?.result?.message_id) await tg("deleteMessage", { chat_id: chat, message_id: wait.result.message_id });
    }
  }

  const HELP = `Пришлите ссылку на товар из Пиндодо («Поделиться → Скопировать ссылку») — верну фото и готовую карточку с ценой в сумах.

<b>Настройки цены</b>
/rate 1780 — курс юаня (сум за ¥1), /rate auto — курс ЦБ
/usd 12650 — курс доллара, /usd auto — курс ЦБ
/markup 30 — наценка, %
/cargo 7 — карго, $ за кг
/round 1000 — округление цены вверх
/calc — текущие настройки
/demo — пример карточки (товар из документации TMAPI)

Вес товара ИИ оценивает сам; чтобы поправить — ответьте на карточку «вес 1.2».
/allow 123456 — дать доступ другому человеку (его ID пришлёт сам бот)`;

  async function settingsText(s: Settings) {
    let rates = "";
    try {
      const r = await currentRates(s, f);
      rates = `¥1 = ${fmtSum(r.cny)} сум, $1 = ${fmtSum(r.usd)} сум (${esc(r.source)})`;
    } catch (e) { rates = esc((e as Error).message); }
    return `<b>Расчёт цены</b>
Курс: ${rates}
Наценка: ${s.markupPct}%
Карго: $${s.cargoUsdPerKg} за кг
Округление: до ${fmtSum(s.roundTo)} сум

Формула: (цена ¥ × курс ¥ + вес × карго × курс $) × (1 + наценка)`;
  }

  function num(arg: string) {
    const n = Number(arg.replace(/\s/g, "").replace(",", ".").replace("%", ""));
    return Number.isFinite(n) ? n : NaN;
  }

  async function command(chat: number, uid: number, text: string, s: Settings) {
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.split("@")[0].toLowerCase();
    const arg = rest.join(" ");
    const save = async (msg: string) => { await deps.store.saveSettings(s); await say(chat, `✅ ${msg}\n\n${await settingsText(s)}`); };
    switch (cmd) {
      case "/start": case "/help": return say(chat, HELP);
      case "/calc": case "/settings": return say(chat, await settingsText(s));
      case "/id": return say(chat, `Ваш ID: <code>${uid}</code>`);
      case "/demo": {
        const id = String(DEMO_ITEM.item_id);
        let row = await deps.store.getItem(id);
        if (!row) {
          row = { goods_id: id, raw: DEMO_ITEM, ai: null, weight_kg: null, fetched_at: new Date().toISOString() };
        }
        if (!row.ai) {
          const wait = await say(chat, "⏳ Демо: перевожу пример товара через Gemini…");
          row.ai = await aiCard(row.raw, deps.geminiKey, deps.geminiModels, f, log);
          if (wait?.result?.message_id) await tg("deleteMessage", { chat_id: chat, message_id: wait.result.message_id });
        }
        await deps.store.saveItem(row);
        return sendCard(chat, row, s);
      }
      case "/rate": case "/usd": {
        const key = cmd === "/rate" ? "rateCny" : "rateUsd";
        if (/^auto|авто/i.test(arg)) { s[key] = null; return save("Курс берётся автоматически"); }
        const n = num(arg);
        if (!(n > 0)) return say(chat, `Пример: ${cmd} ${cmd === "/rate" ? "1780" : "12650"} или ${cmd} auto`);
        s[key] = n; return save(`Курс ${cmd === "/rate" ? "юаня" : "доллара"}: ${fmtSum(n)} сум`);
      }
      case "/markup": {
        const n = num(arg);
        if (!(n >= 0 && n <= 1000)) return say(chat, "Пример: /markup 30");
        s.markupPct = n; return save(`Наценка: ${n}%`);
      }
      case "/cargo": {
        const n = num(arg.replace("$", ""));
        if (!(n >= 0 && n <= 1000)) return say(chat, "Пример: /cargo 7 ($ за кг)");
        s.cargoUsdPerKg = n; return save(`Карго: $${n} за кг`);
      }
      case "/round": {
        const n = num(arg);
        if (!(n >= 1 && n <= 1_000_000)) return say(chat, "Пример: /round 1000");
        s.roundTo = Math.round(n); return save(`Округление до ${fmtSum(s.roundTo)} сум`);
      }
      case "/allow": {
        const id = Number(arg);
        if (!Number.isInteger(id) || id <= 0) return say(chat, "Пример: /allow 123456789 — ID человек узнает, написав боту.");
        if (!s.owners.includes(id)) s.owners.push(id);
        return save(`Доступ выдан: ${id}`);
      }
      default: return say(chat, HELP);
    }
  }

  async function weightReply(chat: number, msg: any, s: Settings) {
    const m = String(msg.text).match(/^\s*(?:вес\s*)?(\d+(?:[.,]\d+)?)\s*(кг|г)?\s*$/i);
    const idMatch = String(msg.reply_to_message?.text || "").match(/Пиндодо ID:\s*(\d{6,15})/);
    if (!m || !idMatch) return false;
    let kg = Number(m[1].replace(",", "."));
    if (m[2]?.toLowerCase() === "г") kg /= 1000;
    if (!(kg > 0 && kg < 500)) return false;
    const row = await deps.store.getItem(idMatch[1]);
    if (!row) return false;
    row.weight_kg = kg;
    await deps.store.saveItem(row);
    const rates = await currentRates(s, f);
    await tg("editMessageText", {
      chat_id: chat, message_id: msg.reply_to_message.message_id, text: renderCard(row, s, rates),
      parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: cardButtons(row),
    });
    await say(chat, `✅ Вес ${kg} кг — цены в карточке пересчитаны.`);
    return true;
  }

  async function callback(cb: any, s: Settings) {
    const [action, id] = String(cb.data || "").split(":");
    const chat = cb.message?.chat?.id;
    const row = id ? await deps.store.getItem(id) : null;
    if (!row || !chat) return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Товар не найден — пришлите ссылку заново." });
    if (action === "re") {
      if (!row.ai) {
        row.ai = await aiCard(row.raw, deps.geminiKey, deps.geminiModels, f, log);
        if (row.ai) await deps.store.saveItem(row);
      }
      const rates = await currentRates(s, f);
      await tg("editMessageText", {
        chat_id: chat, message_id: cb.message.message_id, text: renderCard(row, s, rates),
        parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: cardButtons(row),
      });
      return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Пересчитано по текущим настройкам" });
    }
    if (action === "cn") { await say(chat, originalText(row)); return tg("answerCallbackQuery", { callback_query_id: cb.id }); }
    if (action === "vid" && row.raw?.video_url) {
      const r = await tg("sendVideo", { chat_id: chat, video: row.raw.video_url });
      if (!r.ok) await say(chat, `Видео: ${esc(row.raw.video_url)}`);
      return tg("answerCallbackQuery", { callback_query_id: cb.id });
    }
    return tg("answerCallbackQuery", { callback_query_id: cb.id });
  }

  async function handleUpdate(update: any) {
    const msg = update.message, cb = update.callback_query;
    const from = msg?.from || cb?.from;
    if (!from || (msg && msg.chat?.type !== "private")) return;
    const s = { ...DEFAULT_SETTINGS, ...(await deps.store.getSettings()) };
    s.owners = [...(s.owners || [])];
    if (!s.owners.length && msg && /^\/start/.test(msg.text || "")) {
      s.owners.push(from.id);
      await deps.store.saveSettings(s);
      await say(msg.chat.id, "👋 Вы владелец этого бота — доступ закрыт для остальных.");
    }
    if (!s.owners.includes(from.id)) {
      if (cb) return tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Нет доступа" });
      return say(msg.chat.id, `Бот закрытый. Ваш ID: <code>${from.id}</code> — отправьте его владельцу.`);
    }
    try {
      if (cb) return await callback(cb, s);
      const text: string = msg.text || msg.caption || "";
      if (!text) return say(msg.chat.id, "Пришлите ссылку на товар из Пиндодо.");
      if (msg.reply_to_message && await weightReply(msg.chat.id, msg, s)) return;
      if (text.startsWith("/")) return await command(msg.chat.id, from.id, text, s);
      const refs = findRefs(text);
      if (!refs.length) return say(msg.chat.id, "Не вижу ссылки на Пиндодо. Пришлите ссылку из «Поделиться → Скопировать ссылку».\n\n/help — команды");
      for (const ref of refs.slice(0, 5)) await processLink(msg.chat.id, ref, s);
    } catch (e) {
      log("update", String(e));
      const chat = msg?.chat?.id ?? cb?.message?.chat?.id;
      if (chat) await say(chat, e instanceof UserError ? `❗️ ${esc(e.message)}` : "❗️ Внутренняя ошибка, попробуйте ещё раз.");
    }
  }

  return { handleUpdate, tg, loadItem, sendCard };
}

export async function webhookSecret(token: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pdd-webhook:${token}`));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
