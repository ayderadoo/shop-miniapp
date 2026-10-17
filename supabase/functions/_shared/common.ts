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

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

export const fmt = (n: number) =>
  n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " сум";
