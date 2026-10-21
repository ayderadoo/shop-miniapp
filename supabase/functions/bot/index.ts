// Вебхук обоих Telegram-ботов RAMP. Какой бот прислал обновление — определяем по секрету вебхука.
//  • клиентский («shop»): /start с приветствием и запросом номера, приглашения, /myid;
//  • админский («admin»): только для админов — панель, новые заказы, чеки, ответы клиентам свайпом.
// Подключение ботов — только через защищённые настройки админ-панели.
import {
  ADMIN_URL, answerPhotoRequest, applyReferral, type BotKind, cfg, esc, fmt, getBotUsername, isAdmin, MINIAPP_URL,
  normPhone, relayToClient, reviewReceipt, safeEqual, sb, setOrderStatus, setupBots, shopButton, singleBot, STATUS,
  SUPPORT_USERNAME, tg, tokenOf, webhookSecret, isUzbekPhone,
} from "../_shared/common.ts";
import { channelStatus, hasSubscription, subscriptionKeyboard, subscriptionText, verifySubscription } from "../_shared/subscription.ts";

const adminButtons = {
  inline_keyboard: [
    [{ text: "⚙️ Админ-панель", style: "primary", web_app: { url: ADMIN_URL } }],
    [{ text: "🛍 Основной бот", url: "https://t.me/ramp_uzbot" }],
  ],
};

const phoneKeyboard = {
  keyboard: [[{ text: "📱 Поделиться номером", request_contact: true, style: "primary" }]],
  resize_keyboard: true,
  one_time_keyboard: true,
  is_persistent: true,
};

// Существующие ID сохраняются; повторный /start не создаёт нового клиента.
async function ensureProfile(from: any) {
  const names = { first_name: from.first_name ?? null, last_name: from.last_name ?? null, username: from.username ?? null };
  const existing = await sb.from("profiles").select("telegram_id").eq("telegram_id",from.id).maybeSingle();
  if (existing.error) throw new Error("profile lookup failed");
  if (existing.data) {
    const updated = await sb.from("profiles").update({ ...names, updated_at: new Date().toISOString() }).eq("telegram_id",from.id);
    if (updated.error) throw new Error("profile update failed");
  } else {
    const created = await sb.from("profiles").insert({ telegram_id: from.id, ...names });
    if (created.error && created.error.code !== "23505") throw new Error("profile creation failed");
  }
  const { data, error } = await sb.from("profiles").select("user_no,delivery_id,tg_phone,blocked,phone,subscription_verified_at,subscription_channel").eq("telegram_id",from.id).single();
  if (error || !data) throw new Error("profile not available");
  return data;
}

async function sendShop(body: Record<string, unknown>) {
  const sent = await tg("sendMessage",body);
  if (!sent.ok) throw new Error("shop message delivery failed");
  return sent;
}

async function subscriptionGate(uid: number, profile: any) {
  if (hasSubscription(profile)) return true;
  const checked = await verifySubscription(uid);
  if (checked.subscribed) return true;
  await sendShop({ chat_id: uid, parse_mode: "HTML", text: subscriptionText(checked.unavailable), reply_markup: subscriptionKeyboard() });
  return false;
}

/* ===================== Клиентский бот ===================== */

async function shopStart(msg: any) {
  const chatId = msg.chat.id;
  const profile = await ensureProfile(msg.from);
  if (profile.blocked) return sendShop({ chat_id:chatId, text:"Доступ к магазину ограничен. Поддержка: @ramphelper" });
  const { promo } = await cfg();

  // /start ref_RAMP-123456 — пришёл по приглашению
  const payload = (msg.text ?? "").split(" ")[1] ?? "";
  if (payload.startsWith("ref_") || payload.startsWith("invite_")) {
    const res = await applyReferral(msg.from.id, payload.startsWith("ref_") ? payload.slice(4) : payload);
    if (res.ok) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `🎁 Вы пришли по приглашению друга. Оформите заказ от ${fmt(promo.minQualifyingOrder)} — ` +
          `после оплаты получите купон −${promo.inviteeNextPct}% на следующий заказ.`,
      });
    }
  }

  if (!await subscriptionGate(msg.from.id, profile)) return;
  const name = msg.from.first_name ? `, ${esc(msg.from.first_name)}` : "";
  const welcome = `👋 <b>Добро пожаловать в RAMP${name}!</b>\n\n` +
    `Ваш личный ID для заказов: <code>${profile.delivery_id}</code>\n\n` +
    `🎁 Новым покупателям — <b>скидка ${promo.welcomePct}%</b> на все заказы <b>${promo.welcomeDays} дней</b>.\n\n` +
    `📷 <b>Не нашли товар?</b> Пришлите фото — найдём и посчитаем цену.\n\n` +
    `💬 Поддержка: @${SUPPORT_USERNAME}`;

  if (!isUzbekPhone(profile.tg_phone)) {
    return sendShop({
      chat_id: chatId,
      parse_mode: "HTML",
      text: welcome + "\n\n📱 <b>Подтвердите номер Узбекистана (+998)</b> — нажмите <b>«Поделиться номером»</b> внизу. Нужен ваш собственный контакт Telegram.",
      reply_markup: phoneKeyboard,
    });
  }
  return sendShop({ chat_id: chatId, parse_mode: "HTML", text: welcome, reply_markup: shopButton() });
}

// Номер телефона (кнопка в боте или в мини-эппе). Отвечаем тем ботом, в который пришёл контакт.
async function shopContact(msg: any) {
  const chatId = msg.chat.id;
  const c = msg.contact;
  if (!c?.user_id || c.user_id !== msg.from?.id) {
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Нужен ваш собственный номер — нажмите кнопку «Поделиться номером».",
      reply_markup: phoneKeyboard,
    });
  }
  const existing = await ensureProfile(msg.from);
  if (existing.blocked) return sendShop({chat_id:chatId,text:"Доступ ограничен. Поддержка: @ramphelper"});
  if (!await subscriptionGate(msg.from.id, existing)) return;
  const phone = normPhone(c.phone_number);
  if (!isUzbekPhone(phone)) return sendShop({chat_id:chatId,text:"Регистрация доступна только с собственным номером Узбекистана: +998 и 9 цифр. Номер другой страны не подходит. После привязки узбекского номера к Telegram нажмите «Поделиться номером».",reply_markup:phoneKeyboard});
  const saved = await sb.from("profiles").update({ tg_phone:phone, phone_verified_at:new Date().toISOString(), ...(!existing.phone ? {phone}:{}), updated_at:new Date().toISOString() }).eq("telegram_id",msg.from.id);
  if (saved.error) throw new Error("phone save failed");
  await sendShop({ chat_id:chatId, parse_mode:"HTML", text:`✅ <b>Номер ${esc(phone)} подтверждён.</b>`,reply_markup:{remove_keyboard:true} });
  const p = await ensureProfile(msg.from);
  return tg("sendMessage", {
    chat_id: chatId,
    parse_mode:"HTML", text: `<b>Регистрация завершена!</b>\n\nВаш личный ID для заказов: <code>${p.delivery_id}</code>\n\nНажмите <b>RAMP</b>, чтобы открыть магазин.`,
    reply_markup: shopButton(),
  });
}

async function shopMessage(msg: any) {
  const chatId=msg.chat.id,text=msg.text ?? "";
  if(msg.contact)return shopContact(msg);
  if(/^\/start(?:@\w+)?(?:\s|$)/.test(text))return shopStart(msg);
  const p=await ensureProfile(msg.from);
  if(p.blocked)return sendShop({chat_id:chatId,text:"Доступ ограничен. Поддержка: @ramphelper"});
  if (!await subscriptionGate(msg.from.id, p)) return;
  if(!isUzbekPhone(p.tg_phone))return sendShop({chat_id:chatId,text:"Для продолжения поделитесь собственным номером Узбекистана (+998).",reply_markup:phoneKeyboard});
  if(text.startsWith("/myid"))return sendShop({chat_id:chatId,parse_mode:"HTML",text:`Ваш личный ID для заказов: <code>${p.delivery_id}</code>\n\nПриглашайте друзей по ссылке в разделе «Пригласить друга» в профиле.`});
  return sendShop({chat_id:chatId,text:`Каталог, поиск по фото и заказы — в магазине 👇\nПоддержка: @${SUPPORT_USERNAME}`,reply_markup:shopButton()});
}

/* ===================== Админский бот ===================== */

// Ответ админа свайпом на заказ / заявку / чек -> клиенту в клиентский бот
async function adminReply(msg: any) {
  const chatId = msg.chat.id;
  const say = (text: string) => tg("sendMessage", { chat_id: chatId, text }, "admin");
  const { data: link } = await sb.from("admin_messages").select("kind,ref_id")
    .eq("chat_id", chatId).eq("message_id", msg.reply_to_message.message_id).maybeSingle();
  if (!link) return say("Не нашёл заказ или заявку для этого сообщения.");

  if (link.kind === "photo") {
    const pr = await answerPhotoRequest(link.ref_id, msg.text ?? msg.caption ?? "Ответ ниже 👇");
    if (!pr) return say("Заявка не найдена.");
    if (!msg.text) await relayToClient(pr.telegram_id, msg);
    return say(`✅ Ответ по заявке №${pr.id} отправлен клиенту`);
  }

  const { data: order } = await sb.from("orders").select("id,telegram_id").eq("id", link.ref_id).maybeSingle();
  if (!order) return say("Заказ не найден.");
  await tg("sendMessage", { chat_id: order.telegram_id, text: `💬 Сообщение по заказу №${order.id}:` });
  const r = await relayToClient(order.telegram_id, msg);
  return say(r.ok ? `✅ Отправлено клиенту по заказу №${order.id}` : `❌ Не отправлено: ${r.description}`);
}

async function adminMessage(msg: any, single: boolean) {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const text: string = msg.text ?? "";

  if (!fromId || !(await isAdmin(fromId))) {
    if (single) return null; // один бот на всё — клиентская часть уже ответила
    const shop = await getBotUsername("shop");
    return tg("sendMessage", {
      chat_id: chatId,
      text: `Это служебный бот RAMP.${shop ? ` Магазин — @${shop}` : ""}`,
    }, "admin");
  }

  if (msg.contact) return tg("sendMessage", {chat_id:chatId,text:"Регистрация проходит только в основном боте @ramp_uzbot.",reply_markup:{remove_keyboard:true}},"admin");
  if (msg.reply_to_message) return adminReply(msg);

  if (text.startsWith("/admin") || (!single && text.startsWith("/start"))) {
    await tg("sendMessage",{chat_id:chatId,text:"Управление магазином RAMP",reply_markup:{remove_keyboard:true}},"admin");
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Панель управления RAMP 👇\n\nСюда приходят новые заказы, чеки и заявки по фото. " +
        "Ответьте на сообщение свайпом — ответ уйдёт клиенту.",
      reply_markup: adminButtons,
    }, "admin");
  }
  if (!single) return tg("sendMessage", { chat_id: chatId, text: "Откройте панель 👇", reply_markup: adminButtons }, "admin");
  return null;
}

async function adminCallback(cb: any) {
  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: cb.id, text }, "admin");
  if (!cb.from?.id || !(await isAdmin(cb.from.id))) return answer("Нет доступа");

  const rc = /^rc:(ok|no):(\d+)$/.exec(cb.data ?? "");
  if (rc) {
    const res = await reviewReceipt(Number(rc[2]), rc[1] === "ok");
    if (!res.ok) return answer(res.error!);
    if (cb.message) {
      await tg("editMessageReplyMarkup", {
        chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] },
      }, "admin");
    }
    return answer(rc[1] === "ok" ? `Заказ №${rc[2]}: оплата подтверждена` : `Заказ №${rc[2]}: чек отклонён, клиент уведомлён`);
  }

  const m = /^st:(\d+):(\w+)$/.exec(cb.data ?? "");
  if (!m || !STATUS[m[2]]) return answer("Неизвестная команда");
  const order = await setOrderStatus(Number(m[1]), m[2]);
  if (!order) return answer("Заказ не найден");
  return answer(`Заказ №${order.id}: ${STATUS[m[2]]}`);
}

/* ===================== Маршрутизация ===================== */

async function route(update: any, bot: BotKind) {
  if (update.callback_query) {
    const cb = update.callback_query;
    if (bot === "shop" && cb.data === "subscription:check") {
      if (!cb.from?.id || cb.message?.chat?.type !== "private" || cb.message.chat.id !== cb.from.id) return;
      const p = await ensureProfile(cb.from);
      if (p.blocked) return tg("answerCallbackQuery", { callback_query_id:cb.id, text:"Доступ ограничен", show_alert:true });
      const result = await verifySubscription(cb.from.id);
      await tg("answerCallbackQuery", {callback_query_id:cb.id, text:result.subscribed ? "Подписка подтверждена" : result.unavailable ? "Проверка недоступна. Напишите @ramphelper" : "Подписка пока не найдена. Вступите в канал и повторите проверку.", show_alert:!result.subscribed});
      if (result.subscribed) {
        await tg("editMessageReplyMarkup", {chat_id:cb.from.id,message_id:cb.message.message_id,reply_markup:{inline_keyboard:[]}});
        return shopStart({from:cb.from,chat:cb.message.chat,text:"/start"});
      }
      return;
    }
    if (bot !== "admin") return tg("answerCallbackQuery", {callback_query_id:update.callback_query.id,text:"Управление заказами — в админском боте"}, bot);
    return adminCallback(update.callback_query);
  }
  const msg = update.message;
  if (!msg?.from?.id || msg.chat?.type !== "private") return;
  return bot === "admin" ? adminMessage(msg,false) : shopMessage(msg);
}

export async function handler(req: Request) {
  if(req.method === "GET" && new URL(req.url).searchParams.get("health") === "1") {
    const config=await cfg();
    const username=config.shopToken ? await getBotUsername("shop") : null;
    return Response.json({service:"RAMP",registration_bot:"ramp_uzbot",registration_ready:!!config.shopToken && username==="ramp_uzbot",admin_configured:!!config.botToken,admin_username:config.botToken ? await getBotUsername("admin") : null,main_app:config.shopToken ? (await tg("getMe",{})).result?.has_main_web_app===true : false,channel:config.shopToken ? await channelStatus() : null});
  }
  if (req.method !== "POST") return new Response("Настройка ботов доступна только администраторам через панель", {status:405});
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  let bot: BotKind | null = null;
  for (const kind of ["shop","admin"] as BotKind[]) {
    if (await tokenOf(kind) && secret && safeEqual(secret,await webhookSecret(kind))) {bot=kind;break;}
  }
  if (!bot) return new Response("forbidden",{status:403});
  const update = await req.json().catch(() => null);
  if (!Number.isSafeInteger(update?.update_id)) return new Response("invalid update",{status:400});
  const claim = await sb.rpc("ramp_claim_update",{p_bot:bot,p_update_id:update.update_id});
  if (claim.error) return new Response("retry",{status:503});
  if (claim.data === "done") return new Response("ok");
  if (claim.data === "busy") return new Response("retry",{status:503});
  try {
    await route(update,bot);
    const result=await sb.from("bot_updates").update({processed:true}).eq("bot_kind",bot).eq("update_id",update.update_id);
    if (result.error) throw new Error("update acknowledgement failed");
    return new Response("ok");
  } catch {
    console.error("bot update failed",bot,update.update_id);
    await sb.from("bot_updates").update({claimed_at:"2000-01-01T00:00:00Z"}).eq("bot_kind",bot).eq("update_id",update.update_id);
    return new Response("retry",{status:500});
  }
}
Deno.serve(handler);
