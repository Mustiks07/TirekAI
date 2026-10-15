import PDFDocument from "pdfkit";
import { resolve } from "node:path";
import type { CampaignData, Evaluation } from "../../domain/marketing";
import { moneyText } from "../../lib/inventory-i18n";

// T039 printable materials. Prices and item names are printed from the evaluated facts of the
// approved version, next to the author's text; an image is illustrative and never replaces them.
export type Material = "poster" | "price_tag" | "card";
const sizes: Record<Material, [number, number] | "A4"> = {
  poster: "A4",
  // A7 (74 × 105 mm) shelf price tag, one item per page.
  price_tag: [210, 298],
  // A6 (105 × 148 mm) offer card.
  card: [298, 420],
};
export async function materialPdf(input: {
  material: Material;
  locale: "ru" | "kk";
  data: CampaignData;
  evaluation: Evaluation;
  version: number;
  image: { bytes: Buffer; alt: string } | null;
}) {
  const { material, locale, data, evaluation: e } = input;
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const text = data.materials[locale];
  const small = material !== "poster";
  const pdf = new PDFDocument({
      size: sizes[material],
      margin: small ? 16 : 48,
      autoFirstPage: material !== "price_tag",
      info: {
        Title: `${text.title} · v${input.version}`,
        Author: "Басқару",
      },
    }),
    parts: Buffer[] = [];
  const result = new Promise<Buffer>((done, reject) => {
    pdf.on("data", (b) => parts.push(b));
    pdf.on("end", () => done(Buffer.concat(parts)));
    pdf.on("error", reject);
  });
  pdf.font(resolve(process.cwd(), "assets/fonts/NotoSans.ttf"));
  const name = (l: Evaluation["lines"][number]) =>
    (locale === "kk" ? l.nameKk || l.nameRu : l.nameRu) ?? "";
  const period = `${data.startsOn.split("-").reverse().join(".")} – ${data.endsOn.split("-").reverse().join(".")}`;
  const footer = () =>
    pdf
      .fontSize(small ? 6 : 8)
      .fillColor("#64736a")
      .text(
        t(
          `Цены в KZT. Версия материала ${input.version}. Изображение иллюстративное, характеристики указаны в описании товара.`,
          `Бағалар KZT. Материал нұсқасы ${input.version}. Сурет иллюстрациялық, сипаттамалары тауар сипаттамасында көрсетілген.`,
        ),
      );
  if (material === "price_tag") {
    let pages = 0;
    for (const l of e.lines) {
      if (!l.priceMinor) continue;
      pdf.addPage();
      pages++;
      pdf.fontSize(11).fillColor("#242f28").text(name(l), { height: 60 });
      pdf
        .fontSize(7)
        .fillColor("#64736a")
        .text(`${l.sku ?? ""}`);
      pdf.moveDown(0.5);
      if (e.offer === "discount" && l.promoMinor) {
        pdf
          .fontSize(10)
          .fillColor("#64736a")
          .text(`${moneyText(l.priceMinor)} ₸`, { strike: true });
        pdf
          .fontSize(24)
          .fillColor("#b3261e")
          .text(`${moneyText(l.promoMinor)} ₸`);
        pdf
          .fontSize(9)
          .fillColor("#204b38")
          .text(`${t("Скидка", "Жеңілдік")} ${l.discount}%`);
      } else {
        pdf
          .fontSize(20)
          .fillColor("#242f28")
          .text(`${moneyText(l.priceMinor)} ₸`);
        if (e.bundle)
          pdf
            .fontSize(8)
            .fillColor("#204b38")
            .text(
              `${t("В комплекте", "Жиынтықта")}: ${moneyText(e.bundle.priceMinor)} ₸`,
            );
      }
      pdf.moveDown(0.5).fontSize(7).fillColor("#242f28").text(period);
      footer();
    }
    if (!pages) pdf.addPage();
    pdf.end();
    return result;
  }
  pdf
    .fillColor("#204b38")
    .fontSize(small ? 16 : 30)
    .text(text.title);
  pdf
    .moveDown(0.3)
    .fontSize(small ? 8 : 12)
    .fillColor("#242f28")
    .text(period);
  if (input.image) {
    pdf.moveDown(0.5);
    pdf.image(input.image.bytes, {
      fit: small ? [266, 110] : [499, 260],
      align: "center",
    });
    pdf
      .fontSize(small ? 6 : 8)
      .fillColor("#64736a")
      .text(input.image.alt);
  }
  if (text.body)
    pdf
      .moveDown(0.5)
      .fontSize(small ? 9 : 14)
      .fillColor("#242f28")
      .text(text.body, { lineGap: 2 });
  pdf.moveDown(0.5);
  for (const l of e.lines) {
    if (pdf.y > pdf.page.height - (small ? 80 : 140)) pdf.addPage();
    if (e.offer === "discount" && l.priceMinor && l.promoMinor)
      pdf
        .fontSize(small ? 9 : 13)
        .fillColor("#242f28")
        .text(
          `${name(l)}: ${moneyText(l.promoMinor)} ₸ (${t("было", "бұрын")} ${moneyText(l.priceMinor)} ₸, −${l.discount}%)`,
        );
    else
      pdf
        .fontSize(small ? 9 : 13)
        .fillColor("#242f28")
        .text(`${name(l)} × ${l.quantity}`);
  }
  if (e.bundle)
    pdf
      .moveDown(0.3)
      .fontSize(small ? 14 : 22)
      .fillColor("#b3261e")
      .text(
        `${t("Комплект", "Жиынтық")}: ${moneyText(e.bundle.priceMinor)} ₸${e.bundle.regularMinor ? ` (${t("вместо", "орнына")} ${moneyText(e.bundle.regularMinor)} ₸)` : ""}`,
      );
  if (text.terms)
    pdf
      .moveDown(0.5)
      .fontSize(small ? 7 : 10)
      .fillColor("#242f28")
      .text(text.terms);
  pdf.moveDown(0.5);
  footer();
  pdf.end();
  return result;
}
