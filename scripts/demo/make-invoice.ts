// Renders the synthetic demo invoice (fictional supplier, fictional numbers) as a scan-like PNG:
// slight rotation, uneven paper tone and noise, so the demo exercises real local OCR.
// `npx tsx scripts/demo/make-invoice.ts docs/demo/invoice-ts-1042.png`
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const require = createRequire(import.meta.url);
const fonts = join(
  dirname(require.resolve("@fontsource-variable/noto-sans/package.json")),
  "files",
);
// Each subset is its own family; the font list lets the renderer fall back per glyph.
const families = ["latin", "cyrillic", "cyrillic-ext"].map((subset) => {
  GlobalFonts.registerFromPath(
    join(fonts, `noto-sans-${subset}-wght-normal.woff2`),
    `Demo-${subset}`,
  );
  return `"Demo-${subset}"`;
});
export const DEMO_INVOICE = {
  number: "ТС-1042",
  date: "16.10.2026",
  supplier: "ТОО «Тараз Снаб» (вымышленный поставщик)",
  lines: [
    {
      name: "Чай чёрный 250 г",
      qty: "40",
      unit: "шт",
      price: "1 300,00",
      total: "52 000,00",
    },
    {
      name: "Чай зелёный 100 г",
      qty: "24",
      unit: "шт",
      price: "900,00",
      total: "21 600,00",
    },
  ],
  delivery: "2 500,00",
  total: "76 100,00",
};
const W = 1654,
  H = 1170;
const canvas = createCanvas(W, H),
  g = canvas.getContext("2d");
g.fillStyle = "#f4f1ea";
g.fillRect(0, 0, W, H);
let seed = 1042;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
g.translate(W / 2, H / 2);
g.rotate(0.006);
g.translate(-W / 2, -H / 2);
g.fillStyle = "#1d1d1d";
const text = (s: string, x: number, y: number, size = 30, weight = 400) => {
  g.font = `${weight} ${size}px ${families.join(", ")}`;
  g.fillText(s, x, y);
};
text(
  "СИНТЕТИЧЕСКИЙ ДОКУМЕНТ ДЛЯ ДЕМО · НЕ ЯВЛЯЕТСЯ ПЕРВИЧНЫМ ДОКУМЕНТОМ",
  90,
  70,
  22,
);
text(DEMO_INVOICE.supplier, 90, 140, 32, 600);
text(
  `Накладная № ${DEMO_INVOICE.number} от ${DEMO_INVOICE.date}`,
  90,
  220,
  40,
  700,
);
text("Покупатель: Tirek Market · Тестовые данные", 90, 280, 30);
const cols = [90, 170, 760, 920, 1040, 1300];
const header = ["№", "Наименование", "Кол-во", "Ед.", "Цена", "Сумма"];
g.lineWidth = 2;
g.strokeStyle = "#333";
const rowY = (i: number) => 360 + i * 70;
for (let i = 0; i <= 3; i++) {
  g.beginPath();
  g.moveTo(80, rowY(i) - 48);
  g.lineTo(1570, rowY(i) - 48);
  g.stroke();
}
header.forEach((h, i) => text(h, cols[i], rowY(0), 30, 600));
DEMO_INVOICE.lines.forEach((l, i) => {
  const r = rowY(i + 1);
  [String(i + 1), l.name, l.qty, l.unit, l.price, l.total].forEach((v, k) =>
    text(v, cols[k], r, 32),
  );
});
text(`Доставка: ${DEMO_INVOICE.delivery}`, 1040, rowY(3) + 40, 32);
text(`Итого к оплате: ${DEMO_INVOICE.total} тг`, 900, rowY(3) + 110, 36, 700);
text("Отпустил: ____________     Получил: ____________", 90, 1020, 28);
const img = g.getImageData(0, 0, W, H);
for (let i = 0; i < img.data.length; i += 4) {
  const n = (rnd() - 0.5) * 34;
  for (let c = 0; c < 3; c++)
    img.data[i + c] = Math.max(0, Math.min(255, img.data[i + c] + n));
}
g.putImageData(img, 0, 0);
await writeFile(
  process.argv[2] ?? "invoice.jpg",
  canvas.toBuffer("image/jpeg", 82),
);
