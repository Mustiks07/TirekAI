"use client";
import { useEffect, useState } from "react";
import { branchName } from "@/lib/i18n";
import type { Locale, Workspace } from "@/domain/contracts";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import { executionError } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";
import { VideoCheck } from "./video-check";
import {
  VideoOverlay,
  type DrawMode,
  type OverlayPerson,
} from "./video-overlay";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Pt = { x: number; y: number };
type Line = { id: string; name: string; a: Pt; b: Pt; inSide: 1 | -1 };
type Zone = {
  id: string;
  name: string;
  polygon: Pt[];
  kind: string;
  queueMin?: number;
  queueSeconds?: number;
};
type Source = {
  id: string;
  name: string;
  kind: string;
  mode: string;
  passport: Record<string, unknown>;
  state: string;
  last_heartbeat_at: string | null;
  last_source_time: string | null;
  last_metrics: {
    fps?: number;
    latencyMs?: number;
    unusable?: number;
    frames?: number;
  } | null;
  has_device: boolean;
  signal_ok: boolean;
  config_version: number | null;
};
const runStates: Record<string, [string, string]> = {
  running: ["идёт", "жүріп жатыр"],
  ended: ["завершён", "аяқталды"],
  aborted: ["остановлен оператором", "оператор тоқтатты"],
  lost: ["сигнал потерян", "сигнал жоғалды"],
  error: ["ошибка", "қате"],
};
type Hour = {
  hour: string;
  coverage: number;
  versions: number[];
  lines: Record<string, { in: number; out: number }>;
  zones: Record<string, number | null>;
  queues: number;
};
const kinds: Record<string, [string, string]> = {
  queue_start: ["Очередь", "Кезек"],
  shelf_change_suspected: [
    "Изменение полки: проверить",
    "Сөре өзгерді: тексеру",
  ],
  signal_lost: ["Потеря сигнала", "Сигнал жоғалды"],
  workstation_state: ["Изменение рабочего места", "Жұмыс орны өзгерді"],
  gap: ["Нет данных (непригодные кадры)", "Дерек жоқ (жарамсыз кадрлар)"],
};
const detectorNames: Record<string, [string, string]> = {
  line_crossing: ["Пересечение линии", "Сызықты кесіп өту"],
  zone_occupancy: ["Видимые люди в зоне", "Аймақтағы көрінетін адамдар"],
  dwell: ["Время пребывания", "Болу уақыты"],
  queue: ["Очередь", "Кезек"],
  shelf_change: ["Изменение полки", "Сөре өзгерісі"],
  workstation_state: ["Состояние рабочего места", "Жұмыс орнының күйі"],
};
const reasons: Record<string, [string, string]> = {
  not_evaluated: [
    "оценка не проводилась: нужна размеченная выборка",
    "бағалау жүргізілмеді: белгіленген іріктеме қажет",
  ],
  thresholds_met_on_synthetic_only: [
    "пороги пройдены только на синтетическом наборе; нужны разрешённые реальные записи",
    "шектер тек синтетикалық жиында өтті; рұқсат етілген нақты жазбалар қажет",
  ],
  dataset_too_small: [
    "выборка меньше протокола (≥3 ролика, ≥100 событий)",
    "іріктеме хаттамадан аз (≥3 ролик, ≥100 оқиға)",
  ],
  thresholds_not_met: ["пороги не пройдены", "шектер өтпеді"],
  thresholds_met: [
    "пороги пройдены на реальных записях",
    "шектер нақты жазбаларда өтті",
  ],
};
type Live = {
  online: boolean;
  state: string;
  mode: string;
  hasDevice: boolean;
  lastHeartbeatAt: string | null;
  now: {
    at: string;
    visible: number;
    zones: Record<string, number>;
    crossings: Record<string, { in: number; out: number }>;
  } | null;
  metrics: {
    inputFps: number | null;
    processingFps: number | null;
    latencyMs: number | null;
    frames: number | null;
    unusable: number | null;
    diagnosis: {
      frames: number;
      usable: number;
      withDetections: number;
      withPeople: number;
      inZone: Record<string, number>;
      maxScore: number | null;
    } | null;
  } | null;
  today: { date: string; in: number; out: number };
  run: {
    id: string;
    state: string;
    startedAt: string;
    pipeline: Pipeline | null;
  } | null;
};
type Pipeline = {
  mode: "neural" | "motion";
  detector: string | null;
  tracker?: string;
  fps?: number;
};
type ViewFrame = {
  at: string;
  age_ms: number;
  image: string;
  width: number;
  height: number;
  visible: number;
  people: OverlayPerson[];
  zones: Record<string, number>;
  crossings: Record<string, { in: number; out: number }>;
} | null;
type Tab = "overview" | "check" | "settings" | "quality";
const modelName = (p: Pipeline | null | undefined, locale: Locale) => {
  const ru = locale === "ru";
  if (!p) return ru ? "нет данных о модели" : "модель туралы дерек жоқ";
  if (p.mode === "motion")
    return ru
      ? "классический режим (движение), выбран явно"
      : "классикалық режим (қозғалыс), анық таңдалған";
  const name = (p.detector || "").startsWith("rfdetr_nano")
    ? "RF-DETR Nano"
    : (p.detector || "").startsWith("rfdetr_small")
      ? "RF-DETR Small"
      : (p.detector || "").startsWith("dfine_s")
        ? "D-FINE-S"
        : (p.detector || "").startsWith("dfine_n")
          ? ru
            ? "D-FINE-N (снята: пропускала людей)"
            : "D-FINE-N (алынды: адамдарды өткізіп жіберді)"
          : p.detector || "?";
  return `${name} + ByteTrack`;
};
// Which link of frame → model → tracker → zone fails, in words for the operator.
const diagnosisText = (
  d: NonNullable<NonNullable<Live["metrics"]>["diagnosis"]>,
  locale: Locale,
) => {
  const ru = locale === "ru";
  if (!d.frames) return ru ? "кадры не поступают" : "кадрлар келмейді";
  if (!d.usable)
    return ru
      ? "все кадры непригодны (темно, пересвет или застывшее изображение)"
      : "барлық кадр жарамсыз (қараңғы, тым жарық немесе қатып қалған)";
  if (d.maxScore !== null && !d.withDetections)
    return ru
      ? "модель не находит людей в кадре: проверьте свет, расстояние, ракурс"
      : "модель кадрда адамдарды таппайды: жарықты, қашықтықты, бұрышты тексеріңіз";
  if (!d.withPeople)
    return ru
      ? "люди находятся, но не подтверждаются трекером"
      : "адамдар табылады, бірақ трекер растамайды";
  const z = Object.values(d.inZone);
  if (z.length && z.every((n) => n === 0))
    return ru
      ? "люди видны, но не попадают в зону: проверьте её границы"
      : "адамдар көрінеді, бірақ аймаққа түспейді: шекарасын тексеріңіз";
  return null;
};
// T035–T038/T057: cameras. Main screen: connection, live picture with people marked, people
// now, entries and exits today. Settings and quality evaluation are separate tabs.
export function VideoPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const L = (pair: [string, string] | undefined, fallback: string) =>
    pair?.[locale === "ru" ? 0 : 1] || fallback;
  const base = `organizations/${workspace.organization.id}`,
    tz = workspace.organization.timezone;
  const [tab, setTab] = useState<Tab>("overview"),
    [data, setData] = useState<{
      items: Source[];
      canWrite: boolean;
      canManage: boolean;
    } | null>(null),
    [selected, setSelected] = useState(""),
    [config, setConfig] = useState<{
      version: number;
      lines: Line[];
      zones: Zone[];
    } | null>(null),
    [live, setLive] = useState<Live | null>(null),
    [signals, setSignals] = useState<
      {
        id: string;
        kind: string;
        at: string;
        zone_id: string | null;
        reason: string | null;
        task_id: string | null;
      }[]
    >([]),
    [error, setError] = useState(""),
    [revision, setRevision] = useRevision();
  const refresh = () => setRevision((v) => v + 1);
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let alive = true;
    api<typeof data>(`${base}/video/sources`)
      .then((v) => {
        if (!alive || !v) return;
        setData(v);
        // The first camera is opened by default; the user switches in the selector.
        setSelected((s) => s || v.items[0]?.id || "");
      })
      .catch((e) => alive && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      alive = false;
    };
  }, [base, revision]);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const fail = (e: { code?: string }) =>
      alive && setError(e.code || "INTERNAL_ERROR");
    api<{ items: { version: number; lines: Line[]; zones: Zone[] }[] }>(
      `${base}/video/sources/${selected}/configs`,
    )
      .then((v) => alive && setConfig(v.items[0] || null))
      .catch(fail);
    api<{ items: typeof signals }>(`${base}/video/sources/${selected}/signals`)
      .then((v) => alive && setSignals(v.items))
      .catch(fail);
    // Connection and counts: every 5 s (the processor's heartbeat period).
    const load = () =>
      api<Live>(`${base}/video/sources/${selected}/live`)
        .then((v) => alive && setLive(v))
        .catch(fail);
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base, selected, revision]);
  const source = data?.items.find((s) => s.id === selected);
  const detected = (source?.passport?.detected || {}) as {
    width?: number;
    height?: number;
  };
  const aspect =
    detected.width && detected.height
      ? detected.width / detected.height
      : 16 / 9;
  const tabs: [Tab, string][] = [
    ["overview", t("Обзор", "Шолу")],
    ["check", t("Проверка на видео", "Бейнедегі тексеру")],
    ["settings", t("Настройки камеры", "Камера баптаулары")],
    ["quality", t("Качество и проверка", "Сапа және тексеру")],
  ];
  return (
    <div className="commerce-page video-page">
      <div
        className="inventory-tabs"
        role="group"
        aria-label={t("Разделы камер", "Камера бөлімдері")}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="commerce-alert">
          {msg(error)}
        </p>
      )}
      {tab === "check" && <VideoCheck base={base} locale={locale} />}
      {tab !== "check" && !data && (
        <p aria-busy="true">{t("Загрузка…", "Жүктелуде…")}</p>
      )}
      {tab !== "check" && data && (
        <section className="panel video-select">
          <Field label={t("Камера", "Камера")}>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!data.items.length}
            >
              {!data.items.length && (
                <option value="">
                  {t("Камер пока нет", "Камера әлі жоқ")}
                </option>
              )}
              {data.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          {source && live && <Connection live={live} locale={locale} tz={tz} />}
          {data.canWrite && (
            <details className="video-add">
              <summary>{t("Добавить камеру", "Камера қосу")}</summary>
              <AddSource
                base={base}
                locale={locale}
                workspace={workspace}
                done={refresh}
              />
            </details>
          )}
        </section>
      )}
      {tab === "overview" && data && !data.items.length && (
        <section className="panel">
          <p>
            {t(
              "Камер ещё нет. Добавьте камеру выше или откройте «Проверка на видео», чтобы сразу проверить подсчёт людей на камере этого устройства или на записи.",
              "Әзірге камера жоқ. Жоғарыда камера қосыңыз немесе адамдарды санауды осы құрылғының камерасында не жазбада бірден тексеру үшін «Бейнедегі тексеру» бөлімін ашыңыз.",
            )}
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={() => setTab("check")}
          >
            {t("Открыть проверку на видео", "Бейнедегі тексеруді ашу")}
          </button>
        </section>
      )}
      {tab === "overview" && source && (
        <Overview
          key={source.id}
          base={base}
          locale={locale}
          tz={tz}
          source={source}
          live={live}
          config={config}
          aspect={aspect}
          signals={signals}
          L={L}
          refresh={refresh}
          setError={setError}
        />
      )}
      {tab === "settings" && source && (
        <Settings
          // A saved version (or another camera) starts a fresh draft.
          key={`${source.id}:${config?.version ?? 0}`}
          base={base}
          locale={locale}
          source={source}
          live={live}
          config={config}
          aspect={aspect}
          canWrite={data!.canWrite}
          canManage={data!.canManage}
          refresh={refresh}
        />
      )}
      {tab === "quality" && (
        <Quality
          base={base}
          locale={locale}
          tz={tz}
          source={source || null}
          canWrite={!!data?.canWrite}
          L={L}
          setError={setError}
          revision={revision}
          refresh={refresh}
        />
      )}
    </div>
  );
}
function Connection({
  live,
  locale,
  tz,
}: {
  live: Live;
  locale: Locale;
  tz: string;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [state, tone] = !live.hasDevice
    ? [t("Обработчик не подключён", "Өңдегіш қосылмаған"), "off"]
    : live.online
      ? [
          live.mode === "recording"
            ? t("Онлайн: идёт обработка записи", "Онлайн: жазба өңделуде")
            : t("Онлайн: поток поступает", "Онлайн: ағын келіп жатыр"),
          "on",
        ]
      : live.state === "running"
        ? [t("Нет свежих данных", "Жаңа дерек жоқ"), "warn"]
        : live.state === "lost"
          ? [t("Сигнал потерян", "Сигнал жоғалды"), "warn"]
          : live.state === "error"
            ? [t("Ошибка обработчика", "Өңдегіш қатесі"), "warn"]
            : [t("Обработчик остановлен", "Өңдегіш тоқтатылған"), "off"];
  return (
    <p className={`video-connection ${tone}`} role="status">
      <span className="video-dot" aria-hidden="true" />
      <strong>{state}</strong>
      {live.lastHeartbeatAt && (
        <span>
          {" · "}
          {t("последний сигнал", "соңғы сигнал")}{" "}
          {businessDate(new Date(live.lastHeartbeatAt), locale, tz, true)}
        </span>
      )}
    </p>
  );
}
function Overview({
  base,
  locale,
  tz,
  source,
  live,
  config,
  aspect,
  signals,
  L,
  refresh,
  setError,
}: {
  base: string;
  locale: Locale;
  tz: string;
  source: Source;
  live: Live | null;
  config: { version: number; lines: Line[]; zones: Zone[] } | null;
  aspect: number;
  signals: {
    id: string;
    kind: string;
    at: string;
    zone_id: string | null;
    task_id: string | null;
  }[];
  L: (pair: [string, string] | undefined, fallback: string) => string;
  refresh: () => void;
  setError: (code: string) => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [viewing, setViewing] = useState(false),
    [view, setView] = useState<ViewFrame>(null),
    [waited, setWaited] = useState(0),
    [stopped, setStopped] = useState(false);
  // Viewing is explicit: frames are requested only while it is on, and the device sends them
  // only while someone asks. Nothing is recorded.
  useEffect(() => {
    if (!viewing) return;
    let alive = true;
    const started = Date.now();
    const poll = () =>
      api<{ frame: ViewFrame }>(
        `${base}/video/sources/${source.id}/view`,
        "POST",
        {},
      )
        .then((v) => {
          if (!alive) return;
          setView(v.frame);
          setWaited(Date.now() - started);
        })
        .catch((e) => alive && setError(e.code || "INTERNAL_ERROR"));
    poll();
    const timer = setInterval(poll, 700);
    return () => {
      alive = false;
      clearInterval(timer);
      api(`${base}/video/sources/${source.id}/unview`, "POST", {}).catch(
        () => {},
      );
    };
  }, [viewing, base, source.id, setError]);
  const now = view
    ? { visible: view.visible, crossings: view.crossings }
    : live?.now;
  const line = config?.lines[0];
  const diagnosis =
    live?.online && live.metrics?.diagnosis
      ? diagnosisText(live.metrics.diagnosis, locale)
      : null;
  return (
    <>
      <section className="panel">
        <div className="stat-grid video-counters" aria-live="polite">
          <div className="stat-card video-now">
            <div>
              <span>{t("Сейчас видно людей", "Қазір көрінетін адамдар")}</span>
            </div>
            {now ? (
              <strong>{now.visible}</strong>
            ) : (
              <strong className="text-stat">
                {t("Нет свежих данных", "Жаңа дерек жоқ")}
              </strong>
            )}
            <small>
              {now
                ? t("на последнем кадре", "соңғы кадрда")
                : t(
                    "обработчик не присылал данных последние 15 секунд",
                    "өңдегіш соңғы 15 секундта дерек жібермеді",
                  )}
            </small>
          </div>
          <div className="stat-card">
            <div>
              <span>{t("Вошли сегодня", "Бүгін кірді")}</span>
            </div>
            <strong>{line ? (live?.today.in ?? "—") : "—"}</strong>
            <small>
              {line
                ? `${t("через линию", "сызық арқылы")} «${line.name}»`
                : t("линия входа не задана", "кіру сызығы берілмеген")}
            </small>
          </div>
          <div className="stat-card">
            <div>
              <span>{t("Вышли сегодня", "Бүгін шықты")}</span>
            </div>
            <strong>{line ? (live?.today.out ?? "—") : "—"}</strong>
            <small>
              {live?.lastHeartbeatAt
                ? `${t("обновлено", "жаңартылды")} ${businessDate(new Date(live.lastHeartbeatAt), locale, tz, true)}`
                : t("данных ещё не было", "дерек әлі болған жоқ")}
            </small>
          </div>
        </div>
        <div className="commerce-actions">
          {!viewing ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setStopped(false);
                setView(null);
                setWaited(0);
                setViewing(true);
              }}
            >
              {t("Показать видео", "Бейнені көрсету")}
            </button>
          ) : (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setViewing(false);
                setView(null);
                setStopped(true);
              }}
            >
              {t("Скрыть видео", "Бейнені жасыру")}
            </button>
          )}
        </div>
        {stopped && !viewing && (
          <p role="status" className="video-footnote">
            {t(
              "Показ видео остановлен. Подсчёт продолжается на устройстве обработки, если оно работает.",
              "Бейне көрсету тоқтатылды. Өңдеу құрылғысы жұмыс істесе, санау жалғасады.",
            )}
          </p>
        )}
        {viewing && (
          <VideoOverlay
            aspect={aspect}
            people={view?.people}
            lines={config?.lines}
            zones={config?.zones}
            locale={locale}
            label={t(
              "Последний обработанный кадр с отмеченными людьми",
              "Адамдар белгіленген соңғы өңделген кадр",
            )}
          >
            {view ? (
              <img
                className="video-media"
                src={`data:image/jpeg;base64,${view.image}`}
                alt=""
              />
            ) : (
              <div className="video-placeholder" aria-busy={waited < 6000}>
                {waited < 6000
                  ? t("Ждём кадр от обработчика…", "Өңдегіштен кадр күтілуде…")
                  : !live?.online
                    ? t(
                        "Нет свежих данных: обработчик не запущен или связь потеряна.",
                        "Жаңа дерек жоқ: өңдегіш іске қосылмаған немесе байланыс жоғалды.",
                      )
                    : t(
                        "Обработчик работает, но не присылает кадры: обновите его до текущей версии или уберите --no-preview.",
                        "Өңдегіш жұмыс істейді, бірақ кадр жібермейді: оны жаңартыңыз немесе --no-preview алып тастаңыз.",
                      )}
              </div>
            )}
          </VideoOverlay>
        )}
        <p className="video-footnote">
          {t("Люди", "Адамдар")}: {modelName(live?.run?.pipeline, locale)} ·{" "}
          {t(
            "экспериментально, точность на этой камере не измерена",
            "эксперименттік, бұл камерадағы дәлдік өлшенбеген",
          )}
          {live?.metrics?.inputFps != null &&
            ` · ${t("поступает", "келеді")} ${live.metrics.inputFps} ${t("кадр/с", "кадр/с")}, ${t("обработка до", "өңдеу")} ${Math.round(live.metrics.processingFps || 0)} ${t("кадр/с", "кадр/с")}, ${Math.round(live.metrics.latencyMs || 0)} ${t("мс/кадр", "мс/кадр")}`}
        </p>
        {diagnosis && (
          <p className="commerce-alert" role="status">
            {t("Диагностика", "Диагностика")}: {diagnosis}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>{t("Сигналы для проверки", "Тексеруге арналған сигналдар")}</h2>
        {signals.length === 0 ? (
          <p>{t("Сигналов нет.", "Сигналдар жоқ.")}</p>
        ) : (
          <ul className="today-list">
            {signals.slice(0, 8).map((s) => (
              <li key={s.id}>
                {L(kinds[s.kind], s.kind)} ·{" "}
                {businessDate(new Date(s.at), locale, tz, true)}
                {s.zone_id &&
                  ` · ${config?.zones.find((z) => z.id === s.zone_id)?.name ?? s.zone_id}`}
                {s.task_id ? (
                  ` · ${t("задача создана", "тапсырма құрылды")}`
                ) : s.kind !== "gap" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      api(`${base}/video/signals/${s.id}/task`, "POST", {
                        key: crypto.randomUUID(),
                        title: `${L(kinds[s.kind], s.kind)}: ${t("проверить на месте", "орнында тексеру")}`,
                        assigneeId: null,
                      })
                        .then(refresh)
                        .catch((e) => setError(e.code))
                    }
                  >
                    {t("Создать задачу", "Тапсырма құру")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="video-footnote">
          {t(
            "Лица, личности и эмоции не распознаются. Сигнал: повод проверить на месте, а не обвинение. Пропуск данных не равен нулю посетителей.",
            "Беттер, тұлғалар және эмоциялар танылмайды. Сигнал: орнында тексеруге себеп, айып емес. Деректің болмауы келушілердің нөлі емес.",
          )}
        </p>
      </section>
    </>
  );
}
function AddSource({
  base,
  locale,
  workspace,
  done,
}: {
  base: string;
  locale: Locale;
  workspace: Workspace;
  done: () => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  return (
    <ActionForm
      locale={locale}
      label={t("Добавить камеру", "Камера қосу")}
      submit={async (d, key) => {
        await api(`${base}/video/sources`, "POST", {
          key,
          branchId: f(d, "branchId"),
          name: f(d, "name"),
          kind: f(d, "kind"),
          mode: f(d, "kind") === "file" ? "recording" : "live",
          passport: {
            protocol: f(d, "protocol"),
            model: f(d, "model"),
            time: "unknown",
            auth: "unknown",
            access: "unknown",
            note: "",
          },
        });
        done();
      }}
    >
      <Field label={t("Название", "Атауы")}>
        <input name="name" required minLength={2} maxLength={80} />
      </Field>
      <Field label={t("Филиал", "Филиал")}>
        <select name="branchId">
          {workspace.branches.map((b) => (
            <option key={b.id} value={b.id}>
              {branchName(b.name, locale)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("Тип", "Түрі")}>
        <select name="kind" defaultValue="webcam">
          <option value="webcam">
            {t("Веб-камера компьютера", "Компьютер веб-камерасы")}
          </option>
          <option value="network">
            {t("IP-камера / регистратор (RTSP)", "IP-камера / тіркегіш (RTSP)")}
          </option>
          <option value="file">
            {t("Разрешённая запись (файл)", "Рұқсат етілген жазба (файл)")}
          </option>
        </select>
      </Field>
      <Field
        label={t(
          "Модель устройства (необязательно)",
          "Құрылғы моделі (міндетті емес)",
        )}
      >
        <input name="model" maxLength={80} />
      </Field>
      <Field label={t("Протокол (необязательно)", "Хаттама (міндетті емес)")}>
        <input name="protocol" maxLength={40} placeholder="RTSP / USB / file" />
      </Field>
    </ActionForm>
  );
}
function Settings({
  base,
  locale,
  source,
  live,
  config,
  aspect,
  canWrite,
  canManage,
  refresh,
}: {
  base: string;
  locale: Locale;
  source: Source;
  live: Live | null;
  config: { version: number; lines: Line[]; zones: Zone[] } | null;
  aspect: number;
  canWrite: boolean;
  canManage: boolean;
  refresh: () => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [draft, setDraft] = useState<{ lines: Line[]; zones: Zone[] }>({
      lines: config?.lines || [],
      zones: config?.zones || [],
    }),
    [mode, setMode] = useState<DrawMode>("none"),
    [token, setToken] = useState(""),
    [confirm, setConfirm] = useState(false),
    [problem, setProblem] = useState(""),
    [snapshot, setSnapshot] = useState<ViewFrame>(null);
  const nextId = (prefix: string, taken: string[]) => {
    let i = 1;
    while (taken.includes(`${prefix}_${i}`)) i++;
    return `${prefix}_${i}`;
  };
  const passport = source.passport as Record<string, unknown> & {
    detected?: Record<string, unknown>;
  };
  const issue = (replace: boolean) =>
    api<{ token: string }>(`${base}/video/sources/${source.id}/token`, "POST", {
      replace,
    })
      .then((r) => {
        setToken(r.token);
        setConfirm(false);
        refresh();
      })
      .catch((e) =>
        e.code === "VIDEO_TOKEN_REPLACE_CONFIRM"
          ? setConfirm(true)
          : setProblem(e.code),
      );
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const input =
    source.kind === "webcam"
      ? `--webcam "video=${t("ИМЯ КАМЕРЫ", "КАМЕРА АТЫ")}"`
      : source.kind === "network"
        ? "--rtsp"
        : `--file ${t("запись.mp4", "жазба.mp4")}`;
  return (
    <>
      <section className="panel">
        <h2>{t("Подключение обработчика", "Өңдегішті қосу")}</h2>
        <dl className="video-passport">
          <dt>{t("Тип", "Түрі")}</dt>
          <dd>
            {source.kind === "webcam"
              ? t("веб-камера", "веб-камера")
              : source.kind === "network"
                ? t("IP-камера / регистратор", "IP-камера / тіркегіш")
                : t("запись", "жазба")}
          </dd>
          {typeof passport.model === "string" && passport.model && (
            <>
              <dt>{t("Модель", "Модель")}</dt>
              <dd>{passport.model}</dd>
            </>
          )}
          {passport.detected?.width != null && (
            <>
              <dt>{t("Изображение", "Сурет")}</dt>
              <dd>
                {String(passport.detected.width)}×
                {String(passport.detected.height)}
                {passport.detected.fps != null &&
                  `, ${String(passport.detected.fps)} ${t("кадр/с", "кадр/с")}`}
              </dd>
            </>
          )}
          <dt>{t("Токен обработчика", "Өңдегіш токені")}</dt>
          <dd>
            {source.has_device
              ? t("выдан", "берілген")
              : t("не выдан", "берілмеген")}
          </dd>
        </dl>
        {canManage && !token && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => issue(false)}
          >
            {source.has_device
              ? t("Перевыпустить токен", "Токенді қайта беру")
              : t("Выдать токен обработчика", "Өңдегіш токенін беру")}
          </button>
        )}
        {confirm && (
          <div
            className="commerce-alert"
            role="alertdialog"
            aria-label={t("Перевыпуск токена", "Токенді қайта беру")}
          >
            <p>
              {t(
                "Старый токен перестанет работать сразу. Обработчик, который сейчас запущен с ним, получит отказ, остановится и освободит камеру; запустите его заново с новым токеном.",
                "Ескі токен бірден жұмысын тоқтатады. Онымен іске қосылған өңдегіш бас тарту алып, тоқтайды және камераны босатады; оны жаңа токенмен қайта іске қосыңыз.",
              )}
            </p>
            <div className="commerce-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => issue(true)}
              >
                {t(
                  "Перевыпустить и отключить старый",
                  "Қайта беріп, ескісін өшіру",
                )}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirm(false)}
              >
                {t("Отмена", "Бас тарту")}
              </button>
            </div>
          </div>
        )}
        {token && (
          <div className="commerce-success">
            <p>
              {t(
                "Токен показан один раз. Сохраните его на устройстве обработки (в переменной окружения), не пересылайте в чатах. Запуск:",
                "Токен бір рет көрсетіледі. Оны өңдеу құрылғысында (орта айнымалысында) сақтаңыз, чатта жібермеңіз. Іске қосу:",
              )}
            </p>
            <code className="video-command">{`VIDEO_DEVICE_TOKEN=${token} npm run video:processor -- --server ${origin} --source ${source.id} ${input}`}</code>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setToken("")}
            >
              {t("Скрыть токен", "Токенді жасыру")}
            </button>
          </div>
        )}
        {problem && (
          <p role="alert" className="commerce-alert">
            {executionError(problem, locale) || errorText(problem, locale)}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>
          {t("Линии и зоны", "Сызықтар мен аймақтар")} · {t("версия", "нұсқа")}{" "}
          {config?.version ?? 0}
        </h2>
        <p>
          {t(
            "Рисуйте прямо на кадре: линия входа — два нажатия, зона — вершины и «Замкнуть». Стрелка показывает направление «вход».",
            "Тікелей кадрға салыңыз: кіру сызығы — екі басу, аймақ — төбелер және «Жабу». Көрсеткі «кіру» бағытын көрсетеді.",
          )}
        </p>
        {live?.online && (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              api<{ frame: ViewFrame }>(
                `${base}/video/sources/${source.id}/view`,
                "POST",
                {},
              )
                .then(async (v) => {
                  // The first request asks the device for frames; the next one usually has it.
                  if (!v.frame) {
                    await new Promise((ok) => setTimeout(ok, 2500));
                    v = await api<{ frame: ViewFrame }>(
                      `${base}/video/sources/${source.id}/view`,
                      "POST",
                      {},
                    );
                  }
                  setSnapshot(v.frame);
                })
                .finally(() =>
                  api(
                    `${base}/video/sources/${source.id}/unview`,
                    "POST",
                    {},
                  ).catch(() => {}),
                )
            }
          >
            {t(
              "Взять кадр с камеры как фон",
              "Камерадан кадрды фон ретінде алу",
            )}
          </button>
        )}
        <VideoOverlay
          aspect={aspect}
          lines={draft.lines}
          zones={draft.zones}
          mode={canWrite ? mode : "none"}
          locale={locale}
          label={t("Схема линий и зон", "Сызықтар мен аймақтар сызбасы")}
          onLine={(a, b) => {
            setMode("none");
            setDraft((d) => {
              const id = nextId(
                "line",
                [...d.lines, ...d.zones].map((x) => x.id),
              );
              return {
                ...d,
                lines: [
                  ...d.lines,
                  { id, name: t("Вход", "Кіру"), a, b, inSide: 1 },
                ],
              };
            });
          }}
          onZone={(polygon) => {
            setMode("none");
            setDraft((d) => {
              const id = nextId(
                "zone",
                [...d.lines, ...d.zones].map((x) => x.id),
              );
              return {
                ...d,
                zones: [
                  ...d.zones,
                  { id, name: t("Зона", "Аймақ"), polygon, kind: "presence" },
                ],
              };
            });
          }}
        >
          {snapshot ? (
            <img
              className="video-media"
              src={`data:image/jpeg;base64,${snapshot.image}`}
              alt=""
            />
          ) : (
            <div className="video-placeholder board">
              {t("Схема кадра (без изображения)", "Кадр сызбасы (суретсіз)")}
            </div>
          )}
        </VideoOverlay>
        {canWrite && (
          <div className="commerce-actions">
            <button
              type="button"
              className="secondary-button"
              aria-pressed={mode === "line"}
              onClick={() => setMode(mode === "line" ? "none" : "line")}
            >
              {t("Нарисовать линию", "Сызық салу")}
            </button>
            <button
              type="button"
              className="secondary-button"
              aria-pressed={mode === "zone"}
              onClick={() => setMode(mode === "zone" ? "none" : "zone")}
            >
              {t("Нарисовать зону", "Аймақ салу")}
            </button>
          </div>
        )}
        <ul className="video-draft-list">
          {draft.lines.map((l, i) => (
            <li key={l.id}>
              <label>
                {t("Линия", "Сызық")}
                <input
                  value={l.name}
                  maxLength={60}
                  disabled={!canWrite}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      lines: d.lines.map((x, k) =>
                        k === i ? { ...x, name: e.target.value } : x,
                      ),
                    }))
                  }
                />
              </label>
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        lines: d.lines.map((x, k) =>
                          k === i
                            ? { ...x, inSide: (x.inSide * -1) as 1 | -1 }
                            : x,
                        ),
                      }))
                    }
                  >
                    {t("Поменять направление", "Бағытты ауыстыру")}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        lines: d.lines.filter((_, k) => k !== i),
                      }))
                    }
                  >
                    {t("Убрать", "Алу")}
                  </button>
                </>
              )}
            </li>
          ))}
          {draft.zones.map((z, i) => (
            <li key={z.id}>
              <label>
                {t("Зона", "Аймақ")}
                <input
                  value={z.name}
                  maxLength={60}
                  disabled={!canWrite}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      zones: d.zones.map((x, k) =>
                        k === i ? { ...x, name: e.target.value } : x,
                      ),
                    }))
                  }
                />
              </label>
              <label>
                {t("Назначение", "Мақсаты")}
                <select
                  value={z.kind}
                  disabled={!canWrite}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      zones: d.zones.map((x, k) =>
                        k === i
                          ? {
                              ...x,
                              kind: e.target.value,
                              ...(e.target.value === "queue"
                                ? {
                                    queueMin: x.queueMin ?? 3,
                                    queueSeconds: x.queueSeconds ?? 10,
                                  }
                                : {
                                    queueMin: undefined,
                                    queueSeconds: undefined,
                                  }),
                            }
                          : x,
                      ),
                    }))
                  }
                >
                  <option value="presence">{t("Присутствие", "Қатысу")}</option>
                  <option value="queue">
                    {t("Очередь (от 3 человек 10 с)", "Кезек (3 адамнан 10 с)")}
                  </option>
                  <option value="shelf">
                    {t("Полка (экспериментально)", "Сөре (эксперименттік)")}
                  </option>
                  <option value="workstation">
                    {t(
                      "Рабочее место (экспериментально)",
                      "Жұмыс орны (эксперименттік)",
                    )}
                  </option>
                </select>
              </label>
              {canWrite && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      zones: d.zones.filter((_, k) => k !== i),
                    }))
                  }
                >
                  {t("Убрать", "Алу")}
                </button>
              )}
            </li>
          ))}
        </ul>
        {canWrite && (
          <ActionForm
            locale={locale}
            label={t(
              "Сохранить новую версию разметки",
              "Белгілеудің жаңа нұсқасын сақтау",
            )}
            submit={async (d, key) => {
              await api(`${base}/video/sources/${source.id}/configs`, "POST", {
                key,
                version: config?.version ?? 0,
                lines: draft.lines.map((l) => ({
                  ...l,
                  name: l.name.trim() || l.id,
                })),
                zones: draft.zones.map(({ queueMin, queueSeconds, ...z }) => ({
                  ...z,
                  name: z.name.trim() || z.id,
                  ...(z.kind === "queue"
                    ? {
                        queueMin: queueMin ?? 3,
                        queueSeconds: queueSeconds ?? 10,
                      }
                    : {}),
                })),
                note: f(d, "note"),
              });
              refresh();
            }}
          >
            <Field label={t("Что изменено", "Не өзгертілді")}>
              <input name="note" required minLength={3} maxLength={200} />
            </Field>
          </ActionForm>
        )}
        <p className="video-footnote">
          {t(
            "Новая версия применяется при следующем запуске обработчика. Часы с разными версиями не сравниваются.",
            "Жаңа нұсқа өңдегіш келесі іске қосылғанда қолданылады. Әртүрлі нұсқадағы сағаттар салыстырылмайды.",
          )}
        </p>
      </section>
    </>
  );
}
function Quality({
  base,
  locale,
  tz,
  source,
  canWrite,
  L,
  setError,
  revision,
  refresh,
}: {
  base: string;
  locale: Locale;
  tz: string;
  source: Source | null;
  canWrite: boolean;
  L: (pair: [string, string] | undefined, fallback: string) => string;
  setError: (code: string) => void;
  revision: number;
  refresh: () => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10)),
    [stats, setStats] = useState<{
      hours: Hour[];
      mixedVersions: boolean;
    } | null>(null),
    [runs, setRuns] = useState<
      {
        id: string;
        state: string;
        source_start: string;
        config_version: number;
        annotations: number;
        pipeline: Pipeline | null;
        summary: {
          people?: Pipeline;
          inputFps?: number;
          fps?: number;
          latencyMs?: number;
        } | null;
      }[]
    >([]),
    [detectors, setDetectors] = useState<
      {
        detector: string;
        version: string;
        status: string;
        reason: string;
        lab: { metrics: Record<string, number | null> } | null;
      }[]
    >([]);
  useEffect(() => {
    let alive = true;
    const fail = (e: { code?: string }) =>
      alive && setError(e.code || "INTERNAL_ERROR");
    api<{ items: typeof detectors }>(`${base}/video/detectors`)
      .then((v) => alive && setDetectors(v.items))
      .catch(fail);
    if (source) {
      const from = new Date(`${day}T00:00:00`),
        to = new Date(from.getTime() + 86_400_000);
      api<typeof stats>(
        `${base}/video/sources/${source.id}/stats?from=${from.toISOString()}&to=${to.toISOString()}`,
      )
        .then((v) => alive && setStats(v))
        .catch(fail);
      api<{ items: typeof runs }>(`${base}/video/sources/${source.id}/runs`)
        .then((v) => alive && setRuns(v.items))
        .catch(fail);
    }
    return () => {
      alive = false;
    };
  }, [base, source, day, revision, setError]);
  return (
    <>
      {source && (
        <section className="panel">
          <h2>{t("Запуски обработчика", "Өңдегішті іске қосулар")}</h2>
          <ul className="today-list">
            {runs.map((r) => (
              <li key={r.id}>
                {businessDate(new Date(r.source_start), locale, tz, true)} · v
                {r.config_version} · {L(runStates[r.state], r.state)} ·{" "}
                {t("люди", "адамдар")}:{" "}
                {modelName(r.pipeline ?? r.summary?.people, locale)}
                {r.summary?.inputFps != null &&
                  ` · ${t("поступало", "келді")} ${r.summary.inputFps} ${t("кадр/с", "кадр/с")}, ${t("обработка до", "өңдеу")} ${Math.round(r.summary.fps || 0)} ${t("кадр/с", "кадр/с")}`}
                {` · ${t("отметок", "белгі")} ${r.annotations}`}
              </li>
            ))}
          </ul>
          {!runs.length && (
            <p>{t("Запусков ещё не было.", "Іске қосу әлі болған жоқ.")}</p>
          )}
          {canWrite && runs.length > 0 && (
            <details>
              <summary>
                {t(
                  "Разметка правды для оценки",
                  "Бағалауға арналған шындық белгілері",
                )}
              </summary>
              <ActionForm
                locale={locale}
                label={t("Добавить отметку (правду)", "Белгі (шындық) қосу")}
                submit={async (d) => {
                  await api(
                    `${base}/video/runs/${f(d, "runId")}/annotations`,
                    "POST",
                    {
                      kind: f(d, "kind"),
                      atSeconds: Number(f(d, "at")),
                      untilSeconds: f(d, "until")
                        ? Number(f(d, "until"))
                        : null,
                      line: f(d, "line") || null,
                      zone: f(d, "zone") || null,
                      direction: f(d, "direction") || null,
                    },
                  );
                  refresh();
                }}
              >
                <Field label={t("Запуск", "Іске қосу")}>
                  <select name="runId">
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {businessDate(
                          new Date(r.source_start),
                          locale,
                          tz,
                          true,
                        )}{" "}
                        · v{r.config_version}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("Событие", "Оқиға")}>
                  <select name="kind">
                    <option value="line_cross">
                      {t("Пересечение линии", "Сызықты кесіп өту")}
                    </option>
                    <option value="queue">
                      {t("Очередь (интервал)", "Кезек (аралық)")}
                    </option>
                  </select>
                </Field>
                <Field
                  label={t("Секунда от начала записи", "Жазба басынан секунд")}
                >
                  <input name="at" required inputMode="decimal" />
                </Field>
                <Field
                  label={t(
                    "До секунды (для очереди)",
                    "Секундқа дейін (кезек үшін)",
                  )}
                >
                  <input name="until" inputMode="decimal" />
                </Field>
                <Field label={t("Линия (id)", "Сызық (id)")}>
                  <input name="line" pattern="[a-z][a-z0-9_]{0,30}" />
                </Field>
                <Field label={t("Зона (id)", "Аймақ (id)")}>
                  <input name="zone" pattern="[a-z][a-z0-9_]{0,30}" />
                </Field>
                <Field label={t("Направление", "Бағыт")}>
                  <select name="direction">
                    <option value="">–</option>
                    <option value="in">{t("вход", "кіру")}</option>
                    <option value="out">{t("выход", "шығу")}</option>
                  </select>
                </Field>
              </ActionForm>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  api(`${base}/video/evaluations`, "POST", {
                    key: crypto.randomUUID(),
                    runIds: runs
                      .filter((r) => r.annotations > 0 && r.state !== "running")
                      .map((r) => r.id),
                  })
                    .then(refresh)
                    .catch((e) => setError(e.code))
                }
              >
                {t(
                  "Оценить по размеченным запускам",
                  "Белгіленген іске қосулар бойынша бағалау",
                )}
              </button>
            </details>
          )}
        </section>
      )}
      {source && (
        <section className="panel">
          <h2>{t("Измерения по часам", "Сағат бойынша өлшемдер")}</h2>
          <label>
            {t("День", "Күн")}{" "}
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
          {stats?.mixedVersions && (
            <p className="commerce-alert">
              {t(
                "В этом дне разные версии разметки: часы с разными версиями не сравнимы.",
                "Бұл күнде белгілеудің әртүрлі нұсқалары бар: әртүрлі нұсқадағы сағаттар салыстырылмайды.",
              )}
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Час", "Сағат")}</th>
                  <th>{t("Покрытие", "Қамту")}</th>
                  <th>{t("Линии: вход / выход", "Сызықтар: кіру / шығу")}</th>
                  <th>
                    {t("Зоны: среднее за час", "Аймақтар: сағаттық орташа")}
                  </th>
                  <th>{t("Очереди", "Кезектер")}</th>
                  <th>{t("Версии", "Нұсқалар")}</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.hours || []).map((h) => (
                  <tr key={h.hour}>
                    <td>{businessDate(new Date(h.hour), locale, tz, true)}</td>
                    <td>{Math.round(h.coverage * 100)}%</td>
                    {h.coverage === 0 ? (
                      <td colSpan={3}>{t("нет данных", "дерек жоқ")}</td>
                    ) : (
                      <>
                        <td>
                          {Object.entries(h.lines)
                            .map(([l, v]) => `${l}: ${v.in} / ${v.out}`)
                            .join(", ") || "0 / 0"}
                        </td>
                        <td>
                          {Object.entries(h.zones)
                            .map(([z, v]) => `${z}: ${v ?? "–"}`)
                            .join(", ") || "–"}
                        </td>
                        <td>{h.queues}</td>
                      </>
                    )}
                    <td>{h.versions.join(", ") || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="video-footnote">
            {t(
              "Среднее за час — это не текущее число людей. Повторное появление одного человека не считается уникальным посетителем. Покрытие меньше 100%: часть часа без данных.",
              "Сағаттық орташа — қазіргі адам саны емес. Бір адамның қайта пайда болуы бірегей келуші болып саналмайды. 100%-дан аз қамту: сағаттың бір бөлігі деректерсіз.",
            )}
          </p>
        </section>
      )}
      <section className="panel">
        <h2>
          {t("Детекторы и их статус", "Детекторлар және олардың мәртебесі")}
        </h2>
        <ul className="today-list">
          {detectors.map((d) => (
            <li key={d.detector} className="today-situation">
              <strong>
                {L(detectorNames[d.detector], d.detector)} ·{" "}
                {d.status === "validated"
                  ? t("подтверждён", "расталған")
                  : t("экспериментальный", "эксперименттік")}
              </strong>
              <span>
                {d.version} · {L(reasons[d.reason], d.reason)}
              </span>
              {d.lab && (
                <span>
                  {t("Лаборатория (синтетика)", "Зертхана (синтетика)")}:{" "}
                  {d.lab.metrics.maxCountError !== null &&
                    d.lab.metrics.maxCountError !== undefined &&
                    `${t("макс. ошибка счёта", "санаудың ең үлкен қатесі")} ${Math.round(d.lab.metrics.maxCountError * 1000) / 10}%`}
                  {d.lab.metrics.queueF1 !== null &&
                    d.lab.metrics.queueF1 !== undefined &&
                    `F1 ${Math.round(d.lab.metrics.queueF1 * 100) / 100}`}
                  {` · ${Math.round(d.lab.metrics.meanFps || 0)} ${t("кадр/с", "кадр/с")}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
