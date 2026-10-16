// T056 / REQ AI 07: which recognized words the person must check before sending. A word the
// recognizer was unsure of is flagged; amounts, quantities and negations are flagged at a much
// stricter threshold because a mistake there changes the meaning of a business request.
// Over-flagging only asks for one more look; a missed flag could send a wrong amount.
export type RecognizedWord = { w: string; p: number };
export const UNSURE_WORD = 0.5,
  UNSURE_CRITICAL = 0.9;
const RU_NUMBERS = new Set(
  (
    "ноль нуля один одна одно одну одного одной два две двух двум двумя три трех трём трем тремя четыре четырех четырём пять пяти пятью шесть шести семь семи восемь восьми девять девяти десять десяти " +
    "одиннадцать одиннадцати двенадцать двенадцати тринадцать тринадцати четырнадцать четырнадцати пятнадцать пятнадцати шестнадцать шестнадцати семнадцать семнадцати восемнадцать восемнадцати девятнадцать девятнадцати " +
    "двадцать двадцати тридцать тридцати сорок сорока пятьдесят пятидесяти шестьдесят шестидесяти семьдесят семидесяти восемьдесят восьмидесяти девяносто девяноста " +
    "сто ста двести двухсот триста трехсот четыреста четырехсот пятьсот пятисот шестьсот семьсот восемьсот девятьсот тысяча тысячи тысяч тысячу миллион миллиона миллионов полтора полторы половина половину"
  ).split(" "),
);
// Kazakh numerals take case and possessive endings: жиырма → жиырмасы, мың → мыңнан.
const KK_NUMBER_STEMS =
  "нөл бір екі үш төрт бес алты жеті сегіз тоғыз он жиырма отыз қырық елу алпыс жетпіс сексен тоқсан жүз мың миллион жарты".split(
    " ",
  );
const NEGATIONS = new Set(
  "не нет ни нельзя никогда ничего жоқ емес ешқашан ешқандай ешнәрсе".split(
    " ",
  ),
);
const clean = (w: string) =>
  w
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]/gu, "");
export function isCritical(word: string, locale: "ru" | "kk") {
  const w = clean(word);
  if (!w) return false;
  if (/\d/.test(w) || NEGATIONS.has(w)) return true;
  if (locale === "ru") return RU_NUMBERS.has(w);
  if (KK_NUMBER_STEMS.some((n) => w === n || (n.length > 2 && w.startsWith(n))))
    return true;
  // Kazakh negative verb forms of business verbs: жүргізбе, жіберме, төлеме, алмаймын,
  // бермеңіз. A bare "-ма/-ме" ending is not enough: қойма, тапсырма are nouns.
  return KK_NEGATIVE.test(w);
}
const KK_NEGATIVE = new RegExp(
  `^(${[
    "жүргіз",
    "жібер",
    "төле",
    "ал",
    "бер",
    "сат",
    "жаса",
    "қос",
    "өшір",
    "жой",
    "қабылда",
    "тапсыр",
    "жаз",
    "сақта",
    "келіс",
    "раста",
    "өзгерт",
    "шығар",
    "есепте",
    "тексер",
    "аш",
    "жап",
    "күт",
    "қайтар",
    "аудар",
    "құр",
    "тағайында",
  ].join(
    "|",
  )})(ма|ме|ба|бе|па|пе)(ңыз|ңіз|йды|йді|ймын|ймін|ймыз|йміз|ңдар|ңдер|йсың|йсің|сын|сін)?$`,
  "u",
);
export function reviewTranscript(words: RecognizedWord[], locale: "ru" | "kk") {
  const text = words
    .map((x) => x.w)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
  const uncertain = words
    .filter(
      (x) =>
        x.p < UNSURE_WORD || (isCritical(x.w, locale) && x.p < UNSURE_CRITICAL),
    )
    .map((x) => x.w);
  const confidence = words.length
    ? Math.round((words.reduce((a, x) => a + x.p, 0) / words.length) * 1000) /
      1000
    : null;
  return { text, confidence, uncertain: [...new Set(uncertain)] };
}
