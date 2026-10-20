import { createClient } from "jsr:@supabase/supabase-js@2";

export const MINIAPP_URL = "https://shop-miniapp-two.vercel.app";
export const ADMIN_URL = `${MINIAPP_URL}/admin.html`;

export const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export const STATUS: Record<string, string> = {
  new: "Новый — ждёт оплаты",
  paid: "Оплачен",
  bought: "Выкуплен в Китае",
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

type Config = { botToken: string; admins: number[]; promo: Promo; payments: Record<string, string> };
let cache: { at: number; cfg: Config } | null = null;

// Настройки из базы (токен бота, админы, скидки, оплата). Кэш на 20 секунд.
export async function cfg(): Promise<Config> {
  if (cache && Date.now() - cache.at < 20_000) return cache.cfg;
  const [{ data: s }, { data: a }] = await Promise.all([
    sb.from("settings").select("key,value"),
    sb.from("admins").select("telegram_id"),
  ]);
  const m: Record<string, any> = Object.fromEntries((s ?? []).map((r: any) => [r.key, r.value]));
  const envAdmin = Number(Deno.env.get("ADMIN_ID") ?? 0);
  const admins = (a ?? []).map((r: any) => Number(r.telegram_id));
  if (envAdmin && !admins.includes(envAdmin)) admins.push(envAdmin);
  const c: Config = {
    botToken: Deno.env.get("BOT_TOKEN") || m.bot_token || "",
    admins,
    promo: { ...DEFAULT_PROMO, ...(m.promo ?? {}) },
    payments: m.payments && Object.keys(m.payments).length ? m.payments : DEFAULT_PAYMENTS,
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
export async function webhookSecret() {
  return hex(await hmac(enc.encode((await cfg()).botToken), "webhook-secret")).slice(0, 48);
}

export type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };

// Проверка подписи Telegram для запросов из мини-эппа и админ-панели
export async function verifyInitData(initData: string): Promise<TgUser | null> {
  const token = (await cfg()).botToken;
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), token);
  if (!safeEqual(hex(await hmac(secret, dataCheck)), hash)) return null;
  const authDate = Number(params.get("auth_date") ?? 0);
  if (Date.now() / 1000 - authDate > 7 * 86400) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

export async function tg(method: string, body: Record<string, unknown>) {
  const token = (await cfg()).botToken;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) console.error("telegram", method, data.description);
  return data;
}

export const shopButton = (text = "🛍 Открыть RAMP") => ({
  inline_keyboard: [[{ text, web_app: { url: MINIAPP_URL } }]],
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

// Отправить уведомление всем админам и запомнить сообщения, чтобы ответ свайпом дошёл до клиента
export async function notifyAdmins(
  kind: "order" | "photo", refId: number, method: string, payload: Record<string, unknown>,
) {
  const { admins } = await cfg();
  await Promise.all(admins.map(async (chat_id) => {
    const sent = await tg(method, { ...payload, chat_id });
    if (sent.ok) {
      await sb.from("admin_messages").insert({ chat_id, message_id: sent.result.message_id, kind, ref_id: refId });
    }
  }));
}

// Привязка к пригласившему по его ID (RAMP-123456). Только до первого заказа.
export async function applyReferral(uid: number, rawCode: string) {
  const { promo } = await cfg();
  const code = String(rawCode ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^RAMP-\d{6}$/.test(code)) return { ok: false, error: "ID выглядит так: RAMP-123456" };

  const { data: me } = await sb.from("profiles").select("telegram_id,referred_by")
    .eq("telegram_id", uid).maybeSingle();
  if (!me) return { ok: false, error: "Профиль не найден" };
  if (me.referred_by) return { ok: false, error: "Код друга уже указан" };

  const { count } = await sb.from("orders").select("id", { count: "exact", head: true })
    .eq("telegram_id", uid).neq("status", "cancelled");
  if ((count ?? 0) > 0) return { ok: false, error: "Код друга можно указать только до первого заказа" };

  const { data: ref } = await sb.from("profiles").select("telegram_id,referred_by")
    .eq("public_id", code).maybeSingle();
  if (!ref) return { ok: false, error: "Пользователь с таким ID не найден" };
  if (ref.telegram_id === uid) return { ok: false, error: "Нельзя указать собственный ID" };
  if (ref.referred_by === uid) return { ok: false, error: "Этот пользователь пришёл по вашему приглашению" };

  const { data: upd } = await sb.from("profiles")
    .update({ referred_by: ref.telegram_id, referred_at: new Date().toISOString() })
    .eq("telegram_id", uid).is("referred_by", null).select("telegram_id");
  if (!upd?.length) return { ok: false, error: "Код друга уже указан" };

  await tg("sendMessage", {
    chat_id: ref.telegram_id,
    text: `🎉 По вашему приглашению пришёл новый покупатель. Когда он оплатит заказ от ` +
      `${fmt(promo.minQualifyingOrder)}, вы получите купон −${promo.inviterPct}% на следующий заказ.`,
  });
  return { ok: true };
}

// Купоны при смене статуса. Флаг ref_rewarded у приглашённого защищает от повторной выдачи.
async function settleOrder(orderId: number, status: string) {
  const { promo } = await cfg();
  if (PAID_OR_LATER.includes(status)) {
    const { data: o } = await sb.from("orders").select("id,telegram_id,subtotal").eq("id", orderId).single();
    if (!o || (o.subtotal ?? 0) < promo.minQualifyingOrder) return;

    const { data: buyer } = await sb.from("profiles").update({ ref_rewarded: true })
      .eq("telegram_id", o.telegram_id).eq("ref_rewarded", false).not("referred_by", "is", null)
      .select("telegram_id,referred_by").maybeSingle();
    if (!buyer) return;

    await sb.from("coupons").insert([
      { telegram_id: buyer.referred_by, pct: promo.inviterPct, reason: "ref_inviter", source_order_id: o.id },
      { telegram_id: buyer.telegram_id, pct: promo.inviteeNextPct, reason: "ref_invitee", source_order_id: o.id },
    ]);
    await tg("sendMessage", {
      chat_id: buyer.referred_by,
      text: `🎁 Ваш друг оплатил заказ — вам купон −${promo.inviterPct}% на следующий заказ. ` +
        "Скидка применится автоматически при оформлении.",
      reply_markup: shopButton(),
    });
    await tg("sendMessage", {
      chat_id: buyer.telegram_id,
      text: `🎁 Спасибо за заказ! Ваш купон −${promo.inviteeNextPct}% на следующий заказ уже в профиле.`,
    });
  }

  // Отмена заказа возвращает использованный купон
  if (status === "cancelled") {
    await sb.from("coupons").update({ used_order_id: null, used_at: null }).eq("used_order_id", orderId);
  }
}

// Смена статуса заказа: из бота (кнопки) и из админ-панели
export async function setOrderStatus(orderId: number, status: string) {
  if (!STATUS[status]) return null;
  const { data: order } = await sb.from("orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", orderId).select("id,telegram_id,status").maybeSingle();
  if (!order) return null;
  await settleOrder(order.id, status);
  await tg("sendMessage", {
    chat_id: order.telegram_id,
    parse_mode: "HTML",
    text: `📦 Заказ №${order.id}: <b>${esc(STATUS[status])}</b>`,
    reply_markup: shopButton("Мои заказы"),
  });
  return order;
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

let botUsername: string | null = null;
export async function getBotUsername() {
  if (!botUsername) {
    const me = await tg("getMe", {});
    botUsername = me.ok ? me.result.username : null;
  }
  return botUsername;
}

export const normPhone = (p: string) => {
  const d = String(p ?? "").replace(/[^\d]/g, "");
  return d ? "+" + d : "";
};

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

export const fmt = (n: number) =>
  Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " сум";
