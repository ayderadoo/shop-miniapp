// API мини-эппа: каждый запрос подписан Telegram (initData), иначе отказ.
import {
  applyReferral, bestEffort, cfg, esc, fmt, getBotUsername, isAdmin, notifyAdmins, receiptKeyboard, sb, statusKeyboard,
  shopButton, SUPPORT_USERNAME, tg, type TgUser, verifyInitData, getReferralLink,
} from "../_shared/common.ts";
import { pickVariant, isUzbekPhone } from "../_shared/validation.ts";

import { customerContent, ContentError, legalDocument } from "../_shared/content.ts";
import { CHANNEL_USERNAME, CHANNEL_URL, hasSubscription, verifySubscription } from "../_shared/subscription.ts";

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
  if (!Number.isSafeInteger(n)) throw new HttpError(400, "bad number");
  return n;
};

function check<T>(res: { data: T; error: unknown }): T {
  if (res.error) {
    console.error(res.error);
    throw new HttpError(500, "db error");
  }
  return res.data;
}

const PRODUCT_COLS = "id,name,category,price,photo,photos,description,active,in_stock,options,specs,sku,composition,care,delivery_min_days,delivery_max_days,delivery_note,related_ids,created_at";
const PROFILE_COLS =
  "telegram_id,first_name,last_name,username,full_name,phone,tg_phone,city,address," +
  "referred_by,ref_rewarded,catalog_view,user_no,delivery_id,phone_verified_at,subscription_verified_at,subscription_channel,created_at";

async function getProfile(uid: number) {
  const profile=check(await sb.from("profiles").select(PROFILE_COLS).eq("telegram_id",uid).single()) as any;
  return {...profile,phone_verified:isUzbekPhone(profile.tg_phone),subscription_verified:hasSubscription(profile)};
}

async function listCart(uid: number) {
  const rows = check(await sb.from("cart_items")
    .select(`qty, opts, variant, product:products(${PRODUCT_COLS})`)
    .eq("telegram_id", uid)
    .order("created_at")) as any[];
  return rows.filter((r) => r.product?.active).map((r) => {
    const v = pickVariant(r.product, r.opts);
    // Если админ поменял параметры товара и выбранного варианта больше нет — позиция не войдёт в заказ
    const valid = v.ok && v.variant === r.variant;
    return {
      qty: r.qty, opts: r.opts, variant: r.variant, product: r.product,
      unit_price: v.ok ? v.price : r.product.price,
      available: !!r.product.in_stock && valid,
      note: !r.product.in_stock ? "Нет в наличии — не войдёт в заказ" : valid ? null : "Параметры товара изменились — выберите заново",
    };
  });
}

async function listWish(uid: number) {
  const rows = check(await sb.from("wishlist")
    .select(`product:products(${PRODUCT_COLS})`)
    .eq("telegram_id", uid)
    .order("created_at", { ascending: false })) as any[];
  return rows.filter((r) => r.product?.active).map((r) => r.product);
}

async function listOrders(uid: number) {
  return check(await sb.from("orders")
    .select("id,items,subtotal,discount_pct,discount_amount,discount_reason,total,status,payment_method," +
      "full_name,phone,address,comment,pay_card,receipt_at,reject_reason,delivery_id,tracking_number,delivery_note,created_at")
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
  for(const result of [coupons,liveOrders,invited])if(result.error)throw new HttpError(500,"Не удалось рассчитать скидку");
  const welcomeUntil = new Date(new Date(profile.created_at).getTime() + PROMO.welcomeDays * 86400_000);
  const welcomeActive = Date.now() < welcomeUntil.getTime();
  const list = (coupons.data ?? []).map((c: any) => ({ ...c, label: COUPON_LABEL[c.reason] ?? "Купон" }));
  const best = list[0];
  const current = best && best.pct > (welcomeActive ? PROMO.welcomePct : 0)
    ? { pct: best.pct, reason: best.label, coupon_id: best.id }
    : welcomeActive ? { pct: PROMO.welcomePct, reason: "Приветственная скидка", coupon_id: null } : null;
  const refLink = await getReferralLink(uid);
  return {
    current,
    welcome: { active: welcomeActive, pct: PROMO.welcomePct, until: welcomeUntil.toISOString() },
    coupons: list,
    invited: invited.count ?? 0,
    ref_link: refLink,
    can_enter_ref: !profile.referred_by && (liveOrders.count ?? 0) === 0,
    referred: !!profile.referred_by,
    ref_rewarded: !!profile.ref_rewarded,
    rules: PROMO,
  };
}

// Расчёт суммы заказа: применяется одна, самая большая скидка
async function quote(uid: number) {
  const profile = await getProfile(uid);
  const cart = (await listCart(uid)).filter((c) => c.available);
  const pr = await promo(uid, profile);

  const subtotal = cart.reduce((s, c) => s + c.unit_price * c.qty, 0);
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
  if(action==="checkSubscription") {
    const result=await verifySubscription(uid);
    if(result.unavailable)throw new HttpError(503,"Проверка подписки временно недоступна. Попробуйте позже или напишите @ramphelper","subscription_unavailable");
    return {subscribed:result.subscribed,channel:{username:CHANNEL_USERNAME,url:CHANNEL_URL},profile:await getProfile(uid)};
  }
  if (!["me","setPrefs"].includes(action) && !hasSubscription(await getProfile(uid))) {
    throw new HttpError(403,"Подпишитесь на @ramp_uz и подтвердите подписку в основном боте","need_subscription");
  }
  if (!["me", "setPrefs"].includes(action) && !isUzbekPhone((await getProfile(uid)).tg_phone)) {
    throw new HttpError(403, "Подтвердите собственный номер Узбекистана (+998) в @ramp_uzbot", "need_phone");
  }

  const contentResult=await customerContent(action,body,user);
  if(contentResult!==undefined)return contentResult;

  switch (action) {
    case "catalogInfo":
      return { ranking: check(await sb.rpc("ramp_catalog_ranking")) };
    case "me": {
      // Без upsert: номера клиентов (user_no) идут подряд, без пропусков
      const names = { first_name: user.first_name ?? null, last_name: user.last_name ?? null, username: user.username ?? null };
      const exists = check(await sb.from("profiles").select("telegram_id").eq("telegram_id", uid).maybeSingle());
      if (exists) check(await sb.from("profiles").update({ ...names, updated_at: new Date().toISOString() }).eq("telegram_id", uid));
      else {
        const ins = await sb.from("profiles").insert({ telegram_id: uid, ...names });
        if (ins.error && ins.error.code !== "23505") check(ins);
      }
      const profile = await getProfile(uid);
      const [cart, wish, pr] = await Promise.all([listCart(uid), listWish(uid), promo(uid, profile)]);
      return {
        profile, cart, wish, promo: pr, payments: PAYMENTS, is_admin: await isAdmin(uid), support: SUPPORT_USERNAME,
        channel:{username:CHANNEL_USERNAME,url:CHANNEL_URL,required:!hasSubscription(profile)},
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
      const res = await applyReferral(uid, str(body.code, 32));
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
        // Удаление конкретного варианта (variant — подпись из корзины)
        check(await sb.from("cart_items").delete().eq("telegram_id", uid).eq("product_id", productId)
          .eq("variant", str(body.variant, 500)));
      } else {
        const p = check(await sb.from("products").select("price,active,in_stock,options").eq("id", productId).maybeSingle()) as any;
        if (!p?.active) throw new HttpError(404, "Товар не найден");
        if (!p.in_stock) throw new HttpError(409, "Товара нет в наличии");
        const v = pickVariant(p, body.opts);
        if (!v.ok) throw new HttpError(400, v.error);
        check(await sb.from("cart_items").upsert(
          { telegram_id: uid, product_id: productId, qty, opts: v.opts, variant: v.variant },
          { onConflict: "telegram_id,product_id,variant" },
        ));
      }
      return { cart: await listCart(uid) };
    }

    case "wishSet": {
      const productId=int(body.product_id);
      if(typeof body.wished!=="boolean")throw new HttpError(400,"Укажите действие с избранным");
      if(body.wished) {
        const product=check(await sb.from("products").select("active").eq("id",productId).maybeSingle()) as any;
        if(!product?.active)throw new HttpError(404,"Товар не найден");
        check(await sb.from("wishlist").upsert({telegram_id:uid,product_id:productId},{onConflict:"telegram_id,product_id",ignoreDuplicates:true}));
      } else check(await sb.from("wishlist").delete().eq("telegram_id",uid).eq("product_id",productId));
      return {product_id:productId,wished:body.wished};
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
      const requestId=body.request_id || crypto.randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requestId))) {
        throw new HttpError(400, "Обновите магазин и попробуйте оформить заказ ещё раз");
      }
      const details = { full_name: str(body.full_name,120), phone: str(body.phone,30), city: str(body.city,60),
        address: str(body.address,300), comment: str(body.comment,500), payment_method: str(body.payment_method,20) };
      const { data, error } = await sb.rpc("ramp_create_order", { p_uid: uid, p_request_id: requestId, p_details: details });
      if (error) throw new HttpError(error.code === "P0001" ? 400 : 500, error.code === "P0001" ? error.message : "Не удалось создать заказ");
      const order = data.order;
      const profile = await getProfile(uid);
      if (data.created) {
        const lines = order.items.slice(0,15).map((i: any) => `• ${esc(i.sku || "Без артикула")} · ${esc(i.name)}${i.variant ? ` (${esc(i.variant)})` : ""} × ${i.qty}`).join("\n");
        await bestEffort(() => notifyAdmins("order", order.id, "sendMessage", {
          parse_mode: "HTML",
          text: `🛒 <b>Заказ №${order.id}</b> · Личный ID: ${esc(profile.delivery_id)}\n\n${lines}\n\n` +
            `К оплате: <b>${fmt(order.total)}</b> (скидка ${order.discount_pct}%)\n` +
            `👤 ${esc(order.full_name)}\n📞 ${esc(order.phone)}\n📍 ${esc(order.address)}\n` +
            `💳 Карта: ${esc(order.pay_card)}\nПолный состав заказа — в панели.`,
          reply_markup: statusKeyboard(order.id),
        }));
        await bestEffort(() => tg("sendMessage", {
          chat_id: uid, parse_mode: "HTML",
          text: `🛒 Заказ №${order.id} оформлен!\n\nК оплате: <b>${fmt(order.total)}</b>\n` +
            `Переведите сумму на карту:\n<code>${esc(order.pay_card)}</code>\n\n` +
            `Затем откройте «Заказы» → №${order.id} → «Отправить чек».\nВопросы: @${SUPPORT_USERNAME}`,
          reply_markup: shopButton("Отправить чек", "orders"),
        }));
      }
      return { order, cart: await listCart(uid), orders: await listOrders(uid), profile, promo: await promo(uid,profile) };
    }

    case "orders":
      return { orders: await listOrders(uid) };

    case "uploadReceipt": {
      const orderId = int(body.order_id);
      const { data: o } = await sb.from("orders").select("id,telegram_id,status,total,pay_card")
        .eq("id", orderId).eq("telegram_id", uid).maybeSingle();
      if (!o) throw new HttpError(404, "Заказ не найден");
      if (o.status !== "new") throw new HttpError(409, "Этот заказ уже оплачен");
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
      const saved = await sb.from("orders").update({
        status: "review", receipt_path: path, receipt_at: new Date().toISOString(), reject_reason: null,
        updated_at: new Date().toISOString(),
      }).eq("id", orderId).eq("status", "new").select("id");
      if (saved.error || !saved.data?.length) {
        await sb.storage.from("requests").remove([path]);
        throw new HttpError(409, "Заказ уже изменился. Обновите список");
      }

      const profile = await getProfile(uid);
      const { data: signed } = await sb.storage.from("requests").createSignedUrl(path, 86400);
      await bestEffort(() => notifyAdmins("receipt", orderId, "sendPhoto", {
        photo: signed?.signedUrl,
        parse_mode: "HTML",
        caption: `🧾 <b>Чек по заказу №${orderId}</b>\nКлиент №${profile.user_no} · ${esc(profile.full_name || profile.first_name || "")}\n` +
          `Сумма к оплате: <b>${fmt(o.total)}</b>\nКарта: ${esc(o.pay_card || "—")}\n\nПроверьте поступление и нажмите кнопку.`,
        reply_markup: receiptKeyboard(orderId),
      }));
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
      await bestEffort(() => notifyAdmins("photo", req.id, "sendPhoto", {
        photo: signed?.signedUrl,
        parse_mode: "HTML",
        caption: `📷 <b>Заявка по фото №${req.id}</b> от ${who}` +
          (comment ? `\n💬 ${esc(comment)}` : "") +
          `\n\n↩️ Ответьте на это сообщение — ответ уйдёт клиенту.`,
      }));
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

  const body = (await req.json().catch(() => ({}))) ?? {};
  if (body.action==="legal") {
    try { return json(await legalDocument(body.slug)); }
    catch(e) {return json({error:e instanceof ContentError?e.message:"Не удалось загрузить документ"},e instanceof ContentError?e.status:500);}
  }
  const user = await verifyInitData(req.headers.get("x-init-data") ?? "");
  if (!user) return json({ error: "Не удалось подтвердить вход. Закройте магазин и откройте его кнопкой «Открыть RAMP» в боте." }, 401);

  const { data: p } = await sb.from("profiles").select("blocked").eq("telegram_id", user.id).maybeSingle();
  if (p?.blocked) return json({ error: "Доступ к магазину ограничен. Напишите в поддержку." }, 403);

  try {
    return json(await handle(String(body.action ?? ""), body, user));
  } catch (e) {
    if(e instanceof ContentError)return json({error:e.message},e.status);
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: "Ошибка сервера" }, 500);
  }
});

