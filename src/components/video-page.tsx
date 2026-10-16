"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import { executionError } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

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
const pts = (s: string) =>
  s
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [x, y] = p.split(",").map((v) => Number(v.trim()));
      return { x, y };
    });
// T035–T038: camera sources, lines and zones, measured events and per-detector status.
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
  const [data, setData] = useState<{
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
    [draft, setDraft] = useState<{ lines: Line[]; zones: Zone[] }>({
      lines: [],
      zones: [],
    }),
    [day, setDay] = useState(new Date().toISOString().slice(0, 10)),
    [stats, setStats] = useState<{
      hours: Hour[];
      mixedVersions: boolean;
    } | null>(null),
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
    [runs, setRuns] = useState<
      {
        id: string;
        state: string;
        source_start: string;
        config_version: number;
        annotations: number;
        summary: {
          people?: { mode: "neural" | "motion"; detector: string | null };
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
    >([]),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [revision, setRevision] = useRevision();
  const refresh = () => setRevision((v) => v + 1);
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let live = true;
    const fail = (e: { code?: string }) =>
      live && setError(e.code || "INTERNAL_ERROR");
    api<typeof data>(`${base}/video/sources`)
      .then((v) => live && setData(v))
      .catch(fail);
    api<{ items: typeof detectors }>(`${base}/video/detectors`)
      .then((v) => live && setDetectors(v.items))
      .catch(fail);
    if (selected) {
      api<{ items: { version: number; lines: Line[]; zones: Zone[] }[] }>(
        `${base}/video/sources/${selected}/configs`,
      )
        .then((v) => {
          if (!live) return;
          const c = v.items[0] || null;
          setConfig(c);
          setDraft({ lines: c?.lines || [], zones: c?.zones || [] });
        })
        .catch(fail);
      const from = new Date(`${day}T00:00:00`),
        to = new Date(from.getTime() + 86_400_000);
      api<typeof stats>(
        `${base}/video/sources/${selected}/stats?from=${from.toISOString()}&to=${to.toISOString()}`,
      )
        .then((v) => live && setStats(v))
        .catch(fail);
      api<{ items: typeof signals }>(
        `${base}/video/sources/${selected}/signals`,
      )
        .then((v) => live && setSignals(v.items))
        .catch(fail);
      api<{ items: typeof runs }>(`${base}/video/sources/${selected}/runs`)
        .then((v) => live && setRuns(v.items))
        .catch(fail);
    }
    return () => {
      live = false;
    };
  }, [base, selected, day, revision]);
  const source = data?.items.find((s) => s.id === selected);
  const badge = (s: Source) =>
    s.mode === "recording"
      ? `${t("Запись", "Жазба")}${s.last_source_time ? ` · ${t("время источника", "дереккөз уақыты")} ${businessDate(new Date(s.last_source_time), locale, tz, true)}` : ""}`
      : s.signal_ok
        ? t("Прямой эфир", "Тікелей эфир")
        : t("Нет сигнала", "Сигнал жоқ");
  return (
    <div className="commerce-page">
      <section className="panel">
        <p>
          {t(
            "Видео обрабатывается отдельным обработчиком на устройстве рядом с камерой; сюда приходят только агрегированные события. Сырое видео не хранится. Личности, эмоции и чувствительные признаки не распознаются; событие: это сигнал для проверки человеком, а не обвинение. Пропуск данных не равен нулю посетителей.",
            "Бейне камераның жанындағы құрылғыдағы жеке өңдегіште өңделеді; мұнда тек жинақталған оқиғалар келеді. Шикі бейне сақталмайды. Тұлғалар, эмоциялар және сезімтал белгілер танылмайды; оқиға: адам тексеретін сигнал, айып емес. Деректің болмауы келушілердің нөлі емес.",
          )}
        </p>
        {error && (
          <p role="alert" className="commerce-alert">
            {msg(error)}
          </p>
        )}
        {!data ? (
          <p aria-busy="true">{t("Загрузка…", "Жүктелуде…")}</p>
        ) : (
          <ul className="today-list">
            {data.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setSelected(s.id)}
                >
                  {s.name}
                </button>{" "}
                <strong>{badge(s)}</strong> · {s.kind} ·{" "}
                {t("версия разметки", "белгілеу нұсқасы")}{" "}
                {s.config_version ?? "–"}
                {s.last_metrics?.fps !== undefined &&
                  ` · ${Math.round(s.last_metrics.fps)} ${t("кадр/с обработки", "кадр/с өңдеу")}, ${Math.round((s.last_metrics.latencyMs || 0) * 10) / 10} ${t("мс/кадр", "мс/кадр")}`}
              </li>
            ))}
          </ul>
        )}
        {data?.canWrite && (
          <ActionForm
            locale={locale}
            label={t("Добавить источник", "Дереккөз қосу")}
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
                  time: f(d, "time"),
                  auth: f(d, "auth"),
                  access: f(d, "access"),
                  note: "",
                },
              });
              refresh();
            }}
          >
            <Field label={t("Название", "Атауы")}>
              <input name="name" required minLength={2} maxLength={80} />
            </Field>
            <Field label={t("Филиал", "Филиал")}>
              <select name="branchId">
                {workspace.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Тип источника", "Дереккөз түрі")}>
              <select name="kind">
                <option value="file">
                  {t("Файл разрешённой записи", "Рұқсат етілген жазба файлы")}
                </option>
                <option value="webcam">{t("Веб-камера", "Веб-камера")}</option>
                <option value="network">
                  {t(
                    "Сетевая камера / регистратор (RTSP)",
                    "Желілік камера / тіркегіш (RTSP)",
                  )}
                </option>
              </select>
            </Field>
            <Field label={t("Протокол (паспорт)", "Хаттама (паспорт)")}>
              <input
                name="protocol"
                maxLength={40}
                placeholder="RTSP / file / USB"
              />
            </Field>
            <Field label={t("Модель устройства", "Құрылғы моделі")}>
              <input name="model" maxLength={80} />
            </Field>
            <Field label={t("Источник времени", "Уақыт көзі")}>
              <select name="time">
                {["unknown", "device", "ntp", "file"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field
              label={t(
                "Авторизация камеры (хранится на устройстве)",
                "Камера авторизациясы (құрылғыда сақталады)",
              )}
            >
              <select name="auth">
                {["unknown", "none", "basic", "digest", "on_device"].map(
                  (v) => (
                    <option key={v}>{v}</option>
                  ),
                )}
              </select>
            </Field>
            <Field label={t("Доступность", "Қолжетімділік")}>
              <select name="access">
                {["unknown", "local_network", "file", "usb"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
          </ActionForm>
        )}
      </section>
      {source && (
        <>
          <section className="panel">
            <h2>
              {source.name} · {badge(source)}
            </h2>
            <p>
              {t("Паспорт", "Паспорт")}:{" "}
              <code>{JSON.stringify(source.passport)}</code>
            </p>
            {data?.canManage && (
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  api<{ token: string }>(
                    `${base}/video/sources/${source.id}/token`,
                    "POST",
                    {},
                  )
                    .then((r) => setToken(r.token))
                    .catch((e) => setError(e.code))
                }
              >
                {t("Выдать токен обработчика", "Өңдегіш токенін беру")}
              </button>
            )}
            {token && (
              <p className="commerce-success">
                {t(
                  "Токен показан один раз. Запуск обработчика на устройстве:",
                  "Токен бір рет көрсетіледі. Құрылғыда өңдегішті іске қосу:",
                )}{" "}
                <code>{`VIDEO_DEVICE_TOKEN=${token} npm run video:processor -- --server ${typeof window === "undefined" ? "" : window.location.origin} --source ${source.id} --detector dfine-n --file <запись.mp4>`}</code>
              </p>
            )}
            <h3>
              {t("Линии и зоны", "Сызықтар мен аймақтар")} ·{" "}
              {t("версия", "нұсқа")} {config?.version ?? 0}
            </h3>
            <svg
              viewBox="0 0 320 180"
              role="img"
              aria-label={t(
                "Схема линий и зон",
                "Сызықтар мен аймақтар сызбасы",
              )}
              style={{
                width: "100%",
                maxWidth: 480,
                background: "var(--surface-2, #eee)",
              }}
            >
              {draft.zones.map((z) => (
                <polygon
                  key={z.id}
                  points={z.polygon
                    .map((p) => `${p.x * 320},${p.y * 180}`)
                    .join(" ")}
                  fill="rgba(80,140,220,.25)"
                  stroke="#3a6fb0"
                />
              ))}
              {draft.lines.map((l) => (
                <line
                  key={l.id}
                  x1={l.a.x * 320}
                  y1={l.a.y * 180}
                  x2={l.b.x * 320}
                  y2={l.b.y * 180}
                  stroke="#c0392b"
                  strokeWidth={3}
                />
              ))}
            </svg>
            <ul className="today-list">
              {draft.lines.map((l) => (
                <li key={l.id}>
                  {t("Линия", "Сызық")} {l.name} ({l.id}) · ({l.a.x}, {l.a.y}) →
                  ({l.b.x}, {l.b.y})
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        lines: d.lines.filter((x) => x.id !== l.id),
                      }))
                    }
                  >
                    {t("Убрать", "Алу")}
                  </button>
                </li>
              ))}
              {draft.zones.map((z) => (
                <li key={z.id}>
                  {t("Зона", "Аймақ")} {z.name} ({z.id}, {z.kind})
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        zones: d.zones.filter((x) => x.id !== z.id),
                      }))
                    }
                  >
                    {t("Убрать", "Алу")}
                  </button>
                </li>
              ))}
            </ul>
            {data?.canWrite && (
              <>
                <ActionForm
                  locale={locale}
                  label={t("Добавить линию в черновик", "Жобаға сызық қосу")}
                  submit={async (d) => {
                    const [a, b] = pts(f(d, "points"));
                    if (!a || !b) throw new Error("INVALID_INPUT");
                    setDraft((x) => ({
                      ...x,
                      lines: [
                        ...x.lines,
                        {
                          id: f(d, "id"),
                          name: f(d, "name"),
                          a,
                          b,
                          inSide: f(d, "inSide") === "-1" ? -1 : 1,
                        },
                      ],
                    }));
                  }}
                >
                  <Field label="id">
                    <input name="id" required pattern="[a-z][a-z0-9_]{0,30}" />
                  </Field>
                  <Field label={t("Название", "Атауы")}>
                    <input name="name" required maxLength={60} />
                  </Field>
                  <Field
                    label={t(
                      "Точки (x,y; x,y), доли кадра 0–1",
                      "Нүктелер (x,y; x,y), кадр үлесі 0–1",
                    )}
                  >
                    <input
                      name="points"
                      required
                      placeholder="0.5,0.05; 0.5,0.95"
                    />
                  </Field>
                  <Field label={t("Сторона «вход»", "«Кіру» жағы")}>
                    <select name="inSide">
                      <option value="1">
                        {t("справа налево", "оңнан солға")}
                      </option>
                      <option value="-1">
                        {t("слева направо", "солдан оңға")}
                      </option>
                    </select>
                  </Field>
                </ActionForm>
                <ActionForm
                  locale={locale}
                  label={t("Добавить зону в черновик", "Жобаға аймақ қосу")}
                  submit={async (d) => {
                    const polygon = pts(f(d, "points"));
                    setDraft((x) => ({
                      ...x,
                      zones: [
                        ...x.zones,
                        {
                          id: f(d, "id"),
                          name: f(d, "name"),
                          polygon,
                          kind: f(d, "kind"),
                          ...(f(d, "kind") === "queue"
                            ? {
                                queueMin: Number(f(d, "queueMin") || 3),
                                queueSeconds: Number(
                                  f(d, "queueSeconds") || 10,
                                ),
                              }
                            : {}),
                        },
                      ],
                    }));
                  }}
                >
                  <Field label="id">
                    <input name="id" required pattern="[a-z][a-z0-9_]{0,30}" />
                  </Field>
                  <Field label={t("Название", "Атауы")}>
                    <input name="name" required maxLength={60} />
                  </Field>
                  <Field
                    label={t(
                      "Вершины (x,y; …), не меньше трёх",
                      "Төбелер (x,y; …), кемінде үшеу",
                    )}
                  >
                    <input
                      name="points"
                      required
                      placeholder="0.04,0.1; 0.3,0.1; 0.3,0.9; 0.04,0.9"
                    />
                  </Field>
                  <Field label={t("Назначение", "Мақсаты")}>
                    <select name="kind">
                      <option value="presence">
                        {t("Присутствие", "Қатысу")}
                      </option>
                      <option value="queue">{t("Очередь", "Кезек")}</option>
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
                  </Field>
                  <Field
                    label={t(
                      "Очередь: от скольких человек",
                      "Кезек: неше адамнан",
                    )}
                  >
                    <input
                      name="queueMin"
                      inputMode="numeric"
                      defaultValue="3"
                    />
                  </Field>
                  <Field
                    label={t(
                      "Очередь: сколько секунд подряд",
                      "Кезек: қатарынан неше секунд",
                    )}
                  >
                    <input
                      name="queueSeconds"
                      inputMode="numeric"
                      defaultValue="10"
                    />
                  </Field>
                </ActionForm>
                <ActionForm
                  locale={locale}
                  label={t(
                    "Сохранить новую версию разметки",
                    "Белгілеудің жаңа нұсқасын сақтау",
                  )}
                  submit={async (d, key) => {
                    await api(
                      `${base}/video/sources/${source.id}/configs`,
                      "POST",
                      {
                        key,
                        version: config?.version ?? 0,
                        lines: draft.lines,
                        zones: draft.zones,
                        note: f(d, "note"),
                      },
                    );
                    refresh();
                  }}
                >
                  <Field label={t("Что изменено", "Не өзгертілді")}>
                    <input name="note" required minLength={3} maxLength={200} />
                  </Field>
                </ActionForm>
              </>
            )}
          </section>
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
                      {t("Зоны: в среднем видно", "Аймақтар: орташа көрінеді")}
                    </th>
                    <th>{t("Очереди", "Кезектер")}</th>
                    <th>{t("Версии", "Нұсқалар")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(stats?.hours || []).map((h) => (
                    <tr key={h.hour}>
                      <td>
                        {businessDate(new Date(h.hour), locale, tz, true)}
                      </td>
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
            <p>
              {t(
                "Повторное появление одного человека не считается уникальным посетителем. Покрытие меньше 100%: часть часа без данных.",
                "Бір адамның қайта пайда болуы бірегей келуші болып саналмайды. 100%-дан аз қамту: сағаттың бір бөлігі деректерсіз.",
              )}
            </p>
          </section>
          <section className="panel">
            <h2>{t("Сигналы для проверки", "Тексеруге арналған сигналдар")}</h2>
            {signals.length === 0 ? (
              <p>{t("Сигналов нет.", "Сигналдар жоқ.")}</p>
            ) : (
              <ul className="today-list">
                {signals.map((s) => (
                  <li key={s.id}>
                    {L(kinds[s.kind], s.kind)} ·{" "}
                    {businessDate(new Date(s.at), locale, tz, true)}
                    {s.zone_id && ` · ${s.zone_id}`}
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
          </section>
          <section className="panel">
            <h2>{t("Разметка и оценка", "Белгілеу және бағалау")}</h2>
            <ul className="today-list">
              {runs.map((r) => (
                <li key={r.id}>
                  {businessDate(new Date(r.source_start), locale, tz, true)} · v
                  {r.config_version} · {r.state} · {t("отметок", "белгі")}{" "}
                  {r.annotations} ·{" "}
                  {r.summary?.people?.mode === "neural"
                    ? `${t("люди: нейросеть", "адамдар: нейрожелі")} ${r.summary.people.detector} + ByteTrack`
                    : r.summary
                      ? t(
                          "люди: классический режим (движение)",
                          "адамдар: классикалық режим (қозғалыс)",
                        )
                      : t("сводки ещё нет", "қорытынды әлі жоқ")}
                </li>
              ))}
            </ul>
            {data?.canWrite && runs.length > 0 && (
              <>
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
                    label={t(
                      "Секунда от начала записи",
                      "Жазба басынан секунд",
                    )}
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
                        .filter(
                          (r) => r.annotations > 0 && r.state !== "running",
                        )
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
              </>
            )}
          </section>
        </>
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
    </div>
  );
}
