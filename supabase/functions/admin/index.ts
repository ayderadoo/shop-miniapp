// API админ-панели. Доступ только для Telegram ID из таблицы admins.
import {
  answerPhotoRequest, botStatus, cfg, DEFAULT_PROMO, PAID_OR_LATER, resetCfg, reviewReceipt, sb, setOrderStatus, shopButton,
  STATUS, tg, setupBots, SHOP_USERNAME, type TgUser, verifyInitData,
} from "../_shared/common.ts";
import { normalizeOptions, normalizeSku } from "../_shared/validation.ts";
import { catalogFields } from "../_shared/catalog.ts";

import { adminContent, ContentError } from "../_shared/content.ts";
import { channelStatus } from "../_shared/subscription.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-init-data, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function check<T>(res: { data: T; error: any }): T {
  if (res.error) {
    console.error(res.error);
    throw new HttpError(500, "Ошибка базы данных");
  }
  return res.data;
}
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const int = (v: unknown, name = "число") => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `Неверное значение: ${name}`);
  return n;
};
// Поиск по тексту без спецсимволов PostgREST
const safeSearch = (q: unknown) => str(q,60).replace(/[,()*%\\'\"]/g," ").trim();

const ORDER_COLS = "id,telegram_id,items,subtotal,discount_pct,discount_amount,discount_reason,total,status," +
  "payment_method,full_name,phone,address,comment,pay_card,receipt_path,receipt_at,reject_reason,delivery_id,tracking_number,delivery_note,created_at,updated_at";
const PROFILE_COLS = "telegram_id,first_name,last_name,username,full_name,phone,tg_phone,city," +
  "address,referred_by,ref_rewarded,note,blocked,user_no,delivery_id,phone_verified_at,created_at";

async function uploadImage(dataUrl: string, folder: string) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, "Нужна картинка JPG, PNG или WEBP");
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bytes.length > 5 * 1024 * 1024) throw new HttpError(413, "Фото больше 5 МБ");
  const path = `${folder}/${crypto.randomUUID()}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  const up = await sb.storage.from("products").upload(path, bytes, { contentType: `image/${m[1]}` });
  if (up.error) throw new HttpError(500, "Не удалось загрузить фото");
  return sb.storage.from("products").getPublicUrl(path).data.publicUrl;
}

// Фото удалённого товара стираются из хранилища, если их не используют другие товары и старые заказы.
async function removeUnusedPhotos(urls: string[]) {
  const prefix = sb.storage.from("products").getPublicUrl("").data.publicUrl;
  const paths: string[] = [];
  for (const url of urls) {
    if (!url.startsWith(prefix)) continue;
    const path = decodeURIComponent(url.slice(prefix.length).split("?")[0]);
    const [cover, gallery, orders] = await Promise.all([
      sb.from("products").select("id", { count: "exact", head: true }).eq("photo", url),
      sb.from("products").select("id", { count: "exact", head: true }).filter("photos", "cs", JSON.stringify([url])),
      sb.from("orders").select("id", { count: "exact", head: true }).like("search_items", `%${path}%`),
    ]);
    if (cover.error || gallery.error || orders.error) continue;
    if (!cover.count && !gallery.count && !orders.count) paths.push(path);
  }
  if (!paths.length) return;
  const removed = await sb.storage.from("products").remove(paths);
  if (removed.error) console.error("product photo cleanup failed", removed.error);
}

async function handle(action: string, b: any, me: TgUser) {
  const contentResult=await adminContent(action,b,me);
  if(contentResult!==undefined)return contentResult;
  switch (action) {
    /* ---------- Сводка ---------- */
    case "stats": {
      const data=check(await sb.rpc("ramp_admin_stats"));
      return {...data,statuses:STATUS};
    }

    /* ---------- Заказы ---------- */
    case "orders": {
      const offset=Math.max(0,int(b.offset ?? 0));
      let q = sb.from("orders").select(ORDER_COLS).order("created_at", { ascending: false }).order("id",{ascending:false}).range(offset,offset+99);
      if(b.id)q=q.eq("id",int(b.id));
      if (b.status && STATUS[b.status]) q = q.eq("status", b.status);
      const s = safeSearch(b.q);
      const rp = /^RP-?(\d{1,9})$/i.exec(s);
      if (rp) {
        // Точный личный ID клиента: RP-12 не должен находить RP-120
        const { data: byNo } = await sb.from("profiles").select("telegram_id").eq("user_no", Number(rp[1])).maybeSingle();
        q = byNo ? q.eq("telegram_id", byNo.telegram_id) : q.eq("id", -1);
      }
      else if (s) {
        if (/^\d+$/.test(s) && s.length > 9) q = q.ilike("phone", `*${s}*`);
        else if (/^\d+$/.test(s)) {
          // Число: номер заказа, номер клиента или часть телефона
          const { data: byNo } = await sb.from("profiles").select("telegram_id").eq("user_no", Number(s)).maybeSingle();
          q = q.or([`id.eq.${s}`, `phone.ilike.*${s}*`, `search_items.ilike.*${s}*`, ...(byNo ? [`telegram_id.eq.${byNo.telegram_id}`] : [])].join(","));
        }
        else {
          const profs=check(await sb.from("profiles").select("telegram_id").or(`public_id.ilike.*${s}*,delivery_id.ilike.*${s}*`).limit(50));
          q=q.or([`full_name.ilike.*${s}*`,`phone.ilike.*${s}*`,`address.ilike.*${s}*`,`search_items.ilike.*${s}*`,`delivery_id.ilike.*${s}*`,`tracking_number.ilike.*${s}*`,...profs.map((p:any)=>`telegram_id.eq.${p.telegram_id}`)].join(","));
        }
      }
      const orders = check(await q) as any[];
      const ids = [...new Set(orders.map((o) => o.telegram_id))];
      const { data: profs } = ids.length
        ? await sb.from("profiles").select("telegram_id,delivery_id,username,user_no").in("telegram_id", ids)
        : { data: [] };
      const byId = Object.fromEntries((profs ?? []).map((p: any) => [p.telegram_id, p]));
      const withReceipt = orders.filter((o) => o.receipt_path);
      const { data: urls } = withReceipt.length
        ? await sb.storage.from("requests").createSignedUrls(withReceipt.map((o) => o.receipt_path), 3600)
        : { data: [] };
      const receiptUrl = Object.fromEntries(withReceipt.map((o, i) => [o.id, urls?.[i]?.signedUrl ?? null]));
      return {
        orders: orders.map((o) => ({ ...o, user: byId[o.telegram_id] ?? null, receipt_url: receiptUrl[o.id] ?? null })),
        payments: (await cfg()).payments,has_more:orders.length===100,
      };
    }

    case "reviewReceipt": {
      const res = await reviewReceipt(int(b.id, "заказ"), !!b.approve, str(b.reason, 300));
      if (!res.ok) throw new HttpError(409, res.error!);
      return { ok: true };
    }

    case "setStatus": {
      let order;
      try { order = await setOrderStatus(int(b.id, "заказ"), String(b.status)); }
      catch(e) {throw new HttpError(409,(e as Error).message);}
      if (!order) throw new HttpError(404, "Заказ не найден");
      return { ok: true };
    }

    case "saveOrder": {
      const id = int(b.id, "заказ");
      check(await sb.from("orders").update({
        full_name: str(b.full_name, 120), phone: str(b.phone, 30), address: str(b.address, 300),
        comment: str(b.comment, 500) || null,...(b.tracking_number!==undefined?{tracking_number:str(b.tracking_number,100)||null}:{}),...(b.delivery_note!==undefined?{delivery_note:str(b.delivery_note,1000)||null}:{}), updated_at: new Date().toISOString(),
      }).eq("id", id));
      return { ok: true };
    }

    /* ---------- Товары ---------- */
    case "products":
      return { products: check(await sb.from("products").select("*").order("id", { ascending: false })) };

    case "uploadProductPhoto":
      return { url: await uploadImage(String(b.image ?? ""), "catalog") };

    case "saveProduct": {
      const row: Record<string, unknown> = {
        name: str(b.name, 200),
        category: str(b.category, 60) || null,
        price: int(b.price, "цена"),
        description: str(b.description, 3000) || null,
        active: b.active !== false,
        in_stock: b.in_stock !== false,
      };
      // Артикул RM-6xxxxx. Пустое поле: новому товару база выдаст следующий номер, у старого артикул не меняется.
      if (String(b.sku ?? "").trim()) {
        try { row.sku = normalizeSku(b.sku); } catch (e) { throw new HttpError(400, (e as Error).message); }
      } else if (!b.id) row.sku = null;
      if (!row.name) throw new HttpError(400, "Укажите название");
      if ((row.price as number) <= 0 || (row.price as number)>100_000_000) throw new HttpError(400, "Цена должна быть больше нуля");
      if (b.options !== undefined) {
        try { row.options = normalizeOptions(b.options); } catch (e) { throw new HttpError(400, (e as Error).message); }
      }
      if (b.specs !== undefined) {
        if (!Array.isArray(b.specs) || b.specs.length>30) throw new HttpError(400,"Не больше 30 характеристик");
        row.specs = b.specs.map((x: any) => ({ name:str(x.name,100), value:str(x.value,300) })).filter((x: any)=>x.name && x.value);
      }
      try { Object.assign(row, catalogFields(b)); } catch(e) { throw new HttpError(400,(e as Error).message); }
      if (b.photo && !/^https:\/\//i.test(String(b.photo))) throw new HttpError(400,"Фото должно быть HTTPS-ссылкой");
      if (b.image || (b.photos===undefined && b.photo!==undefined)) {
        const photo=b.image ? await uploadImage(String(b.image),"catalog") : str(b.photo,2000) || null;
        const previous=b.id ? check(await sb.from("products").select("photos").eq("id",int(b.id)).single()) : null;
        row.photo=photo; row.photos=photo ? [photo,...(previous?.photos ?? []).slice(1)] : [];
      }
      const res=await sb.rpc("ramp_save_catalog_product",{p_uid:me.id,p_id:b.id ? int(b.id) : null,p_data:row});
      if(res.error?.code==="P0001")throw new HttpError(400,res.error.message);
      if(res.error?.code==="23505")throw new HttpError(400,"Товар с таким артикулом уже есть");
      return { product: check(res) };
    }

    case "deleteProduct": {
      const id = int(b.id, "товар");
      check(await sb.from("products").update({ active:false }).eq("id",id));
      return { hidden:true };
    }

    // Полное удаление (кнопка «Удалить навсегда»). deleteProduct оставлен для старых версий панели: он только скрывает.
    case "removeProduct": {
      const id = int(b.id, "товар");
      const product = check(await sb.from("products").select("id,name,sku,photo,photos").eq("id", id).maybeSingle()) as any;
      if (!product) throw new HttpError(404, "Товар не найден");
      // Снимаем товар с витрин «Похожие товары» других товаров.
      const linked = check(await sb.from("products").select("id,related_ids").contains("related_ids", [id])) as any[];
      for (const p of linked) {
        check(await sb.from("products").update({ related_ids: p.related_ids.filter((x: number) => x !== id) }).eq("id", p.id));
      }
      // Отзывы о товаре удаляются, корзины и «Желаемое» очищает база (каскад). Заказы хранят копию товара.
      check(await sb.from("product_reviews").delete().eq("product_id", id));
      check(await sb.from("products").delete().eq("id", id));
      await removeUnusedPhotos([...new Set([product.photo, ...(product.photos ?? [])].filter(Boolean))] as string[]);
      return { removed: true, id };
    }

    /* ---------- Клиенты ---------- */
    case "users": {
      const offset=Math.max(0,int(b.offset ?? 0));
      let q = sb.from("profiles").select(PROFILE_COLS).order("created_at", { ascending: false }).order("telegram_id").range(offset,offset+99);
      const s = safeSearch(b.q).replace(/^@/,"");
      const rp = /^RP-?(\d{1,9})$/i.exec(s);
      if (rp) q = q.eq("user_no", Number(rp[1]));
      else if (s) {
        q = q.or([
          `delivery_id.ilike.*${s}*`, `public_id.ilike.*${s}*`, `username.ilike.*${s}*`, `first_name.ilike.*${s}*`,
          `full_name.ilike.*${s}*`, `phone.ilike.*${s}*`, `tg_phone.ilike.*${s}*`,
          ...(/^\d+$/.test(s) ? [`telegram_id.eq.${s}`, ...(s.length <= 9 ? [`user_no.eq.${s}`] : [])] : []),
        ].join(","));
      }
      if (b.filter === "blocked") q = q.eq("blocked", true);
      const users=check(await q);return {users,has_more:users.length===100};
    }

    case "user": {
      const id = int(b.id, "клиент");
      const [p, orders, coupons, invited] = await Promise.all([
        sb.from("profiles").select(PROFILE_COLS).eq("telegram_id", id).maybeSingle(),
        sb.from("orders").select(ORDER_COLS).eq("telegram_id", id).order("created_at", { ascending: false }),
        sb.from("coupons").select("*").eq("telegram_id", id).order("created_at", { ascending: false }),
        sb.from("profiles").select("telegram_id,delivery_id,first_name,username,ref_rewarded").eq("referred_by", id),
      ]);
      if (!p.data) throw new HttpError(404, "Клиент не найден");
      let referrer = null;
      if (p.data.referred_by) {
        referrer = (await sb.from("profiles").select("telegram_id,delivery_id,first_name,username")
          .eq("telegram_id", p.data.referred_by).maybeSingle()).data;
      }
      const spent = (orders.data ?? []).filter((o: any) => PAID_OR_LATER.includes(o.status))
        .reduce((s: number, o: any) => s + o.total, 0);
      return {
        user: p.data, orders: orders.data ?? [], coupons: coupons.data ?? [], invited: invited.data ?? [],
        referrer, spent, isAdmin: (await cfg()).admins.includes(id),
      };
    }

    case "saveUser": {
      const id = int(b.id, "клиент");
      check(await sb.from("profiles").update({
        full_name: str(b.full_name, 120) || null, phone: str(b.phone, 30) || null,
        city: str(b.city, 60) || null, address: str(b.address, 300) || null,
        note: str(b.note, 2000) || null, blocked: !!b.blocked, updated_at: new Date().toISOString(),
      }).eq("telegram_id", id));
      return { ok: true };
    }

    case "giveCoupon": {
      const id = int(b.id, "клиент");
      const pct = int(b.pct, "процент");
      if (pct < 1 || pct > 90) throw new HttpError(400, "Скидка от 1 до 90%");
      check(await sb.from("coupons").insert({ telegram_id: id, pct, reason: "manual" }));
      if (b.notify !== false) {
        await tg("sendMessage", {
          chat_id: id,
          text: `🎁 Вам подарок от RAMP — купон −${pct}% на следующий заказ. Скидка применится автоматически.`,
          reply_markup: shopButton(),
        });
      }
      return { ok: true };
    }

    case "deleteCoupon": {
      check(await sb.from("coupons").delete().eq("id", int(b.id, "купон")).is("used_order_id", null));
      return { ok: true };
    }

    case "message": {
      const id = int(b.id, "клиент");
      const text = str(b.text, 3500);
      if (!text) throw new HttpError(400, "Пустое сообщение");
      const r = await tg("sendMessage", { chat_id: id, text, reply_markup: shopButton() });
      if (!r.ok) throw new HttpError(400, "Не удалось отправить: клиент мог заблокировать бота");
      return { ok: true };
    }

    /* ---------- Фотозаявки ---------- */
    case "requests": {
      const offset=Math.max(0,int(b.offset ?? 0));
      let q = sb.from("photo_requests").select("*").order("created_at", { ascending: false }).order("id",{ascending:false}).range(offset,offset+59);
      if (b.status === "new" || b.status === "answered") q = q.eq("status", b.status);
      const rows = check(await q) as any[];
      if (!rows.length) return { requests: [] };
      const [{ data: urls }, { data: profs }] = await Promise.all([
        sb.storage.from("requests").createSignedUrls(rows.map((r) => r.photo_path), 3600),
        sb.from("profiles").select("telegram_id,delivery_id,first_name,username")
          .in("telegram_id", [...new Set(rows.map((r) => r.telegram_id))]),
      ]);
      const byId = Object.fromEntries((profs ?? []).map((p: any) => [p.telegram_id, p]));
      return {
        has_more:rows.length===60,requests: rows.map((r, i) => ({ ...r, photo_url: urls?.[i]?.signedUrl ?? null, user: byId[r.telegram_id] ?? null })),
      };
    }

    case "answerRequest": {
      const text = str(b.text, 3500);
      if (!text) throw new HttpError(400, "Напишите ответ");
      const pr = await answerPhotoRequest(int(b.id, "заявка"), text);
      if (!pr) throw new HttpError(404, "Заявка не найдена");
      return { ok: true };
    }

    /* ---------- Настройки ---------- */
    case "settings": {
      const c = await cfg();
      const { data: admins } = await sb.from("admins").select("*").order("created_at");
      return { promo: c.promo, payments: c.payments, cards: c.cards, admins: admins ?? [], me: me.id, bots: await botStatus(), channel:await channelStatus() };
    }

    case "setupBots":
      return { report:await setupBots(), bots:await botStatus() };

    case "saveShopBot": {
      if (Deno.env.get("SHOP_BOT_TOKEN")) throw new HttpError(409,"Токен задан в Supabase Secrets: обновите SHOP_BOT_TOKEN там");
      const token=str(b.token,150);
      if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new HttpError(400,"Проверьте токен из BotFather");
      let identity;
      try {
        const response=await fetch(`https://api.telegram.org/bot${token}/getMe`,{signal:AbortSignal.timeout(10_000)});
        identity=await response.json();
      } catch {throw new HttpError(400,"Telegram недоступен. Повторите позже");}
      if (!identity.ok || identity.result?.username?.toLowerCase() !== SHOP_USERNAME) throw new HttpError(400,`Нужен токен основного бота @${SHOP_USERNAME}`);
      if (token === (await cfg()).botToken) throw new HttpError(400,"Основной бот должен отличаться от админского");
      check(await sb.from("settings").upsert({key:"client_bot_token",value:token,updated_at:new Date().toISOString()}));
      resetCfg();
      return {report:await setupBots(),bots:await botStatus()};
    }

    case "exportData": {
      const tables: Record<string,string>={identifiers:"telegram_id,delivery_id,issued_at",procurement:"id,delivery_id,status,sku,name,variant,qty,unit_price,total",news:"id,title,body,published,published_at,expires_at,duration_hours,created_at",reviews:"id,product_id,author_name,rating,body,source,origin_name,origin_url,status,created_at",orders:ORDER_COLS,users:PROFILE_COLS,products:"id,sku,name,category,price,photo,photos,description,active,in_stock,options,specs,composition,care,delivery_min_days,delivery_max_days,delivery_note,related_ids",faq:"id,question,answer,published,position,created_at,updated_at",requests:"id,telegram_id,comment,status,answer,created_at,answered_at",coupons:"id,telegram_id,pct,reason,source_order_id,used_order_id,created_at"};
      const entity=String(b.entity);
      if (!tables[entity]) throw new HttpError(400,"Неизвестный раздел для экспорта");
      const offset=Math.max(0,int(b.offset ?? 0));
      const table=({users:"profiles",requests:"photo_requests",identifiers:"client_identifiers",procurement:"order_procurement",news:"shop_news",reviews:"product_reviews",faq:"shop_faq"} as Record<string,string>)[entity] || entity;
      const key=["users","identifiers"].includes(entity) ? "telegram_id" : "id";
      const rows=check(await sb.from(table).select(tables[entity]).order(key).range(offset,offset+499));
      return {rows,next_offset:rows.length===500 ? offset+500 : null};
    }

    case "saveSettings": {
      const p = b.promo ?? {};
      const promo: Record<string, number> = {};
      for (const k of Object.keys(DEFAULT_PROMO)) {
        const v = int(p[k], k);
        if (v < 0 || v>2_000_000_000) throw new HttpError(400, "Значения не могут быть отрицательными");
        promo[k] = v;
      }
      for (const k of ["welcomePct", "inviterPct", "inviteeNextPct"]) {
        if (promo[k] > 90) throw new HttpError(400, "Скидка не больше 90%");
      }
      if (promo.welcomeDays>3650) throw new HttpError(400,"Скидка новичка — максимум 3650 дней");
      const payments: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.payments ?? {})) {
        const key = String(k).replace(/[^a-z0-9_]/gi, "").slice(0, 20);
        const label = str(v, 80);
        if (key && label) payments[key] = label;
      }
      if (!Object.keys(payments).length) throw new HttpError(400, "Нужен хотя бы один способ оплаты");
      const cards = (Array.isArray(b.cards) ? b.cards : []).map((c: unknown) => str(c, 40)).filter(Boolean).slice(0, 20);
      if (cards.some((c: string)=>!/^\d{16}$/.test(c.replace(/\s/g,"")))) throw new HttpError(400,"В номере карты должно быть 16 цифр");
      if (!cards.length) throw new HttpError(400, "Нужна хотя бы одна карта для оплаты");
      check(await sb.from("settings").upsert([
        { key: "promo", value: promo, updated_at: new Date().toISOString() },
        { key: "payments", value: payments, updated_at: new Date().toISOString() },
        { key: "payment_cards", value: cards, updated_at: new Date().toISOString() },
      ], { onConflict: "key" }));
      resetCfg();
      return { ok: true };
    }

    case "addAdmin": {
      const id = int(b.id, "Telegram ID");
      if (id<=0) throw new HttpError(400,"Telegram ID должен быть положительным числом");
      check(await sb.from("admins").upsert({ telegram_id: id, name: str(b.name, 60) || null, added_by: me.id }));
      resetCfg();
      return { ok: true };
    }

    case "removeAdmin": {
      const id = int(b.id, "Telegram ID");
      if (id === me.id) throw new HttpError(400, "Нельзя удалить самого себя");
      check(await sb.from("admins").delete().eq("telegram_id", id));
      resetCfg();
      return { ok: true };
    }

    default:
      throw new HttpError(400, "Неизвестное действие");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const user = await verifyInitData(req.headers.get("x-init-data") ?? "", "any");
  if (!user) return json({ error: "Откройте панель через Telegram" }, 401);
  if (!(await cfg()).admins.includes(user.id)) return json({ error: "Нет доступа" }, 403);

  try {
    const body = await req.json().catch(() => ({}));
    return json(await handle(String(body.action ?? ""), body, user));
  } catch (e) {
    if(e instanceof ContentError)return json({error:e.message},e.status);
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Ошибка сервера" }, 500);
  }
});
