// Локальный запуск бота-импортёра без сервера (long polling), данные — в JSON-файле.
// PDD_BOT_TOKEN=... TMAPI_KEY=... GEMINI_API_KEY=... node scripts/pdd_bot_local.ts [store.json]
import { readFileSync, writeFileSync } from "node:fs";
import { createBot, DEFAULT_SETTINGS, type Store } from "../supabase/functions/pdd/core.ts";

const file = process.argv[2] || "pdd-bot-store.json";
const token = process.env.PDD_BOT_TOKEN || "";
if (!token) throw new Error("PDD_BOT_TOKEN не задан");

let db: { settings: any; items: Record<string, any> } = { settings: {}, items: {} };
try { db = JSON.parse(readFileSync(file, "utf8")); } catch { /* новый файл */ }
const flush = () => writeFileSync(file, JSON.stringify(db));

const store: Store = {
  getSettings: async () => ({ ...DEFAULT_SETTINGS, ...db.settings }),
  saveSettings: async (s) => { db.settings = s; flush(); },
  getItem: async (id) => db.items[id] ? structuredClone(db.items[id]) : null,
  saveItem: async (row) => { db.items[row.goods_id] = row; flush(); },
};

const bot = createBot({
  token,
  tmapiKey: process.env.TMAPI_KEY || "",
  geminiKey: process.env.GEMINI_API_KEY || "",
  store,
  log: (...a) => console.log(new Date().toISOString(), ...a),
});

const api = (method: string, body: object) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

await api("setMyCommands", { commands: [
  { command: "calc", description: "Текущий курс, наценка, карго" },
  { command: "rate", description: "Курс юаня: /rate 1780 или /rate auto" },
  { command: "markup", description: "Наценка: /markup 30" },
  { command: "cargo", description: "Карго $ за кг: /cargo 7" },
  { command: "demo", description: "Пример карточки" },
  { command: "help", description: "Помощь" },
] });
console.log("Бот запущен, жду сообщения…");
let offset = 0;
for (;;) {
  try {
    const res: any = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
    for (const u of res.result || []) {
      offset = u.update_id + 1;
      bot.handleUpdate(u).catch(e => console.error("update", e));
    }
    if (!res.ok) { console.error(res); await new Promise(r => setTimeout(r, 5000)); }
  } catch (e) {
    console.error("poll", e);
    await new Promise(r => setTimeout(r, 3000));
  }
}
