// API мини-эппа: каждый запрос подписан Telegram (initData), иначе отказ.
import {
  applyReferral, cfg, esc, fmt, getBotUsername, isAdmin, notifyAdmins, receiptKeyboard, sb, statusKeyboard,
  shopButton, SUPPORT_USERNAME, tg, type TgUser, verifyInitData,
} from "../_shared/common.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-init-data, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const int = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, "bad number");
  return n;
};

function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) {
    console.error(res.error);
    throw new HttpError(500, "db error");
  }
  return res.data;
}

const PRODUCT_COLS = "id,name,category,price,photo,description,active,in_stock";
const PROFILE_COLS =
  "telegram_id,public_id,first_name,last_name,username,full_name,phone,tg_phone,city,address," +
  "referred_by,ref_rewarded,catalog_view,user_no,created_at";

async function getProfile(uid: number) {
  return check(await sb.from("profiles").select(PROFILE_COLS).eq("telegram_id", uid).single()) as any;
}

async function listCart(uid: number) {
  const rows = check(await sb.from("cart_items")
    .select(`qty, product:products(${PRODUCT_COLS})`)
    .eq("telegram_id", uid)
    .order("created_at")) as any[];
  return rows.filter((r) => r.product?.active)
    .map((r) => ({ qty: r.qty, product: r.product }));
}

async function listWish(uid: number) {
  const rows = check(await sb.from("wishlist")
    .select(`product:products(${PRODUCT_COLS})`)
    .eq("telegram_id", uid)
    .order("created_at", { ascending: false })) as any[];
  return rows.filter((r) => r.product).map((r) => r.product);
}

async function listOrders(uid: number) {
  return check(await sb.from("orders")
    .select("id,items,subtotal,discount_pct,discount_amount,discount_reason,total,status,payment_method," +
      "full_name,phone,address,comment,pay_card,receipt_at,reject_reason,created_at")
    .eq("telegram_id", uid)
    .order("created_at", { ascending: false })
    .limit(50));
}

async function listPhotoRequests(uid: number) {
  const rows = check(await sb.from("photo_requests")
    .select("id,photo_path,comment,status,answer,created_at,answered_at")
    .eq("telegram_id", uid)
    .order("created_at", { ascending: false })
    .limit(30)) as any[];
  if (!rows.length) return [];
  const { data: urls } = await sb.storage.from("requests")
    .createSignedUrls(rows.map((r) => r.photo_path), 3600);
  return rows.map((r, i) => ({ ...r, photo_url: urls?.[i]?.signedUrl ?? null }));
}

const COUPON_LABEL: Record<string, string> = {
  ref_inviter: "Купон за приглашённого друга",
  ref_invitee: "Купон за заказ по приглашению",
  manual: "Персональный купон",
};

// Скидки пользователя: приветственная, купоны, приглашения — всё для профиля
async function promo(uid: number, profile: any) {
  const PROMO = (await cfg()).promo;
  const [coupons, liveOrders, invited] = await Promise.all([
    sb.from("coupons").select("id,pct,reason,created_at").eq("telegram_id", uid)
      .is("used_order_id", null).order("pct", { ascending: false }),
    sb.from("orders").select("id", { count: "exact", head: true })
      .eq("telegram_id", uid).neq("status", "cancelled"),
    sb.from("profiles").select("telegram_id", { count: "exact", head: true }).eq("referred_by", uid),
  ]);
  const welcomeUntil = new Date(new Date(profile.created_at).getTime() + PROMO.welcomeDays * 86400_000);
  const welcomeActive = Date.now() < welcomeUntil.getTime();
  const list = (coupons.data ?? []).map((c: any) => ({ ...c, label: COUPON_LABEL[c.reason] ?? "Купон" }));
  const best = list[0];
  const current = best && best.pct > (welcomeActive ? PROMO.welcomePct : 0)
    ? { pct: best.pct, reason: best.label, coupon_id: best.id }
    : welcomeActive ? { pct: PROMO.welcomePct, reason: "Приветственная скидка", coupon_id: null } : null;
  const username = await getBotUsername();
  return {
    current,
    welcome: { active: welcomeActive, pct: PROMO.welcomePct, until: welcomeUntil.toISOString() },
    coupons: list,
    invited: invited.count ?? 0,
    ref_link: username ? `https://t.me/${username}?start=ref_${profile.public_id}` : null,
    can_enter_ref: !profile.referred_by && (liveOrders.count ?? 0) === 0,
    referred: !!profile.referred_by,
    ref_rewarded: !!profile.ref_rewarded,
    rules: PROMO,
  };
}

// Расчёт суммы заказа: применяется одна, самая большая скидка
async function quote(uid: number) {
  const profile = await getProfile(uid);
  const cart = (await listCart(uid)).filter((c) => c.product.in_stock);
  const pr = await promo(uid, profile);

  const subtotal = cart.reduce((s, c) => s + c.product.price * c.qty, 0);
  const pct = pr.current?.pct ?? 0;
  const discount_amount = Math.round(subtotal * pct / 100);
  return {
    cart, profile, promo: pr,
    quote: {
      subtotal, discount_pct: pct, discount_amount,
      discount_reason: pr.current?.reason ?? null,
      coupon_id: pr.current?.coupon_id ?? null,
      total: subtotal - discount_amount,
    },
  };
}

async function handle(action: string, body: any, user: TgUser) {
  const uid = user.id;
  const PAYMENTS = (await cfg()).payments;

  switch (action) {
    case "me": {
      check(await sb.from("profiles").upsert({
        telegram_id: uid,
        first_name: user.first_name ?? null,
        last_name: user.last_name ?? null,
        username: user.username ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "telegram_id" }));
      const profile = await getProfile(uid);
      const [cart, wish, pr] = await Promise.all([listCart(uid), listWish(uid), promo(uid, profile)]);
      return {
        profile, cart, wish, promo: pr, payments: PAYMENTS, is_admin: await isAdmin(uid), support: SUPPORT_USERNAME,
      };
    }

    case "saveProfile": {
      const patch = {
        full_name: str(body.full_name, 120),
        phone: str(body.phone, 30),
        city: str(body.city, 60),
        address: str(body.address, 300),
        updated_at: new Date().toISOString(),
      };
      check(await sb.from("profiles").update(patch).eq("telegram_id", uid));
      return { profile: await getProfile(uid) };
    }

    case "setPrefs": {
      const view = body.catalog_view === "list" ? "list" : "grid";
      check(await sb.from("profiles").update({ catalog_view: view }).eq("telegram_id", uid));
      return { ok: true };
    }

    case "applyRef": {
      const res = await applyReferral(uid, str(body.code, 20));
      if (!res.ok) throw new HttpError(400, res.error!);
      const profile = await getProfile(uid);
      return { profile, promo: await promo(uid, profile) };
    }

    case "cart":
      return { cart: await listCart(uid) };

    case "cartSet": {
      const productId = int(body.product_id);
      const qty = Math.min(99, Math.max(0, int(body.qty)));
      if (qty === 0) {
        check(await sb.from("cart_items").delete().eq("telegram_id", uid).eq("product_id", productId));
      } else {
        const p = check(await sb.from("products").select("active,in_stock").eq("id", productId).maybeSingle()) as any;
        if (!p?.active) throw new HttpError(404, "Товар не найден");
        if (!p.in_stock) throw new HttpError(409, "Товара нет в наличии");
        check(await sb.from("cart_items").upsert(
          { telegram_id: uid, product_id: productId, qty },
          { onConflict: "telegram_id,product_id" },
        ));
      }
      return { cart: await listCart(uid) };
    }

    case "wishToggle": {
      const productId = int(body.product_id);
      const existing = check(await sb.from("wishlist").select("product_id")
        .eq("telegram_id", uid).eq("product_id", productId).maybeSingle());
      if (existing) {
        check(await sb.from("wishlist").delete().eq("telegram_id", uid).eq("product_id", productId));
      } else {
        const p = check(await sb.from("products").select("active").eq("id", productId).maybeSingle()) as any;
        if (!p?.active) throw new HttpError(404, "Товар не найден");
        check(await sb.from("wishlist").insert({ telegram_id: uid, product_id: productId }));
      }
      return { wish: await listWish(uid) };
    }

    case "wishlist":
      return { wish: await listWish(uid) };

    case "quote": {
      const q = await quote(uid);
      return { quote: q.quote };
    }

    case "checkout": {
      // Данные получателя обязательны: на них оформляется посылка
      const full_name = str(body.full_name, 120).replace(/\s+/g, " ");
      const phone = str(body.phone, 30);
      const city = str(body.city, 60);
      const street = str(body.address, 300);
      const comment = str(body.comment, 500);
      const payment_method = String(body.payment_method ?? "");
      if (full_name.split(" ").length < 2) throw new HttpError(400, "Укажите имя и фамилию получателя полностью");
      if (phone.replace(/\D/g, "").length < 9) throw new HttpError(400, "Укажите телефон получателя");
      if (!city) throw new HttpError(400, "Укажите город получателя");
      if (street.length < 5) throw new HttpError(400, "Укажите адрес получателя: улица, дом, квартира");
      const address = `${city}, ${street}`;
      if (!PAYMENTS[payment_method]) throw new HttpError(400, "Выберите способ оплаты");

      const { cart, profile, quote: q } = await quote(uid);
      if (!profile.tg_phone) {
        throw new HttpError(403, "Подтвердите номер телефона, чтобы оформить заказ", "need_phone");
      }
      if (!cart.length) throw new HttpError(400, "Корзина пуста");

      // Цены берём из базы, а не из запроса клиента
      const items = cart.map((c) => ({
        product_id: c.product.id,
        name: c.product.name,
        price: c.product.price,
        qty: c.qty,
        photo: c.product.photo,
      }));

      const cards = (await cfg()).cards;
      const pay_card = cards[Math.floor(Math.random() * cards.length)];

      const ins = await sb.from("orders").insert({
        telegram_id: uid, items, comment: comment || null, full_name, phone, address, payment_method, pay_card,
        subtotal: q.subtotal, discount_pct: q.discount_pct, discount_amount: q.discount_amount,
        discount_reason: q.discount_reason, coupon_id: q.coupon_id, total: q.total,
      }).select().single();
      if (ins.error) {
        console.error(ins.error);
        throw new HttpError(500, "Не удалось создать заказ");
      }
      const order = ins.data as any;

      // Купон одноразовый: занимаем его атомарно. Если его уже использовали — отменяем заказ.
      if (q.coupon_id) {
        const { data: took } = await sb.from("coupons")
          .update({ used_order_id: order.id, used_at: new Date().toISOString() })
          .eq("id", q.coupon_id).is("used_order_id", null).select("id");
        if (!took?.length) {
          await sb.from("orders").delete().eq("id", order.id);
          throw new HttpError(409, "Купон уже использован, проверьте сумму и оформите заново");
        }
      }

      check(await sb.from("cart_items").delete().eq("telegram_id", uid));
      check(await sb.from("profiles").update({ full_name, phone, city, address: street }).eq("telegram_id", uid));

      const lines = items.map((i) => `• ${esc(i.name)} × ${i.qty} — ${fmt(i.price * i.qty)}`).join("\n");
      const who = user.username ? `@${esc(user.username)}` : `id ${uid}`;
      const money = [
        `Товары: ${fmt(q.subtotal)}`,
        q.discount_amount ? `${esc(q.discount_reason)} (${q.discount_pct}%): −${fmt(q.discount_amount)}` : "",
      ].filter(Boolean).join("\n");
      await notifyAdmins("order", order.id, "sendMessage", {
        parse_mode: "HTML",
        text: `🛒 <b>Новый заказ №${order.id}</b>\n\n${lines}\n\n${money}\n<b>К оплате: ${fmt(q.total)}</b>\n` +
          `💳 ${esc(PAYMENTS[payment_method])} · карта клиенту: ${esc(pay_card)}\n` +
          `Ждём чек об оплате от клиента.\n\n` +
          `👤 Клиент №${profile.user_no} · ${esc(full_name)} (${who}, ${esc(profile.public_id)})\n📞 ${esc(phone)}` +
          (profile.tg_phone && profile.tg_phone !== phone ? ` · Telegram: ${esc(profile.tg_phone)}` : "") +
          `\n📍 ${esc(address)}` +
          (comment ? `\n💬 ${esc(comment)}` : "") +
          `\n\nКнопки ниже меняют статус. Ответ на это сообщение уйдёт клиенту.`,
        reply_markup: statusKeyboard(order.id),
      });
      await tg("sendMessage", {
        chat_id: uid,
        parse_mode: "HTML",
        text: `🛒 Заказ №${order.id} оформлен!\n\nК оплате: <b>${fmt(q.total)}</b>\n` +
          `Переведите сумму на карту:\n<code>${esc(pay_card)}</code>\n\n` +
          `После оплаты отправьте скриншот чека в магазине: «Заказы» → заказ №${order.id} → «Отправить чек». ` +
          `Мы проверим оплату и подтвердим заказ.\n\nВопросы: @${SUPPORT_USERNAME}`,
        reply_markup: shopButton("Отправить чек"),
      });

      const fresh = await getProfile(uid);
      return { order, orders: await listOrders(uid), profile: fresh, promo: await promo(uid, fresh) };
    }

    case "orders":
      return { orders: await listOrders(uid) };

    case "uploadReceipt": {
      const orderId = int(body.order_id);
      const { data: o } = await sb.from("orders").select("id,telegram_id,status,total,pay_card")
        .eq("id", orderId).eq("telegram_id", uid).maybeSingle();
      if (!o) throw new HttpError(404, "Заказ не найден");
      if (!["new", "review"].includes(o.status)) throw new HttpError(409, "Этот заказ уже оплачен");
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(body.image ?? ""));
      if (!m) throw new HttpError(400, "Нужен скриншот или фото чека");
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      if (bytes.length > 5 * 1024 * 1024) throw new HttpError(413, "Фото слишком большое");
      const path = `receipts/${uid}/${orderId}-${crypto.randomUUID()}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
      const up = await sb.storage.from("requests").upload(path, bytes, { contentType: `image/${m[1]}` });
      if (up.error) {
        console.error(up.error);
        throw new HttpError(500, "Не удалось загрузить чек");
      }
      check(await sb.from("orders").update({
        status: "review", receipt_path: path, receipt_at: new Date().toISOString(), reject_reason: null,
        updated_at: new Date().toISOString(),
      }).eq("id", orderId));

      const profile = await getProfile(uid);
      const { data: signed } = await sb.storage.from("requests").createSignedUrl(path, 86400);
      await notifyAdmins("receipt", orderId, "sendPhoto", {
        photo: signed?.signedUrl,
        parse_mode: "HTML",
        caption: `🧾 <b>Чек по заказу №${orderId}</b>\nКлиент №${profile.user_no} · ${esc(profile.full_name || profile.first_name || "")}\n` +
          `Сумма к оплате: <b>${fmt(o.total)}</b>\nКарта: ${esc(o.pay_card || "—")}\n\nПроверьте поступление и нажмите кнопку.`,
        reply_markup: receiptKeyboard(orderId),
      });
      return { orders: await listOrders(uid) };
    }

    case "photoRequest": {
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(body.image ?? ""));
      if (!m) throw new HttpError(400, "Нужна картинка JPG, PNG или WEBP");
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      if (bytes.length > 5 * 1024 * 1024) throw new HttpError(413, "Фото слишком большое");

      const { count } = await sb.from("photo_requests").select("id", { count: "exact", head: true })
        .eq("telegram_id", uid).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
      if ((count ?? 0) >= 15) throw new HttpError(429, "Слишком много заявок, попробуйте позже");

      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const path = `${uid}/${crypto.randomUUID()}.${ext}`;
      const up = await sb.storage.from("requests").upload(path, bytes, { contentType: `image/${m[1]}` });
      if (up.error) {
        console.error(up.error);
        throw new HttpError(500, "Не удалось сохранить фото");
      }
      const comment = str(body.comment, 500);
      const req = check(await sb.from("photo_requests").insert({
        telegram_id: uid, photo_path: path, comment: comment || null,
      }).select().single()) as any;

      const { data: signed } = await sb.storage.from("requests").createSignedUrl(path, 86400);
      const who = user.username ? `@${esc(user.username)}` : esc(user.first_name ?? `id ${uid}`);
      await notifyAdmins("photo", req.id, "sendPhoto", {
        photo: signed?.signedUrl,
        parse_mode: "HTML",
        caption: `📷 <b>Заявка по фото №${req.id}</b> от ${who}` +
          (comment ? `\n💬 ${esc(comment)}` : "") +
          `\n\n↩️ Ответьте на это сообщение — ответ уйдёт клиенту.`,
      });
      return { requests: await listPhotoRequests(uid) };
    }

    case "photoRequests":
      return { requests: await listPhotoRequests(uid) };

    default:
      throw new HttpError(400, "unknown action");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const user = await verifyInitData(req.headers.get("x-init-data") ?? "");
  if (!user) return json({ error: "Не удалось подтвердить вход. Закройте магазин и откройте его кнопкой «Открыть RAMP» в боте." }, 401);

  const { data: p } = await sb.from("profiles").select("blocked").eq("telegram_id", user.id).maybeSingle();
  if (p?.blocked) return json({ error: "Доступ к магазину ограничен. Напишите в поддержку." }, 403);

  try {
    const body = await req.json().catch(() => ({}));
    return json(await handle(String(body.action ?? ""), body, user));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: "Ошибка сервера" }, 500);
  }
});
