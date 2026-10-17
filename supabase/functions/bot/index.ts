// Вебхук Telegram-бота: /start, ответы админа на заявки, смена статусов заказов.
// Первый запуск: открыть в браузере .../functions/v1/bot?setup=1
import {
  ADMIN_ID, BOT_TOKEN, esc, MINIAPP_URL, safeEqual, sb, STATUS, tg, webhookSecret,
} from "../_shared/common.ts";

const shopButton = (text = "🛍 Открыть магазин") => ({
  inline_keyboard: [[{ text, web_app: { url: MINIAPP_URL } }]],
});

async function onMessage(msg: any) {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const text: string = msg.text ?? "";

  if (text.startsWith("/myid")) {
    return tg("sendMessage", { chat_id: chatId, text: `Ваш Telegram ID: ${fromId}` });
  }

  if (text.startsWith("/start")) {
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Привет! 👋 Это RAMP.\n\nКаталог, поиск по фото, корзина и ваши заказы — в магазине:",
      reply_markup: shopButton(),
    });
  }

  // Ответ админа на заявку или заказ -> клиенту
  if (ADMIN_ID && fromId === ADMIN_ID && msg.reply_to_message) {
    const replyTo = msg.reply_to_message.message_id;
    const answerText = msg.text ?? msg.caption ?? "";

    const { data: pr } = await sb.from("photo_requests")
      .select("id,telegram_id").eq("admin_message_id", replyTo).maybeSingle();
    if (pr) {
      await sb.from("photo_requests").update({
        status: "answered",
        answer: answerText || "Ответ отправлен в чат с ботом",
        answered_at: new Date().toISOString(),
      }).eq("id", pr.id);
      await tg("sendMessage", { chat_id: pr.telegram_id, text: `📷 Ответ по вашей заявке №${pr.id}:` });
      await tg("copyMessage", { chat_id: pr.telegram_id, from_chat_id: chatId, message_id: msg.message_id });
      await tg("sendMessage", {
        chat_id: pr.telegram_id,
        text: "Ответ также сохранён в разделе «Фото» в магазине.",
        reply_markup: shopButton(),
      });
      return tg("sendMessage", { chat_id: chatId, text: `✅ Ответ по заявке №${pr.id} отправлен клиенту` });
    }

    const { data: order } = await sb.from("orders")
      .select("id,telegram_id").eq("admin_message_id", replyTo).maybeSingle();
    if (order) {
      await tg("sendMessage", { chat_id: order.telegram_id, text: `💬 Сообщение по заказу №${order.id}:` });
      await tg("copyMessage", { chat_id: order.telegram_id, from_chat_id: chatId, message_id: msg.message_id });
      return tg("sendMessage", { chat_id: chatId, text: `✅ Отправлено клиенту по заказу №${order.id}` });
    }

    return tg("sendMessage", { chat_id: chatId, text: "Не нашёл заявку или заказ для этого сообщения." });
  }

  return tg("sendMessage", {
    chat_id: chatId,
    text: "Всё делается в магазине: каталог, поиск по фото, корзина и заказы 👇",
    reply_markup: shopButton(),
  });
}

async function onCallback(cb: any) {
  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: cb.id, text });
  if (!ADMIN_ID || cb.from?.id !== ADMIN_ID) return answer("Нет доступа");

  const m = /^st:(\d+):(\w+)$/.exec(cb.data ?? "");
  if (!m || !STATUS[m[2]]) return answer("Неизвестная команда");
  const [, id, status] = m;

  const { data: order, error } = await sb.from("orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", Number(id)).select("id,telegram_id").maybeSingle();
  if (error || !order) return answer("Заказ не найден");

  await tg("sendMessage", {
    chat_id: order.telegram_id,
    parse_mode: "HTML",
    text: `📦 Заказ №${order.id}: <b>${esc(STATUS[status])}</b>`,
    reply_markup: shopButton("Мои заказы"),
  });
  return answer(`Заказ №${order.id}: ${STATUS[status]}`);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    if (!BOT_TOKEN) return new Response("BOT_TOKEN не задан в секретах Supabase", { status: 500 });
    const hookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/bot`;
    const res = await tg("setWebhook", {
      url: hookUrl,
      secret_token: await webhookSecret(),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await tg("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть магазин" },
        { command: "myid", description: "Узнать свой Telegram ID" },
      ],
    });
    const ok = res.ok
      ? "✅ Бот подключён. Можно закрыть страницу."
      : `❌ Ошибка: ${res.description}`;
    return new Response(ok, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (req.method !== "POST") return new Response("ok");

  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(got, await webhookSecret())) return new Response("forbidden", { status: 403 });

  try {
    const update = await req.json();
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error(e);
  }
  // Всегда 200, чтобы Telegram не повторял обновление
  return new Response("ok");
});
