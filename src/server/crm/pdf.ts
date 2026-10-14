import PDFDocument from "pdfkit";
import { resolve } from "node:path";
import type { Quote } from "../../domain/crm";
import { moneyText } from "../../lib/inventory-i18n";
export async function quotePdf(q: Quote, locale: "ru" | "kk") {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const pdf = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: `${t("Предложение", "Ұсыныс")} ${q.number}`,
        Author: "Басқару",
      },
    }),
    parts: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (b) => parts.push(b));
    pdf.on("end", () => resolve(Buffer.concat(parts)));
    pdf.on("error", reject);
  });
  pdf.font(resolve(process.cwd(), "assets/fonts/NotoSans.ttf"));
  pdf
    .fillColor("#204b38")
    .fontSize(25)
    .text(t("Коммерческое предложение", "Коммерциялық ұсыныс"));
  pdf
    .moveDown(0.5)
    .fontSize(11)
    .fillColor("#242f28")
    .text(`№ ${q.number} · ${t("Версия", "Нұсқа")} ${q.version}`);
  pdf
    .moveDown()
    .text(`${t("Клиент", "Клиент")}: ${q.customer_name}`)
    .text(`${t("Действует до", "Дейін жарамды")}: ${q.data.validUntil}`);
  pdf
    .moveDown()
    .fontSize(9)
    .fillColor("#64736a")
    .text(
      t(
        "Цены в KZT, без косвенных налогов. Это предложение, не подтверждение оплаты или исполнения.",
        "Бағалар KZT, жанама салықтарсыз. Бұл ұсыныс, төлем немесе орындалу растамасы емес.",
      ),
    );
  pdf.moveDown();
  for (const [index, l] of q.data.lines.entries()) {
    if (pdf.y > 680) pdf.addPage();
    pdf
      .fontSize(11)
      .fillColor("#242f28")
      .text(
        `${index + 1}. ${locale === "kk" && l.name_kk ? l.name_kk : l.name_ru} · ${l.sku}`,
      );
    pdf
      .fontSize(10)
      .text(
        `${l.quantity} ${l.unit} × ${l.price} KZT · ${t("скидка", "жеңілдік")} ${l.discount}%`,
      );
    pdf
      .text(`${t("Сумма", "Сома")}: ${moneyText(l.total_minor)} KZT`)
      .moveDown(0.7);
  }
  if (pdf.y > 650) pdf.addPage();
  pdf
    .moveDown()
    .fillColor("#204b38")
    .fontSize(17)
    .text(`${t("Итого", "Барлығы")}: ${moneyText(q.data.total_minor)} KZT`);
  pdf
    .moveDown()
    .fontSize(12)
    .fillColor("#242f28")
    .text(t("Условия", "Шарттар"))
    .fontSize(10)
    .text(q.data.terms, { lineGap: 3 });
  pdf.end();
  return result;
}
