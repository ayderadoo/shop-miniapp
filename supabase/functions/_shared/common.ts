import { createClient } from "jsr:@supabase/supabase-js@2";

export const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
export const ADMIN_ID = Number(Deno.env.get("ADMIN_ID") ?? 0);
export const MINIAPP_URL = "https://shop-miniapp-two.vercel.app";

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

// ===== Настройки программы лояльности: меняйте цифры здесь =====

// Ранги считаются по сумме доставленных заказов
export const RANKS = [
  { key: "bronze", name: "Бронза", min: 0, discount: 0 },
  { key: "silver", name: "Серебро", min: 3_000_000, discount: 3 },
  { key: "gold", name: "Золото", min: 10_000_000, discount: 5 },
  { key: "platinum", name: "Платина", min: 25_000_000, discount: 7 },
];

export const REFERRAL = {
  friendFirstOrderPct: 5, // скидка другу на первый заказ
  referrerBonusPct: 2,    // бонусы пригласившему с каждого доставленного заказа друга
};

export const BONUS_MAX_SHARE = 0.3; // бонусами можно оплатить до 30% заказа (1 бонус = 1 сум)

export const PAYMENTS: Record<string, string> = {
  card: "Перевод на карту (Humo / Uzcard)",
  click: "Click",
  payme: "Payme",
  uzum: "Uzum Bank",
};

export function rankFor(spent: number) {
  let i = 0;
  for (let k = 0; k < RANKS.length; k++) if (spent >= RANKS[k].min) i = k;
  return { ...RANKS[i], index: i, next: RANKS[i + 1] ?? null };
}

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
  return hex(await hmac(enc.encode(BOT_TOKEN), "webhook-secret")).slice(0, 48);
}

export async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) console.error("telegram", method, data.description);
  return data;
}

// Привязка к пригласившему по его ID (RAMP-123456). Только до первого заказа.
export async function applyReferral(uid: number, rawCode: string) {
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
    text: `🎉 По вашему приглашению пришёл новый покупатель. ` +
      `С каждой его доставленной покупки вы получите ${REFERRAL.referrerBonusPct}% бонусами.`,
  });
  return { ok: true };
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
  n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " сум";
