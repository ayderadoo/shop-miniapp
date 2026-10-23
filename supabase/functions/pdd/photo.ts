// Фото товара в стиле RAMP из скриншота: вырезаем товар по рамке от Gemini и кладём на фирменный фон.
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

// Белый логотип RAMP (Dela Gothic One, наклон −10°), лежит в репозитории: img/ramp-logo-white.png
const LOGO_URL = "https://shop-miniapp-two.vercel.app/img/ramp-logo-white.png";
const SIZE = 1080;
const BG = Image.rgbaToColor(0xF3, 0xF5, 0xFB, 0xFF);
const AZURE = Image.rgbaToColor(0x2B, 0x3F, 0xD6, 0xFF);
const TURQUOISE = Image.rgbaToColor(0x19, 0xC3, 0xC9, 0xFF);
const WHITE = 0xFFFFFFFF;
const SHADOW = Image.rgbaToColor(0x14, 0x18, 0x3A, 0x1A);

let logo: Image | null = null;

async function loadLogo() {
  if (logo) return logo;
  try {
    const res = await fetch(LOGO_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) logo = await Image.decode(new Uint8Array(await res.arrayBuffer())) as Image;
  } catch { /* без логотипа фото всё равно собирается */ }
  return logo;
}

// box — [ymin, xmin, ymax, xmax] в долях 0–1000 (формат box_2d Gemini)
export async function brandPhoto(shot: Uint8Array, box: number[]): Promise<Uint8Array | null> {
  const src = await Image.decode(shot);
  let [y0, x0, y1, x1] = box.map(v => Math.min(1000, Math.max(0, Number(v) || 0)));
  if (!(y1 - y0 > 40 && x1 - x0 > 40)) return null;
  // Рамки Gemini чаще шире товара, чем уже: чуть поджимаем, чтобы не цеплять соседние баннеры
  const padY = (y1 - y0) * 0.02, padX = (x1 - x0) * 0.02;
  y0 += padY; y1 -= padY; x0 += padX; x1 -= padX;
  const cx = Math.round(x0 / 1000 * src.width), cy = Math.round(y0 / 1000 * src.height);
  const cw = Math.max(1, Math.round((x1 - x0) / 1000 * src.width)), ch = Math.max(1, Math.round((y1 - y0) / 1000 * src.height));
  const product = src.crop(cx, cy, Math.min(cw, src.width - cx), Math.min(ch, src.height - cy));

  // Фон и фирменная диагональ «трамплина»: синяя шапка с бирюзовой наклонной кромкой
  const canvas = new Image(SIZE, SIZE).fill((x: number, y: number) => {
    const edge = 190 - x * 0.09;
    if (y <= edge) return AZURE;
    if (y <= edge + 16) return TURQUOISE;
    return BG;
  });
  const mark = await loadLogo();
  if (mark) canvas.composite(mark.clone().resize(Image.RESIZE_AUTO, 64), 56, 44);

  // Белая карточка с мягкой тенью, товар по центру
  const area = { x: 70, y: 240, w: SIZE - 140, h: SIZE - 240 - 60 };
  const shadow = new Image(area.w, area.h).fill(SHADOW).roundCorners(40);
  canvas.composite(shadow, area.x + 6, area.y + 14);
  canvas.composite(new Image(area.w, area.h).fill(WHITE).roundCorners(40), area.x, area.y);
  const inner = { w: area.w - 80, h: area.h - 80 };
  const scale = Math.min(inner.w / product.width, inner.h / product.height);
  product.resize(Math.max(1, Math.round(product.width * scale)), Math.max(1, Math.round(product.height * scale)));
  product.roundCorners(24);
  canvas.composite(product, area.x + Math.round((area.w - product.width) / 2), area.y + Math.round((area.h - product.height) / 2));
  return await canvas.encodeJPEG(88);
}
