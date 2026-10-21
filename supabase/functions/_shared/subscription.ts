import { sb, tg } from "./common.ts";

export const CHANNEL_USERNAME = "ramp_uz";
export const CHANNEL_URL = `https://t.me/${CHANNEL_USERNAME}`;
export const hasSubscription = (p: any) => !!p?.subscription_verified_at && p.subscription_channel === CHANNEL_USERNAME;
export const isChannelMember = (m: any) => ["creator", "administrator", "member"].includes(m?.status) || (m?.status === "restricted" && m.is_member === true);
let readiness: { at: number; ready: boolean } | null = null;

export async function channelStatus() {
  if (readiness && Date.now() - readiness.at < 20_000) return { ready: readiness.ready, username: CHANNEL_USERNAME, url: CHANNEL_URL };
  const me = await tg("getMe", {});
  const member = me.ok ? await tg("getChatMember", { chat_id: `@${CHANNEL_USERNAME}`, user_id: me.result.id }) : null;
  const ready = !!member?.ok && ["creator", "administrator"].includes(member.result?.status);
  readiness = { at: Date.now(), ready };
  return { ready, username: CHANNEL_USERNAME, url: CHANNEL_URL };
}

// Проверяем именно Telegram ID из подписанного запроса / вебхука. Заявка на вступление ещё не подписка.
export async function verifySubscription(uid: number) {
  const status = await channelStatus();
  if (!status.ready) return { ...status, subscribed: false, unavailable: true };
  const result = await tg("getChatMember", { chat_id: `@${CHANNEL_USERNAME}`, user_id: uid });
  if (!result.ok) return { ...status, subscribed: false, unavailable: true };
  const subscribed = isChannelMember(result.result);
  const saved = await sb.from("profiles").update({
    subscription_verified_at: subscribed ? new Date().toISOString() : null,
    subscription_channel: subscribed ? CHANNEL_USERNAME : null,
  }).eq("telegram_id", uid);
  if (saved.error) throw new Error("Не удалось сохранить проверку подписки");
  return { ...status, subscribed, unavailable: false };
}

export const subscriptionKeyboard = () => ({ inline_keyboard: [
  [{ text: "📢 Подписаться на канал", url: CHANNEL_URL, style: "primary" }],
  [{ text: "✅ Проверить подписку", callback_data: "subscription:check", style: "success" }],
] });
export const subscriptionText = (unavailable = false) =>
  `<b>📢 Подпишитесь на наш канал</b>\n\nЧтобы зарегистрироваться в <b>RAMP</b>, подпишитесь на канал <b>@${CHANNEL_USERNAME}</b>.\n\n` +
  `После подписки нажмите <b>«Проверить подписку»</b>. Следующий шаг — подтверждение собственного номера <b>Узбекистана (+998)</b>.` +
  (unavailable ? "\n\n<b>Проверка временно недоступна.</b> Попробуйте позже или напишите @ramphelper." : "");
