import type { Locale } from "@/domain/contracts";

// T005/T052 main screen and application shell texts (RU/KK). Kazakh wording is written for
// owners and managers, not translated word for word.
const ru = {
  navToday: "Главная",
  navSales: "Продажи",
  navOrders: "Заказы",
  navInventory: "Склад",
  navFinance: "Финансы",
  navTeam: "Сотрудники",
  navVideo: "Камеры",
  navAssistant: "Помощник",
  navMore: "Ещё",
  navMain: "Основное",
  greetingMorning: "Доброе утро",
  greetingDay: "Добрый день",
  greetingEvening: "Добрый вечер",
  greetingNight: "Доброй ночи",
  allBranches: "Все филиалы",
  branch: "Филиал",
  notifications: "Уведомления",
  noNotifications: "Новых уведомлений нет",
  notifyApprovals: "ждут вашего согласования",
  notifyTasks: "просроченных задач",
  notifySituations: "открытых ситуаций",
  profile: "Профиль",
  logout: "Выйти",
  title: "Сегодня требуют внимания",
  updated: "Обновлено",
  justNow: "только что",
  minutesAgo: "мин назад",
  hoursAgo: "ч назад",
  refresh: "Обновить ситуации",
  refreshing: "Обновляем…",
  loading: "Загружаем данные…",
  loadError:
    "Не удалось загрузить данные. Проверьте соединение и попробуйте ещё раз.",
  retry: "Повторить",
  noAccess: "Нет доступа к этим данным для вашей роли.",
  calmTitle: "Сейчас ничего не требует срочного внимания",
  calmNote:
    "Ситуации появятся здесь, когда остатки, долги, закупки или задачи потребуют решения.",
  subtitleNone: "Нет ситуаций, которые могут повлиять на деньги и остатки",
  subtitle: (n: number) =>
    `${n} ${plural(n, "ситуация может", "ситуации могут", "ситуаций могут")} повлиять на деньги и остатки`,
  runsOut: (days: string | null) =>
    days === null
      ? "Товар заканчивается"
      : Number(days) <= 0
        ? "Товар закончился"
        : `Товар закончится через ${days} ${plural(Math.ceil(Number(days)), "день", "дня", "дней")}`,
  stockLeft: "Остаток",
  sales: "Продажи",
  perDay: "/день",
  delivery: "Поставка",
  days: (n: number) => `${n} ${plural(n, "день", "дня", "дней")}`,
  noData: "нет данных",
  recommendation: "Рекомендация",
  orderFrom: (q: string, unit: string, supplier: string) =>
    `Заказать ${q} ${unit} у «${supplier}»`,
  transferFrom: (q: string, unit: string, warehouse: string) =>
    `или переместить до ${q} ${unit} со склада «${warehouse}»`,
  costOrder: "Стоимость заказа",
  atRisk: "Можно сохранить выручку до",
  atRiskNote: "оценка: продажи, которые не состоятся до поставки",
  prepare: "Подготовить решение",
  showCalc: "Показать расчёт",
  open: "Открыть",
  prepared:
    "Черновик решения создан. Проверьте его и отправьте на согласование в разделе «Согласования».",
  openApprovals: "Открыть согласования",
  cannotPrepare: "Решение нельзя подготовить автоматически",
  calcTitle: "Как посчитано",
  calcPeriod: "Период",
  calcSources: "Источники",
  calcFormula: "Расчёт",
  calcAssumptions: "Допущения",
  calcMissing: "Чего не хватает",
  close: "Закрыть",
  assumptionsStock: [
    "Средние продажи: продажи этого товара с этого склада за период, за вычетом возвратов, делённые на число дней наблюдения.",
    "Цена: средняя фактическая цена выдачи за тот же период.",
    "Срок поставки: из настроек минимального остатка склада.",
    "Перемещение предлагается только со склада, где задан и превышен собственный минимум.",
  ],
  paymentTitle: (days: number | null, overdue: boolean) =>
    overdue
      ? "Платёж поставщику просрочен"
      : days === 0
        ? "Платёж поставщику сегодня"
        : `Платёж поставщику через ${days} ${plural(days ?? 0, "день", "дня", "дней")}`,
  purchasePayment: "Оплата закупки",
  afterPayment: "После оплаты останется",
  belowReserve: "Ниже минимального резерва",
  reserveNotSet: "Минимальный резерв не задан",
  morePayments: (n: number) =>
    `ещё ${n} ${plural(n, "платёж", "платежа", "платежей")} за 14 дней`,
  noPayments: "Платежей поставщикам на 14 дней нет.",
  slowTitle: (name: string) => `«${name}» продаёт медленнее`,
  evenTitle: "Филиалы продают сопоставимо",
  slowItem: "Товар",
  slowPeriod: (from: string) => `Продажи за 14 дней с ${from}`,
  viewItems: "Посмотреть товары",
  slowSingle:
    "Сравнение появится, когда товар продаётся минимум в двух филиалах.",
  noPrevious: "прошлый период без продаж",
  cashTitle: "Деньги на 14 дней",
  details: "Детализация",
  now: "Сейчас",
  minimum: "Минимум",
  lowest: "Самая низкая точка",
  plannedIn: "Ожидаемые поступления",
  plannedOut: "Платежи",
  cashNote:
    "Прогноз: текущий остаток счетов, ожидаемые оплаты клиентов по заказам, обязательства поставщикам и одобренные закупки. Аренда, зарплата и налоги не учитываются, если не внесены как обязательства.",
  cashChart: (from: string, to: string, low: string, at: string) =>
    `График остатка денег с ${from} по ${to}. Самая низкая точка ${low}, ${at}.`,
  setReserve: "Задать резерв",
  reserveLabel: "Минимальный резерв, ₸",
  save: "Сохранить",
  cancel: "Отмена",
  noAccounts: "Нет денежных счетов, поэтому остаток неизвестен.",
  noValue: "нет данных",
  branchesTitle: "Филиалы",
  allBranchesLink: "Все филиалы",
  revenueToday: "Выручка сегодня",
  change: "Изменение",
  vsYesterday: (time: string) => `с 00:00 до ${time} к тому же времени вчера`,
  noSalesToday: "Сегодня продаж ещё не было.",
  newSales: "новые продажи",
  eventsTitle: "Что изменилось сегодня",
  allEvents: "Все события",
  noEvents: "Сегодня изменений пока нет.",
  askPlaceholder: "Спросите TirekAI: что лучше сделать при бюджете 300 000 ₸?",
  askLabel: "Вопрос помощнику",
  send: "Отправить",
  allSituations: "Все ситуации, задачи и согласования",
  missing: {
    no_sales_history: "нет продаж за последние 28 дней",
    short_sales_history: "история продаж короче 7 дней, оценка предварительная",
    no_sale_price: "нет фактической цены продажи",
    no_lead_time: "не задан срок поставки",
    no_reorder_point: "не задан минимальный остаток",
    no_offer:
      "нет сопоставимого предложения поставщика: добавьте его в «Закупках»",
    no_reserve: "минимальный резерв не задан",
    no_accounts: "нет денежных счетов",
    single_branch: "товар продаётся только в одном филиале",
    no_previous_period:
      "в прошлом периоде продаж не было, процент не считается",
    no_sales_today: "сегодня продаж ещё не было",
  } as Record<string, string>,
  missingTitle: "Недостаточно данных для полного расчёта",
  whatToDo: "Что сделать",
};
const kk: typeof ru = {
  navToday: "Басты бет",
  navSales: "Сатылым",
  navOrders: "Тапсырыстар",
  navInventory: "Қойма",
  navFinance: "Қаржы",
  navTeam: "Қызметкерлер",
  navVideo: "Камералар",
  navAssistant: "Көмекші",
  navMore: "Тағы",
  navMain: "Негізгі",
  greetingMorning: "Қайырлы таң",
  greetingDay: "Қайырлы күн",
  greetingEvening: "Қайырлы кеш",
  greetingNight: "Қайырлы түн",
  allBranches: "Барлық филиал",
  branch: "Филиал",
  notifications: "Хабарламалар",
  noNotifications: "Жаңа хабарлама жоқ",
  notifyApprovals: "сіздің келісіміңізді күтеді",
  notifyTasks: "мерзімі өткен тапсырма",
  notifySituations: "ашық жағдай",
  profile: "Профиль",
  logout: "Шығу",
  title: "Бүгін назар аударуды қажет етеді",
  updated: "Жаңартылды",
  justNow: "жаңа ғана",
  minutesAgo: "мин бұрын",
  hoursAgo: "сағ бұрын",
  refresh: "Жағдайларды жаңарту",
  refreshing: "Жаңартылуда…",
  loading: "Деректер жүктелуде…",
  loadError:
    "Деректерді жүктеу мүмкін болмады. Байланысты тексеріп, қайталап көріңіз.",
  retry: "Қайталау",
  noAccess: "Сіздің рөліңізге бұл деректер қолжетімсіз.",
  calmTitle: "Қазір шұғыл назарды қажет ететін ештеңе жоқ",
  calmNote:
    "Қалдық, қарыз, сатып алу немесе тапсырма шешім қажет еткенде жағдайлар осында шығады.",
  subtitleNone: "Ақша мен қалдыққа әсер ететін жағдай жоқ",
  subtitle: (n: number) => `${n} жағдай ақша мен қалдыққа әсер етуі мүмкін`,
  runsOut: (days: string | null) =>
    days === null
      ? "Тауар таусылып барады"
      : Number(days) <= 0
        ? "Тауар таусылды"
        : `Тауар ${days} күннен кейін таусылады`,
  stockLeft: "Қалдық",
  sales: "Сатылым",
  perDay: "/күн",
  delivery: "Жеткізу",
  days: (n: number) => `${n} күн`,
  noData: "дерек жоқ",
  recommendation: "Ұсыныс",
  orderFrom: (q: string, unit: string, supplier: string) =>
    `«${supplier}» жеткізушісінен ${q} ${unit} тапсырыс беру`,
  transferFrom: (q: string, unit: string, warehouse: string) =>
    `немесе «${warehouse}» қоймасынан ${q} ${unit} дейін ауыстыру`,
  costOrder: "Тапсырыс құны",
  atRisk: "Сақтап қалуға болатын түсім",
  atRiskNote: "бағалау: жеткізуге дейін болмай қалатын сатылым",
  prepare: "Шешім дайындау",
  showCalc: "Есептеуді көрсету",
  open: "Ашу",
  prepared:
    "Шешім жобасы құрылды. Оны «Келісімдер» бөлімінде тексеріп, келісуге жіберіңіз.",
  openApprovals: "Келісімдерді ашу",
  cannotPrepare: "Шешімді автоматты түрде дайындау мүмкін емес",
  calcTitle: "Қалай есептелді",
  calcPeriod: "Кезең",
  calcSources: "Дереккөздер",
  calcFormula: "Есептеу",
  calcAssumptions: "Болжамдар",
  calcMissing: "Не жетіспейді",
  close: "Жабу",
  assumptionsStock: [
    "Орташа сатылым: осы тауардың осы қоймадан кезеңдегі сатылымы (қайтарымды шегергенде) бақылау күндеріне бөлінген.",
    "Баға: сол кезеңдегі нақты сатудың орташа бағасы.",
    "Жеткізу мерзімі: қойманың ең аз қалдық баптауынан.",
    "Ауыстыру тек өз ең аз қалдығы берілген және асып тұрған қоймадан ұсынылады.",
  ],
  paymentTitle: (days: number | null, overdue: boolean) =>
    overdue
      ? "Жеткізушіге төлем мерзімі өтті"
      : days === 0
        ? "Жеткізушіге төлем бүгін"
        : `Жеткізушіге төлем ${days} күннен кейін`,
  purchasePayment: "Сатып алу төлемі",
  afterPayment: "Төлемнен кейін қалады",
  belowReserve: "Ең аз резервтен төмен",
  reserveNotSet: "Ең аз резерв берілмеген",
  morePayments: (n: number) => `14 күнде тағы ${n} төлем`,
  noPayments: "14 күнге жеткізушілерге төлем жоқ.",
  slowTitle: (name: string) => `«${name}» баяу сатады`,
  evenTitle: "Филиалдар шамалас сатады",
  slowItem: "Тауар",
  slowPeriod: (from: string) => `${from} бастап 14 күндегі сатылым`,
  viewItems: "Тауарларды қарау",
  slowSingle: "Тауар кемінде екі филиалда сатылғанда салыстыру шығады.",
  noPrevious: "өткен кезеңде сатылым болмаған",
  cashTitle: "14 күнге ақша",
  details: "Толығырақ",
  now: "Қазір",
  minimum: "Ең аз",
  lowest: "Ең төменгі нүкте",
  plannedIn: "Күтілетін түсім",
  plannedOut: "Төлемдер",
  cashNote:
    "Болжам: шоттардағы қазіргі қалдық, тапсырыстар бойынша клиенттердің күтілетін төлемдері, жеткізушілерге міндеттемелер және мақұлданған сатып алулар. Жалдау, жалақы мен салық міндеттеме ретінде енгізілмесе ескерілмейді.",
  cashChart: (from: string, to: string, low: string, at: string) =>
    `${from} – ${to} аралығындағы ақша қалдығының графигі. Ең төменгі нүкте ${low}, ${at}.`,
  setReserve: "Резерв беру",
  reserveLabel: "Ең аз резерв, ₸",
  save: "Сақтау",
  cancel: "Бас тарту",
  noAccounts: "Ақша шоттары жоқ, сондықтан қалдық белгісіз.",
  noValue: "дерек жоқ",
  branchesTitle: "Филиалдар",
  allBranchesLink: "Барлық филиал",
  revenueToday: "Бүгінгі түсім",
  change: "Өзгеріс",
  vsYesterday: (time: string) =>
    `00:00–${time}, кешегі осы уақытпен салыстырғанда`,
  noSalesToday: "Бүгін әлі сатылым болған жоқ.",
  newSales: "жаңа сатылым",
  eventsTitle: "Бүгін не өзгерді",
  allEvents: "Барлық оқиға",
  noEvents: "Бүгін әзірге өзгеріс жоқ.",
  askPlaceholder: "TirekAI-дан сұраңыз: 300 000 ₸ бюджетпен не істеген дұрыс?",
  askLabel: "Көмекшіге сұрақ",
  send: "Жіберу",
  allSituations: "Барлық жағдай, тапсырма және келісім",
  missing: {
    no_sales_history: "соңғы 28 күнде сатылым жоқ",
    short_sales_history: "сатылым тарихы 7 күннен қысқа, бағалау алдын ала",
    no_sale_price: "нақты сату бағасы жоқ",
    no_lead_time: "жеткізу мерзімі берілмеген",
    no_reorder_point: "ең аз қалдық берілмеген",
    no_offer:
      "салыстырмалы жеткізуші ұсынысы жоқ: оны «Сатып алу» бөліміне қосыңыз",
    no_reserve: "ең аз резерв берілмеген",
    no_accounts: "ақша шоттары жоқ",
    single_branch: "тауар бір ғана филиалда сатылады",
    no_previous_period: "өткен кезеңде сатылым болмаған, пайыз есептелмейді",
    no_sales_today: "бүгін әлі сатылым болған жоқ",
  },
  missingTitle: "Толық есептеуге дерек жеткіліксіз",
  whatToDo: "Не істеу керек",
};
function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10,
    m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
export function dashboardText(locale: Locale) {
  return locale === "ru" ? ru : kk;
}
export type DashboardText = typeof ru;
// Greeting by the local hour of the organization.
export function greeting(locale: Locale, timeZone: string, now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
  const t = dashboardText(locale);
  return hour >= 5 && hour < 12
    ? t.greetingMorning
    : hour >= 12 && hour < 18
      ? t.greetingDay
      : hour >= 18 && hour < 23
        ? t.greetingEvening
        : t.greetingNight;
}
