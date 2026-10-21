export { isUzbekPhone } from "./validation.ts";
import { parseInitData } from "./validation.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

export const MINIAPP_URL = Deno.env.get("MINIAPP_URL") || "https://shop-miniapp-two.vercel.app";
export const SHOP_USERNAME = "ramp_uzbot";
export const ADMIN_URL = `${MINIAPP_URL}/admin.html`;
export const SUPPORT_USERNAME = "ramphelper";

export const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export const STATUS: Record<string, string> = {
  new: "Новый — ждёт оплаты",
  review: "Чек на проверке",
  paid: "Оплачен",
  bought: "Собирается",
  shipping: "В пути",
  arrived: "Прибыл в Ташкент",
  delivered: "Доставлен",
  cancelled: "Отменён",
};
export const PAID_OR_LATER = ["paid", "bought", "shipping", "arrived", "delivered"];

// Значения по умолчанию; рабочие значения хранятся в таблице settings и меняются из админ-панели
export const DEFAULT_PROMO = {
  welcomePct: 10,              // скидка новому пользователю на все заказы...
  welcomeDays: 30,             // ...в течение стольких дней с первого входа
  inviterPct: 33,              // купон пригласившему на один заказ
  inviteeNextPct: 11,          // купон приглашённому на следующий заказ
  minQualifyingOrder: 200_000, // заказ друга (сумма товаров) от этой суммы засчитывается
};
export type Promo = typeof DEFAULT_PROMO;
export const DEFAULT_PAYMENTS: Record<string, string> = {
  card: "Перевод на карту (Humo / Uzcard)",
  click: "Click",
  payme: "Payme",
  uzum: "Uzum Bank",
};

export const DEFAULT_CARDS = ["8600 0000 0000 0001"];

// Два бота: «shop» — клиентский (магазин, приветствие, уведомления клиентам),
// «admin» — служебный (новые заказы, чеки, заявки, админ-панель).
// Токены двух ботов независимы: отсутствие клиентского токена не переключает регистрацию в админского бота.
export type BotKind = "shop" | "admin";

type Config = {
  botToken: string; shopToken: string; admins: number[]; promo: Promo; payments: Record<string, string>; cards: string[];
};
let cache: { at: number; cfg: Config } | null = null;

// Настройки из базы (токен бота, админы, скидки, оплата). Кэш на 20 секунд.
export async function cfg(): Promise<Config> {
  if (cache && Date.now() - cache.at < 20_000) return cache.cfg;
  const [settingsResult, adminsResult] = await Promise.all([
    sb.from("settings").select("key,value"),
    sb.from("admins").select("telegram_id"),
  ]);
  if (settingsResult.error || adminsResult.error) throw new Error("Не удалось загрузить настройки");
  const s = settingsResult.data, a = adminsResult.data;
  const m: Record<string, any> = Object.fromEntries((s ?? []).map((r: any) => [r.key, r.value]));
  const envAdmin = Number(Deno.env.get("ADMIN_ID") ?? 0);
  const admins = (a ?? []).map((r: any) => Number(r.telegram_id));
  if (envAdmin && !admins.includes(envAdmin)) admins.push(envAdmin);
  const c: Config = {
    botToken: Deno.env.get("BOT_TOKEN") || m.bot_token || "",
    shopToken: Deno.env.get("SHOP_BOT_TOKEN") || m.client_bot_token || "",
    admins,
    promo: { ...DEFAULT_PROMO, ...(m.promo ?? {}) },
    payments: m.payments && Object.keys(m.payments).length ? m.payments : DEFAULT_PAYMENTS,
    cards: Array.isArray(m.payment_cards) && m.payment_cards.length ? m.payment_cards : DEFAULT_CARDS,
  };
  cache = { at: Date.now(), cfg: c };
  return c;
}
export const resetCfg = () => { cache = null; };
export const isAdmin = async (id: number) => (await cfg()).admins.includes(id);

const enc = new TextEncoder();

export async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

export const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Секрет вебхука выводится из токена бота, отдельный секрет не нужен
export const tokenOf = async (bot: BotKind) => bot === "admin" ? (await cfg()).botToken : (await cfg()).shopToken;
export const singleBot = async () => false;

export async function webhookSecret(bot: BotKind = "admin") {
  return hex(await hmac(enc.encode(await tokenOf(bot)), "webhook-secret")).slice(0, 48);
}

export type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };

// Проверка подписи Telegram для запросов из мини-эппа и админ-панели
export async function verifyInitData(initData: string, bot: BotKind | "any" = "shop"): Promise<TgUser | null> {
  const parsed = parseInitData(initData);
  if (!parsed) return null;
  const c = await cfg();
  const tokens = bot === "any" ? [c.shopToken, c.botToken] : [bot === "shop" ? c.shopToken : c.botToken];
  for (const token of new Set(tokens.filter(Boolean))) {
    const secret = await hmac(enc.encode("WebAppData"), token);
    if (safeEqual(hex(await hmac(secret, parsed.data)), parsed.hash)) return parsed.user;
  }
  return null;
}

// Вызов Telegram Bot API. По умолчанию — от клиентского бота.
export async function tg(method: string, body: Record<string, unknown>, bot: BotKind = "shop") {
  const token = await tokenOf(bot);
  if (!token) return { ok: false, description: "Бот не настроен" };
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", signal: AbortSignal.timeout(12_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) console.error("telegram", bot, method, data.description);
  return data;
}

// Отправка файла (multipart) — нужна, чтобы переслать фото от админского бота клиенту через клиентский
export async function tgUpload(method: string, field: string, file: Blob, filename: string,
  fields: Record<string, unknown>, bot: BotKind = "shop") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
  fd.append(field, file, filename);
  const r = await fetch(`https://api.telegram.org/bot${await tokenOf(bot)}/${method}`, { method: "POST", body: fd });
  const data = await r.json();
  if (!data.ok) console.error("telegram", bot, method, data.description);
  return data;
}

// Переслать сообщение админа (из админского бота) клиенту в клиентский бот: текст, фото, файл
export async function relayToClient(clientId: number, msg: any) {
  if (await singleBot()) {
    return tg("copyMessage", { chat_id: clientId, from_chat_id: msg.chat.id, message_id: msg.message_id });
  }
  const caption = msg.caption ?? undefined;
  const media = msg.photo?.length ? { id: msg.photo[msg.photo.length - 1].file_id, method: "sendPhoto", field: "photo", name: "photo.jpg" }
    : msg.document ? { id: msg.document.file_id, method: "sendDocument", field: "document", name: msg.document.file_name ?? "file" }
    : msg.video ? { id: msg.video.file_id, method: "sendVideo", field: "video", name: "video.mp4" }
    : null;
  if (media) {
    const f = await tg("getFile", { file_id: media.id }, "admin");
    if (!f.ok) return f;
    const blob = await (await fetch(`https://api.telegram.org/file/bot${await tokenOf("admin")}/${f.result.file_path}`)).blob();
    return tgUpload(media.method, media.field, blob, media.name, { chat_id: String(clientId), caption });
  }
  if (msg.text) return tg("sendMessage", { chat_id: clientId, text: msg.text });
  return { ok: false, description: "Поддерживаются текст, фото, видео и файлы" };
}

// Подключить вебхуки, команды и кнопку меню обоим ботам
export async function setupBots() {
  const c = await cfg();
  const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/bot`;
  const report: string[] = [];
  if (c.shopToken && c.shopToken === c.botToken) throw new Error("Основной и админский боты должны быть разными");
  for (const bot of ["shop", "admin"] as BotKind[]) {
    if (!await tokenOf(bot)) { report.push(`${bot}: токен не задан`); continue; }
    const result = await tg("setWebhook", {
      url: hook, secret_token: await webhookSecret(bot), allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }, bot);
    if (!result.ok) throw new Error(`Не удалось подключить ${bot}: ${result.description}`);
    const commands = bot === "shop"
      ? [{ command: "start", description: "Открыть RAMP" }, { command: "catalog", description: "Каталог товаров" }, { command: "myid", description: "Мой номер клиента" }]
      : [{ command: "start", description: "Панель управления" }, { command: "admin", description: "Админ-панель" }];
    await tg("setMyCommands", { commands }, bot);
    // Удаляем старые команды для отдельных админов, оставшиеся от совмещённого бота.
    for (const chat_id of c.admins) await tg("deleteMyCommands", { scope: { type: "chat", chat_id } }, bot);
    const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: bot === "shop" ? "RAMP" : "Панель", web_app: { url: bot === "shop" ? MINIAPP_URL : ADMIN_URL } } }, bot);
    if (!menu.ok) throw new Error("Не удалось обновить кнопку меню Telegram");
    report.push(`${bot}: подключён`);
  }
  return report;
}

export async function botStatus() {
  const entries = await Promise.all((["shop", "admin"] as BotKind[]).map(async (kind) => {
    if (!await tokenOf(kind)) return [kind, { configured: false, username: kind === "shop" ? SHOP_USERNAME : null }];
    const [me, hook] = await Promise.all([tg("getMe", {}, kind), tg("getWebhookInfo", {}, kind)]);
    return [kind, { configured: me.ok, username: me.result?.username ?? null,
      main_app: me.result?.has_main_web_app === true,
      webhook_ok: hook.ok && hook.result?.url === `${Deno.env.get("SUPABASE_URL")}/functions/v1/bot`,
      pending: hook.result?.pending_update_count ?? 0, error: hook.result?.last_error_message ?? null }];
  }));
  return Object.fromEntries(entries);
}

export const shopButton = (text = "RAMP", tab = "catalog") => ({
  inline_keyboard: [[{ text, style: "primary", web_app: { url: `${MINIAPP_URL}/?tab=${encodeURIComponent(tab)}` } }]],
});

export function statusKeyboard(orderId: number) {
  const b = (s: string) => ({ text: STATUS[s], callback_data: `st:${orderId}:${s}` });
  return {
    inline_keyboard: [
      [b("paid"), b("bought")],
      [b("shipping"), b("arrived")],
      [b("delivered"), b("cancelled")],
    ],
  };
}

export function receiptKeyboard(orderId: number) {
  return {
    inline_keyboard: [[
      { text: "✅ Оплата подтверждена", callback_data: `rc:ok:${orderId}`, style: "success" },
      { text: "❌ Отклонить", callback_data: `rc:no:${orderId}`, style: "danger" },
    ]],
  };
}

// Отправить уведомление всем админам и запомнить сообщения, чтобы ответ свайпом дошёл до клиента
export async function notifyAdmins(
  kind: "order" | "photo" | "receipt", refId: number, method: string, payload: Record<string, unknown>,
) {
  const { admins } = await cfg();
  await Promise.all(admins.map(async (chat_id) => {
    const sent = await tg(method, { ...payload, chat_id }, "admin");
    if (sent.ok) {
      await sb.from("admin_messages").insert({ chat_id, message_id: sent.result.message_id, kind, ref_id: refId });
    }
  }));
}

// Новые приглашения используют отдельный случайный токен. Старые ссылки поддерживаются.
export async function applyReferral(uid: number, rawCode: string) {
  const code = String(rawCode ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const token=/^INVITE_([0-9A-F]{32})$/.exec(code);
  if (!token && !/^RAMP-\d{6,18}$/.test(code)) return { ok: false, error: "Проверьте ссылку приглашения" };
  const uuid=token?.[1].replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/,'$1-$2-$3-$4-$5');
  const { data, error } = token ? await sb.rpc("ramp_apply_referral_token", {p_uid:uid,p_token:uuid}) : await sb.rpc("ramp_apply_referral", { p_uid: uid, p_code: code });
  if (error) { const message=error.code === "P0001" ? error.message : "Не удалось применить приглашение";return {ok:false,error:message.replace("Нельзя указать собственный ID","Нельзя приглашать самого себя").replace("Пользователь с таким ID не найден","Ссылка приглашения не найдена").replace("Код друга уже указан","Приглашение уже применено").replace("Код друга можно указать только до первого заказа","Приглашение доступно только до первого заказа")}; }
  if (data.changed) {
    const { promo } = await cfg();
    await bestEffort(() => tg("sendMessage", { chat_id: data.referrer,
      text: `🎉 По вашему приглашению пришёл покупатель. После оплаты его заказа от ${fmt(promo.minQualifyingOrder)} вам купон −${promo.inviterPct}%.` }));
  }
  return { ok: true };
}

export async function getReferralLink(uid: number) {
  const profile=await sb.from("profiles").select("referral_token").eq("telegram_id",uid).single();
  if(profile.error || !profile.data?.referral_token)throw new Error("Не удалось получить ссылку приглашения");
  const username=await getBotUsername();
  return username?`https://t.me/${username}?start=invite_${profile.data.referral_token.replaceAll('-','')}`:null;
}

// Ошибка доставки уведомления не отменяет уже сохранённый заказ или платёж.
export async function bestEffort(fn: () => Promise<unknown>) {
  try { return await fn(); } catch { console.error("notification delivery failed"); return null; }
}

export async function setOrderStatus(orderId: number, status: string, reason = "", expected: string | null = null) {
  const { data, error } = await sb.rpc("ramp_set_order_status", {
    p_order_id: orderId, p_status: status, p_reason: reason, p_expected: expected,
  });
  if (error) throw new Error(error.code === "P0001" ? error.message : "Не удалось обновить заказ");
  if (!data?.order) return null;
  const order = data.order;
  if (data.changed) await bestEffort(() => tg("sendMessage", {
    chat_id: order.telegram_id,
    text: `📦 Заказ №${order.id}: ${STATUS[status]}${reason ? `\n${reason}` : ""}`,
    reply_markup: shopButton("Мои заказы", "orders"),
  }));
  for (const reward of data.rewards ?? []) await bestEffort(() => tg("sendMessage", {
    chat_id: reward.telegram_id, text: `🎁 Вам купон −${reward.pct}% за приглашение друга. Он применится к следующему заказу.`,
    reply_markup: shopButton("Мои купоны", "profile"),
  }));
  return order;
}

export async function reviewReceipt(orderId: number, approve: boolean, reason = "") {
  try {
    const order = await setOrderStatus(orderId, approve ? "paid" : "new", approve ? "" : reason || "Чек не прошёл проверку", "review");
    return order ? { ok: true } : { ok: false, error: "Заказ не найден" };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Не удалось проверить чек" }; }
}

// Ответ клиенту по фотозаявке (из бота или админ-панели)
export async function answerPhotoRequest(id: number, text: string) {
  const { data: pr } = await sb.from("photo_requests").update({
    status: "answered", answer: text, answered_at: new Date().toISOString(),
  }).eq("id", id).select("id,telegram_id").maybeSingle();
  if (!pr) return null;
  await tg("sendMessage", {
    chat_id: pr.telegram_id,
    text: `📷 Ответ по вашей заявке №${pr.id}:\n\n${text}`,
    reply_markup: shopButton(),
  });
  return pr;
}

const usernames: Record<string, string> = {};
// Имя клиентского бота (для реферальных ссылок)
export async function getBotUsername(bot: BotKind = "shop") {
  const token = await tokenOf(bot);
  if (!token) return bot === "shop" ? SHOP_USERNAME : null;
  if (!usernames[token]) {
    const me = await tg("getMe", {}, bot);
    if (me.ok) usernames[token] = me.result.username;
  }
  return usernames[token] ?? null;
}

export const normPhone = (p: string) => {
  const d = String(p ?? "").replace(/[^\d]/g, "");
  return d ? "+" + d : "";
};

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

export const fmt = (n: number) =>
  Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " сум";

