// Вебхук Telegram-бота: /start (номер телефона, приглашения), ответы админа, статусы заказов.
// Первый запуск: открыть в браузере .../functions/v1/bot?setup=1
import {
  ADMIN_ID, applyReferral, BOT_TOKEN, esc, fmt, MINIAPP_URL, normPhone, REFERRAL, safeEqual, sb,
  STATUS, tg, webhookSecret,
} from "../_shared/common.ts";

const shopButton = (text = "🛍 Открыть RAMP") => ({
  inline_keyboard: [[{ text, web_app: { url: MINIAPP_URL } }]],
});

const phoneKeyboard = {
  keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
  is_persistent: true,
};

async function ensureProfile(from: any) {
  await sb.from("profiles").upsert({
    telegram_id: from.id,
    first_name: from.first_name ?? null,
    last_name: from.last_name ?? null,
    username: from.username ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "telegram_id" });
  const { data } = await sb.from("profiles").select("public_id,tg_phone").eq("telegram_id", from.id).single();
  return data!;
}

async function onStart(msg: any) {
  const chatId = msg.chat.id;
  const profile = await ensureProfile(msg.from);

  // /start ref_RAMP-123456 — пришёл по приглашению
  const payload = (msg.text ?? "").split(" ")[1] ?? "";
  if (payload.startsWith("ref_")) {
    const res = await applyReferral(msg.from.id, payload.slice(4));
    if (res.ok) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `🎁 Вы пришли по приглашению друга — скидка ${REFERRAL.friendFirstOrderPct}% на первый заказ.`,
      });
    }
  }

  if (!profile.tg_phone) {
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Привет! 👋 Это RAMP.\n\nВаш ID: ${profile.public_id}\n\n` +
        "Чтобы оформлять заказы и получать уведомления о доставке, поделитесь номером телефона — кнопка внизу 👇",
      reply_markup: phoneKeyboard,
    });
  }

  return tg("sendMessage", {
    chat_id: chatId,
    text: `Привет! 👋 Это RAMP.\nВаш ID: ${profile.public_id}\n\n` +
      "Каталог, поиск по фото, корзина и ваши заказы — в магазине:",
    reply_markup: shopButton(),
  });
}

async function onContact(msg: any) {
  const chatId = msg.chat.id;
  const c = msg.contact;
  if (!c?.user_id || c.user_id !== msg.from?.id) {
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Нужен ваш собственный номер — нажмите кнопку «Поделиться номером».",
      reply_markup: phoneKeyboard,
    });
  }
  await ensureProfile(msg.from);
  const phone = normPhone(c.phone_number);
  await sb.from("profiles").update({ tg_phone: phone }).eq("telegram_id", msg.from.id);
  // Подставим в данные доставки, если там пусто
  await sb.from("profiles").update({ phone }).eq("telegram_id", msg.from.id).or("phone.is.null,phone.eq.");

  await tg("sendMessage", {
    chat_id: chatId,
    text: `✅ Номер ${phone} подтверждён.`,
    reply_markup: { remove_keyboard: true },
  });
  return tg("sendMessage", { chat_id: chatId, text: "Добро пожаловать в RAMP 👇", reply_markup: shopButton() });
}

async function onMessage(msg: any) {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const text: string = msg.text ?? "";

  if (msg.contact) return onContact(msg);
  if (text.startsWith("/start")) return onStart(msg);

  if (text.startsWith("/myid")) {
    const p = await ensureProfile(msg.from);
    return tg("sendMessage", { chat_id: chatId, text: `Ваш ID в RAMP: ${p.public_id}\nTelegram ID: ${fromId}` });
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

// Начисления при смене статуса. Флаги в заказе защищают от повторного начисления.
async function settleOrder(orderId: number, status: string) {
  if (status === "delivered") {
    const { data: o } = await sb.from("orders").update({ ref_bonus_paid: true })
      .eq("id", orderId).eq("ref_bonus_paid", false).select("id,telegram_id,total").maybeSingle();
    if (!o) return;
    const { data: buyer } = await sb.from("profiles").select("referred_by").eq("telegram_id", o.telegram_id).single();
    if (!buyer?.referred_by) return;
    const bonus = Math.round(o.total * REFERRAL.referrerBonusPct / 100);
    if (bonus <= 0) return;
    await sb.rpc("add_bonus", { p_tg: buyer.referred_by, p_delta: bonus });
    await tg("sendMessage", {
      chat_id: buyer.referred_by,
      text: `🎁 Ваш друг получил заказ — вам начислено ${fmt(bonus).replace(" сум", "")} бонусов.`,
      reply_markup: shopButton(),
    });
  }

  if (status === "cancelled") {
    const { data: o } = await sb.from("orders").update({ bonus_refunded: true })
      .eq("id", orderId).eq("bonus_refunded", false).gt("bonus_used", 0)
      .select("telegram_id,bonus_used").maybeSingle();
    if (o) await sb.rpc("add_bonus", { p_tg: o.telegram_id, p_delta: o.bonus_used });
  }
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

  await settleOrder(order.id, status);

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
        { command: "myid", description: "Мой ID в RAMP" },
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
