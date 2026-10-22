// Optional additive fields: old admin clients can still save products without them.
export function catalogFields(body: any): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of ["composition", "care", "delivery_note"]) {
    if (body[key] !== undefined) row[key] = String(body[key] ?? "").trim().slice(0, key === "delivery_note" ? 500 : 3000);
  }
  if (body.delivery_min_days !== undefined || body.delivery_max_days !== undefined) {
    const min = Number(body.delivery_min_days ?? 8), max = Number(body.delivery_max_days ?? 10);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 120) throw new Error("Проверьте срок доставки: от 1 до 120 дней");
    row.delivery_min_days = min; row.delivery_max_days = max;
  }
  if (body.photos !== undefined) {
    if (!Array.isArray(body.photos) || body.photos.length > 10) throw new Error("В галерее может быть до 10 фотографий");
    row.photos = [...new Set(body.photos.map((value: unknown) => {
      if (typeof value !== "string" || value.length > 2000) throw new Error("Неверная ссылка на фото");
      let url: URL; try { url = new URL(value); } catch { throw new Error("Фото должно быть HTTPS-ссылкой"); }
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Фото должно быть HTTPS-ссылкой");
      return url.href;
    }))];
    row.photo = (row.photos as string[])[0] ?? null;
  }
  if (body.related_ids !== undefined) {
    if (!Array.isArray(body.related_ids) || body.related_ids.length > 24 || body.related_ids.some((id: unknown) => typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id === Number(body.id))) throw new Error("Выберите до 24 других товаров для витрины");
    row.related_ids = [...new Set(body.related_ids)];
  }
  return row;
}
