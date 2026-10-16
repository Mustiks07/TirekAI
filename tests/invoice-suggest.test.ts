import { expect, it } from "vitest";
import { suggestReview, amount } from "../src/lib/invoice-suggest";

const text = `СИНТЕТИЧЕСКИЙ ДОКУМЕНТ ДЛЯ ДЕМО
ТОО «Тараз Снаб» (вымышленный поставщик)
Накладная № ТС-1042 от 16.10.2026
1 Чай чёрный 250 г 40 шт 1 300,00 52 000,00
2 Чай зелёный 100 г 24 шт 900,00 21 600,00
Доставка: 2 500,00
Итого к оплате: 76 100,00 тг`;
const candidates = [
  {
    name: "Чай чёрный 250 г",
    quantity: "40",
    unitPrice: "1300.00",
    total: "52000.00",
  },
  {
    name: "Чай зелёный 100 г",
    quantity: "24",
    unitPrice: "900.00",
    total: "21600.00",
  },
];
it("demo: OCR suggestions fill number, date, delivery, total and order lines by name", () => {
  const s = suggestReview({ text, candidates }, [
    { id: "green", name: "Чай зелёный 100 г" },
    { id: "black", name: "Чай черный 250 г" },
    { id: "coffee", name: "Кофе зерновой 1 кг" },
  ]);
  expect(s).toMatchObject({
    number: "ТС-1042",
    date: "2026-10-16",
    delivery: "2500.00",
    total: "76100.00",
    lines: {
      black: { quantity: "40", unitPrice: "1300.00" },
      green: { quantity: "24", unitPrice: "900.00" },
    },
    unmatched: ["coffee"],
  });
});
it("demo: unreadable values stay empty instead of zero", () => {
  const s = suggestReview({ text: "размытый текст", candidates: [] }, [
    { id: "a", name: "Чай" },
  ]);
  expect(s).toMatchObject({
    number: null,
    date: null,
    delivery: null,
    total: null,
    lines: {},
    unmatched: ["a"],
  });
  expect(amount("12 5О0,00")).toBeNull();
});
