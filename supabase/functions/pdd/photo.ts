// Фото товара в стиле RAMP из скриншота (бесплатный вариант): вырезаем товар по рамке от Gemini,
// кладём на белый фон в синей скруглённой рамке, внизу — маленький синий логотип.
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

// Белый логотип RAMP (Dela Gothic One, наклон −10°), лежит в репозитории: img/ramp-logo-white.png; здесь перекрашиваем в синий
const LOGO_URL = "https://shop-miniapp-two.vercel.app/img/ramp-logo-white.png";
const SIZE = 1080;
const AZURE = Image.rgbaToColor(0x2B, 0x3F, 0xD6, 0xFF);
const WHITE = 0xFFFFFFFF;
const BORDER = 12;

let logo: Image | null = null;

async function loadLogo() {
  if (logo) return logo;
  try {
    const res = await fetch(LOGO_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const white = await Image.decode(new Uint8Array(await res.arrayBuffer())) as Image;
    // Перекрашиваем в лазурит, сохраняя прозрачность букв
    logo = white.fill((x: number, y: number) => {
      const a = white.getPixelAt(x, y) & 0xFF;
      return Image.rgbaToColor(0x2B, 0x3F, 0xD6, a);
    });
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

  const canvas = new Image(SIZE, SIZE).fill(WHITE);
  // Товар в синей скруглённой рамке по центру, снизу место под логотип
  const area = { x: 70, y: 60, w: SIZE - 140, h: SIZE - 60 - 150 };
  const scale = Math.min((area.w - 2 * BORDER) / product.width, (area.h - 2 * BORDER) / product.height);
  product.resize(Math.max(1, Math.round(product.width * scale)), Math.max(1, Math.round(product.height * scale)));
  product.roundCorners(28);
  const frame = new Image(product.width + 2 * BORDER, product.height + 2 * BORDER).fill(AZURE).roundCorners(28 + BORDER);
  const fx = Math.round((SIZE - frame.width) / 2), fy = area.y + Math.round((area.h - frame.height) / 2);
  canvas.composite(frame, fx, fy);
  canvas.composite(product, fx + BORDER, fy + BORDER);

  const mark = await loadLogo();
  if (mark) {
    const m = mark.clone().resize(Image.RESIZE_AUTO, 52);
    canvas.composite(m, Math.round((SIZE - m.width) / 2), SIZE - 52 - 46);
  }
  return await canvas.encodeJPEG(90);
}
