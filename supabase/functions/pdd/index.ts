// Вебхук бота-импортёра Пиндодо. Ключи PDD_BOT_TOKEN, TMAPI_KEY, GEMINI_API_KEY: env (если задан) или закрытая таблица pdd_bot_secrets.
// Деплой: supabase functions deploy pdd --project-ref wtfeujuyklteisnrqksl --no-verify-jwt
import { createBot, DEFAULT_SETTINGS, type ItemRow, type Settings, type Store, webhookSecret } from "./core.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`db ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const store: Store = {
  async getSettings() {
    const rows = await rest("pdd_bot_settings?id=eq.1&select=data");
    return { ...DEFAULT_SETTINGS, ...(rows?.[0]?.data || {}) } as Settings;
  },
  async saveSettings(s) {
    await rest("pdd_bot_settings", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ id: 1, data: s }) });
  },
  async getItem(goodsId) {
    if (!/^\d+$/.test(goodsId)) return null;
    const rows = await rest(`pdd_imports?goods_id=eq.${goodsId}&select=goods_id,raw,ai,weight_kg,fetched_at`);
    const r = rows?.[0];
    return r ? { ...r, goods_id: String(r.goods_id), weight_kg: r.weight_kg == null ? null : Number(r.weight_kg) } as ItemRow : null;
  },
  async saveItem(row) {
    await rest("pdd_imports", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }) });
  },
};

let cached: { at: number; token: string; bot: ReturnType<typeof createBot>; secret: string } | null = null;

async function getBot() {
  if (cached && Date.now() - cached.at < 300_000) return cached;
  const rows: { name: string; value: string }[] = await rest("pdd_bot_secrets?select=name,value");
  const key = (name: string) => Deno.env.get(name) || rows.find(r => r.name === name)?.value || "";
  const token = key("PDD_BOT_TOKEN");
  const bot = createBot({
    token,
    tmapiKey: key("TMAPI_KEY"),
    geminiKey: key("GEMINI_API_KEY"),
    geminiModels: key("GEMINI_MODELS").split(",").map(s => s.trim()).filter(Boolean),
    store,
    log: (...a) => console.log(...a),
  });
  return cached = { at: Date.now(), token, bot, secret: token ? await webhookSecret(token) : "" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const { bot, secret } = await getBot();
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });
  const update = await req.json().catch(() => null);
  if (!update) return new Response("ok");
  // Отвечаем Telegram сразу, обработка (TMAPI + Gemini) идёт в фоне
  const work = bot.handleUpdate(update).catch(e => console.error("pdd", e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return new Response("ok");
});
