// API админ-панели. Доступ только для Telegram ID из таблицы admins.
import {
  answerPhotoRequest, cfg, DEFAULT_PROMO, PAID_OR_LATER, resetCfg, sb, setOrderStatus, shopButton,
  STATUS, tg, type TgUser, verifyInitData,
} from "../_shared/common.ts";

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
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new HttpError(400, `Неверное значение: ${name}`);
  return n;
};
// Поиск по тексту без спецсимволов PostgREST
const safeSearch = (q: unknown) => str(q, 60).replace(/[,()*%\\]/g, " ").trim();

const ORDER_COLS = "id,telegram_id,items,subtotal,discount_pct,discount_amount,discount_reason,total,status," +
  "payment_method,full_name,phone,address,comment,created_at,updated_at";
const PROFILE_COLS = "telegram_id,public_id,first_name,last_name,username,full_name,phone,tg_phone,city," +
  "address,referred_by,ref_rewarded,note,blocked,created_at";

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

async function handle(action: string, b: any, me: TgUser) {
  switch (action) {
    /* ---------- Сводка ---------- */
    case "stats": {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const [orders, users, newReq, paid] = await Promise.all([
        sb.from("orders").select("status"),
        sb.from("profiles").select("telegram_id", { count: "exact", head: true }),
        sb.from("photo_requests").select("id", { count: "exact", head: true }).eq("status", "new"),
        sb.from("orders").select("total").in("status", PAID_OR_LATER).gte("created_at", since),
      ]);
      const byStatus: Record<string, number> = {};
      for (const o of orders.data ?? []) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      return {
        byStatus,
        users: users.count ?? 0,
        newRequests: newReq.count ?? 0,
        revenue30: (paid.data ?? []).reduce((s: number, o: any) => s + o.total, 0),
        paid30: (paid.data ?? []).length,
        statuses: STATUS,
      };
    }

    /* ---------- Заказы ---------- */
    case "orders": {
      let q = sb.from("orders").select(ORDER_COLS).order("created_at", { ascending: false }).limit(100);
      if (b.status && STATUS[b.status]) q = q.eq("status", b.status);
      const s = safeSearch(b.q);
      if (s) {
        if (/^\d+$/.test(s)) q = q.or(`id.eq.${s},phone.ilike.*${s}*`);
        else q = q.or(`full_name.ilike.*${s}*,phone.ilike.*${s}*,address.ilike.*${s}*`);
      }
      const orders = check(await q) as any[];
      const ids = [...new Set(orders.map((o) => o.telegram_id))];
      const { data: profs } = ids.length
        ? await sb.from("profiles").select("telegram_id,public_id,username").in("telegram_id", ids)
        : { data: [] };
      const byId = Object.fromEntries((profs ?? []).map((p: any) => [p.telegram_id, p]));
      return { orders: orders.map((o) => ({ ...o, user: byId[o.telegram_id] ?? null })), payments: (await cfg()).payments };
    }

    case "setStatus": {
      const order = await setOrderStatus(int(b.id, "заказ"), String(b.status));
      if (!order) throw new HttpError(404, "Заказ не найден");
      return { ok: true };
    }

    case "saveOrder": {
      const id = int(b.id, "заказ");
      check(await sb.from("orders").update({
        full_name: str(b.full_name, 120), phone: str(b.phone, 30), address: str(b.address, 300),
        comment: str(b.comment, 500) || null, updated_at: new Date().toISOString(),
      }).eq("id", id));
      return { ok: true };
    }

    /* ---------- Товары ---------- */
    case "products":
      return { products: check(await sb.from("products").select("*").order("id", { ascending: false })) };

    case "saveProduct": {
      const row: Record<string, unknown> = {
        name: str(b.name, 200),
        category: str(b.category, 60) || null,
        price: int(b.price, "цена"),
        description: str(b.description, 3000) || null,
        active: b.active !== false,
        in_stock: b.in_stock !== false,
      };
      if (!row.name) throw new HttpError(400, "Укажите название");
      if ((row.price as number) <= 0) throw new HttpError(400, "Цена должна быть больше нуля");
      if (b.image) row.photo = await uploadImage(String(b.image), "catalog");
      else if (b.photo !== undefined) row.photo = str(b.photo, 1000) || null;
      const res = b.id
        ? await sb.from("products").update(row).eq("id", int(b.id)).select().single()
        : await sb.from("products").insert(row).select().single();
      return { product: check(res) };
    }

    case "deleteProduct": {
      const id = int(b.id, "товар");
      // Товар из прошлых заказов не удаляем, а скрываем — история заказов не ломается
      const del = await sb.from("products").delete().eq("id", id);
      if (del.error) {
        check(await sb.from("products").update({ active: false }).eq("id", id));
        return { hidden: true };
      }
      return { deleted: true };
    }

    /* ---------- Клиенты ---------- */
    case "users": {
      let q = sb.from("profiles").select(PROFILE_COLS).order("created_at", { ascending: false }).limit(100);
      const s = safeSearch(b.q);
      if (s) {
        q = q.or([
          `public_id.ilike.*${s}*`, `username.ilike.*${s}*`, `first_name.ilike.*${s}*`,
          `full_name.ilike.*${s}*`, `phone.ilike.*${s}*`, `tg_phone.ilike.*${s}*`,
          ...(/^\d+$/.test(s) ? [`telegram_id.eq.${s}`] : []),
        ].join(","));
      }
      if (b.filter === "blocked") q = q.eq("blocked", true);
      return { users: check(await q) };
    }

    case "user": {
      const id = int(b.id, "клиент");
      const [p, orders, coupons, invited] = await Promise.all([
        sb.from("profiles").select(PROFILE_COLS).eq("telegram_id", id).maybeSingle(),
        sb.from("orders").select(ORDER_COLS).eq("telegram_id", id).order("created_at", { ascending: false }),
        sb.from("coupons").select("*").eq("telegram_id", id).order("created_at", { ascending: false }),
        sb.from("profiles").select("telegram_id,public_id,first_name,username,ref_rewarded").eq("referred_by", id),
      ]);
      if (!p.data) throw new HttpError(404, "Клиент не найден");
      let referrer = null;
      if (p.data.referred_by) {
        referrer = (await sb.from("profiles").select("telegram_id,public_id,first_name,username")
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
      let q = sb.from("photo_requests").select("*").order("created_at", { ascending: false }).limit(60);
      if (b.status === "new" || b.status === "answered") q = q.eq("status", b.status);
      const rows = check(await q) as any[];
      if (!rows.length) return { requests: [] };
      const [{ data: urls }, { data: profs }] = await Promise.all([
        sb.storage.from("requests").createSignedUrls(rows.map((r) => r.photo_path), 3600),
        sb.from("profiles").select("telegram_id,public_id,first_name,username")
          .in("telegram_id", [...new Set(rows.map((r) => r.telegram_id))]),
      ]);
      const byId = Object.fromEntries((profs ?? []).map((p: any) => [p.telegram_id, p]));
      return {
        requests: rows.map((r, i) => ({ ...r, photo_url: urls?.[i]?.signedUrl ?? null, user: byId[r.telegram_id] ?? null })),
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
      return { promo: c.promo, payments: c.payments, admins: admins ?? [], me: me.id };
    }

    case "saveSettings": {
      const p = b.promo ?? {};
      const promo: Record<string, number> = {};
      for (const k of Object.keys(DEFAULT_PROMO)) {
        const v = int(p[k], k);
        if (v < 0) throw new HttpError(400, "Значения не могут быть отрицательными");
        promo[k] = v;
      }
      for (const k of ["welcomePct", "inviterPct", "inviteeNextPct"]) {
        if (promo[k] > 90) throw new HttpError(400, "Скидка не больше 90%");
      }
      const payments: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.payments ?? {})) {
        const key = String(k).replace(/[^a-z0-9_]/gi, "").slice(0, 20);
        const label = str(v, 80);
        if (key && label) payments[key] = label;
      }
      if (!Object.keys(payments).length) throw new HttpError(400, "Нужен хотя бы один способ оплаты");
      check(await sb.from("settings").upsert([
        { key: "promo", value: promo, updated_at: new Date().toISOString() },
        { key: "payments", value: payments, updated_at: new Date().toISOString() },
      ], { onConflict: "key" }));
      resetCfg();
      return { ok: true };
    }

    case "addAdmin": {
      const id = int(b.id, "Telegram ID");
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

  const user = await verifyInitData(req.headers.get("x-init-data") ?? "");
  if (!user) return json({ error: "Откройте панель через Telegram" }, 401);
  if (!(await cfg()).admins.includes(user.id)) return json({ error: "Нет доступа" }, 403);

  try {
    const body = await req.json().catch(() => ({}));
    return json(await handle(String(body.action ?? ""), body, user));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Ошибка сервера" }, 500);
  }
});
