export function normalizeOptions(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 6) throw new Error("Не больше 6 параметров товара");
  const names = new Set<string>();
  return raw.map((o: any) => {
    const name = String(o?.name ?? "").trim().slice(0, 60);
    if (!name || names.has(name) || !Array.isArray(o.values) || !o.values.length || o.values.length > 30) {
      throw new Error("У каждого параметра нужны уникальное название и 1–30 вариантов");
    }
    names.add(name);
    const labels = new Set<string>();
    return { name, values: o.values.map((v: any) => {
      const label = String(v?.label ?? "").trim().slice(0, 60);
      const add = Number(v?.add ?? 0);
      if (!label || labels.has(label) || !Number.isSafeInteger(add) || Math.abs(add) > 100_000_000) {
        throw new Error("Проверьте названия вариантов и доплаты в целых сумах");
      }
      labels.add(label);
      return { label, add };
    }) };
  });
}

export const isUzbekPhone = (value: unknown) => /^\+998\d{9}$/.test(String(value ?? ""));

export function normalizeSku(value: unknown) {
  const sku=String(value ?? "").trim().toUpperCase();
  if (!sku || sku.length>64 || /[\u0000-\u001f\u007f]/.test(sku)) throw new Error("Укажите артикул: до 64 символов");
  return sku;
}

export function pickVariant(product: any, raw: unknown) {
  const options = Array.isArray(product.options) ? product.options : [];
  const selection = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const opts: Record<string, string> = {};
  let price = Number(product.price);
  for (const option of options) {
    const value = option.values?.find((v: any) => v.label === selection[option.name]);
    if (!value) return { ok: false as const, error: `Выберите: ${option.name}` };
    opts[option.name] = value.label;
    price += Number(value.add) || 0;
  }
  if (!Number.isSafeInteger(price) || price < 1 || price > 100_000_000) {
    return { ok: false as const, error: "Недопустимая цена варианта" };
  }
  return { ok: true as const, opts, variant: options.map((o: any) => `${o.name}: ${opts[o.name]}`).join(", "), price };
}

export function parseInitData(raw: string, now = Date.now()) {
  if (!raw || raw.length > 16_384) return null;
  const params = new URLSearchParams(raw);
  if ([...new Set(params.keys())].some((key) => params.getAll(key).length !== 1)) return null;
  const hash = params.get("hash") ?? "";
  const date = Number(params.get("auth_date"));
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isFinite(date) || date <= 0 || now / 1000 - date > 86_400 || date > now / 1000 + 60) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    if (!Number.isSafeInteger(user?.id) || user.id <= 0) return null;
    params.delete("hash");
    const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${k}=${v}`).join("\n");
    return { hash, user, data };
  } catch { return null; }
}
