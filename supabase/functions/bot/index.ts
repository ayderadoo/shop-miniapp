// Вебхук Telegram-бота: /start (номер телефона, приглашения), ответы админа, статусы заказов.
// Первый запуск: открыть в браузере .../functions/v1/bot?setup=1
import {
  ADMIN_URL, answerPhotoRequest, applyReferral, cfg, fmt, isAdmin, MINIAPP_URL, normPhone, safeEqual, sb,
  setOrderStatus, shopButton, STATUS, tg, webhookSecret,
} from "../_shared/common.ts";

const adminButtons = {
  inline_keyboard: [
    [{ text: "⚙️ Админ-панель", web_app: { url: ADMIN_URL } }],
    [{ text: "🛍 Магазин", web_app: { url: MINIAPP_URL } }],
  ],
};

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

  const { promo } = await cfg();

  // /start ref_RAMP-123456 — пришёл по приглашению
  const payload = (msg.text ?? "").split(" ")[1] ?? "";
  if (payload.startsWith("ref_")) {
    const res = await applyReferral(msg.from.id, payload.slice(4));
    if (res.ok) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `🎁 Вы пришли по приглашению друга. Оформите заказ от ${fmt(promo.minQualifyingOrder)} — ` +
          `после оплаты получите купон −${promo.inviteeNextPct}% на следующий заказ.`,
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

  if (await isAdmin(msg.from.id)) {
    await tg("sendMessage", { chat_id: chatId, text: "Вы администратор RAMP. Панель управления 👇", reply_markup: adminButtons });
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

  const admin = fromId ? await isAdmin(fromId) : false;

  if (admin && text.startsWith("/admin")) {
    return tg("sendMessage", { chat_id: chatId, text: "Панель управления RAMP 👇", reply_markup: adminButtons });
  }

  // Ответ админа свайпом на заказ или заявку -> клиенту
  if (admin && msg.reply_to_message) {
    const { data: link } = await sb.from("admin_messages").select("kind,ref_id")
      .eq("chat_id", chatId).eq("message_id", msg.reply_to_message.message_id).maybeSingle();
    if (!link) return tg("sendMessage", { chat_id: chatId, text: "Не нашёл заказ или заявку для этого сообщения." });

    const answerText = msg.text ?? msg.caption ?? "";
    if (link.kind === "photo") {
      const pr = await answerPhotoRequest(link.ref_id, answerText || "Ответ отправлен в чат с ботом");
      if (!pr) return tg("sendMessage", { chat_id: chatId, text: "Заявка не найдена." });
      if (!msg.text) await tg("copyMessage", { chat_id: pr.telegram_id, from_chat_id: chatId, message_id: msg.message_id });
      return tg("sendMessage", { chat_id: chatId, text: `✅ Ответ по заявке №${pr.id} отправлен клиенту` });
    }

    const { data: order } = await sb.from("orders").select("id,telegram_id").eq("id", link.ref_id).maybeSingle();
    if (!order) return tg("sendMessage", { chat_id: chatId, text: "Заказ не найден." });
    await tg("sendMessage", { chat_id: order.telegram_id, text: `💬 Сообщение по заказу №${order.id}:` });
    await tg("copyMessage", { chat_id: order.telegram_id, from_chat_id: chatId, message_id: msg.message_id });
    return tg("sendMessage", { chat_id: chatId, text: `✅ Отправлено клиенту по заказу №${order.id}` });
  }

  return tg("sendMessage", {
    chat_id: chatId,
    text: "Всё делается в магазине: каталог, поиск по фото, корзина и заказы 👇",
    reply_markup: shopButton(),
  });
}

async function onCallback(cb: any) {
  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: cb.id, text });
  if (!cb.from?.id || !(await isAdmin(cb.from.id))) return answer("Нет доступа");

  const m = /^st:(\d+):(\w+)$/.exec(cb.data ?? "");
  if (!m || !STATUS[m[2]]) return answer("Неизвестная команда");
  const order = await setOrderStatus(Number(m[1]), m[2]);
  if (!order) return answer("Заказ не найден");
  return answer(`Заказ №${order.id}: ${STATUS[m[2]]}`);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    if (!(await cfg()).botToken) return new Response("Токен бота не задан", { status: 500 });
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
    // Админам — дополнительная команда /admin
    for (const id of (await cfg()).admins) {
      await tg("setMyCommands", {
        scope: { type: "chat", chat_id: id },
        commands: [
          { command: "start", description: "Открыть магазин" },
          { command: "admin", description: "Админ-панель" },
          { command: "myid", description: "Мой ID в RAMP" },
        ],
      });
    }
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
