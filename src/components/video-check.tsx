"use client";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/domain/contracts";
import { api, ApiError } from "@/lib/client";
import { errorText } from "@/lib/i18n";
import { executionError } from "@/lib/execution-i18n";
import {
  VideoOverlay,
  type DrawMode,
  type OverlayLine,
  type OverlayPerson,
  type OverlayZone,
  type Pt,
} from "./video-overlay";

// T057 "check on video": people found and counted live on this device's camera or on a video
// file the user picks. The page grabs a frame, sends it (detector size, RGB) to this app's server
// and draws the boxes the server found on that very frame; a file is stepped frame by frame, so
// the picture and the boxes always belong together. Nothing is stored; the camera is opened only
// here and released on stop or when leaving the page.
type Frame = {
  index: number;
  ms: number;
  visible: number;
  zones: Record<string, number>;
  crossings: Record<string, { in: number; out: number }>;
  people: OverlayPerson[];
  totals: {
    unique: number;
    peak: number;
    averageSeconds: number | null;
    averageMs: number;
  };
  diagnosis: { withDetections: number; frames: number };
};
type Start = {
  id: string;
  fps: number;
  detector: { version: string; width: number; height: number };
};
const FPS = 5;
const defaultLine = (kind: "camera" | "file"): OverlayLine =>
  kind === "camera"
    ? // Facing the camera: walking across the picture from left to right counts as "in".
      {
        id: "entrance",
        name: "Линия",
        a: { x: 0.5, y: 0.05 },
        b: { x: 0.5, y: 0.95 },
        inSide: -1,
      }
    : // A camera above a door: moving up the picture (away from the camera) counts as "in".
      {
        id: "entrance",
        name: "Линия",
        a: { x: 0.02, y: 0.7 },
        b: { x: 0.98, y: 0.7 },
        inSide: -1,
      };
function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function VideoCheck({ base, locale }: { base: string; locale: Locale }) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  const video = useRef<HTMLVideoElement>(null),
    canvas = useRef<HTMLCanvasElement | null>(null),
    // The picture on screen is the analyzed frame itself, copied when it was sent: the boxes
    // that come back belong to exactly this picture (a live video would have moved on).
    shown = useRef<HTMLCanvasElement>(null),
    snapshot = useRef<HTMLCanvasElement | null>(null),
    stream = useRef<MediaStream | null>(null),
    fileUrl = useRef<string | null>(null),
    session = useRef<Start | null>(null),
    run = useRef(0);
  const [kind, setKind] = useState<"camera" | "file" | null>(null),
    [state, setState] = useState<
      "idle" | "starting" | "running" | "paused" | "done"
    >("idle"),
    [aspect, setAspect] = useState(16 / 9),
    [frame, setFrame] = useState<Frame | null>(null),
    [lines, setLines] = useState<OverlayLine[]>([]),
    [zones, setZones] = useState<OverlayZone[]>([]),
    [mode, setMode] = useState<DrawMode>("none"),
    [progress, setProgress] = useState<number | null>(null),
    [model, setModel] = useState(""),
    [problem, setProblem] = useState("");
  // Everything opened here is closed here: camera tracks, the file URL and the server session.
  const release = () => {
    run.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) {
      video.current.pause();
      video.current.srcObject = null;
      video.current.removeAttribute("src");
    }
    if (shown.current) shown.current.width = 0;
    if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
    fileUrl.current = null;
    const s = session.current;
    session.current = null;
    if (s) api(`${base}/video/live/${s.id}/stop`, "POST", {}).catch(() => {});
  };
  useEffect(() => release, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function open(
    k: "camera" | "file",
    file?: File,
    config?: { lines: OverlayLine[]; zones: OverlayZone[] },
  ) {
    release();
    setProblem("");
    setFrame(null);
    setProgress(null);
    setKind(k);
    setMode("none");
    setState("starting");
    const v = video.current!;
    try {
      if (k === "camera") {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("NO_CAMERA_API");
        stream.current = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        v.srcObject = stream.current;
        await v.play();
      } else {
        fileUrl.current = URL.createObjectURL(file!);
        v.src = fileUrl.current;
        await new Promise<void>((ok, fail) => {
          v.onloadeddata = () => ok();
          v.onerror = () => fail(new Error("VIDEO_FILE_UNREADABLE"));
        });
        v.pause();
      }
      setAspect(
        v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9,
      );
      const cfg = config ?? { lines: [defaultLine(k)], zones: [] };
      setLines(cfg.lines);
      setZones(cfg.zones);
      await begin(k, cfg);
    } catch (e) {
      release();
      setState("idle");
      const name = (e as DOMException).name;
      setProblem(
        name === "NotAllowedError"
          ? t(
              "Доступ к камере запрещён в браузере.",
              "Браузерде камераға рұқсат жоқ.",
            )
          : name === "NotReadableError"
            ? t(
                "Камера занята другой программой (например, обработчиком камеры). Закройте её или остановите обработчик.",
                "Камераны басқа бағдарлама пайдаланып жатыр (мысалы, камера өңдегіші). Оны жабыңыз.",
              )
            : name === "NotFoundError"
              ? t("Камера не найдена.", "Камера табылмады.")
              : e instanceof ApiError
                ? msg(e.code)
                : e instanceof Error && e.message === "VIDEO_FILE_UNREADABLE"
                  ? t(
                      "Браузер не может прочитать этот файл. Подойдёт MP4 (H.264) или WebM.",
                      "Браузер бұл файлды оқи алмайды. MP4 (H.264) немесе WebM қолайлы.",
                    )
                  : t(
                      "Не удалось начать проверку.",
                      "Тексеруді бастау мүмкін болмады.",
                    ),
      );
    }
  }
  // A new session (counters from zero) with the current line and zones.
  async function begin(
    k: "camera" | "file",
    cfg: { lines: OverlayLine[]; zones: OverlayZone[] },
  ) {
    const old = session.current;
    session.current = null;
    if (old)
      await api(`${base}/video/live/${old.id}/stop`, "POST", {}).catch(
        () => {},
      );
    const s = await api<Start>(`${base}/video/live`, "POST", {
      key: crypto.randomUUID(),
      kind: k,
      fps: FPS,
      lines: cfg.lines,
      zones: cfg.zones.map((z) => ({ ...z, kind: "presence" })),
    });
    session.current = s;
    setModel(s.detector.version);
    setFrame(null);
    const c = (canvas.current ??= document.createElement("canvas"));
    c.width = s.detector.width;
    c.height = s.detector.height;
    const v = video.current!;
    if (k === "file" && v.currentTime !== 0)
      await new Promise<void>((ok) => {
        v.onseeked = () => ok();
        v.currentTime = 0;
      });
    setState("running");
    loop(k, ++run.current);
  }
  async function analyze(id: number) {
    const s = session.current,
      v = video.current,
      c = canvas.current;
    if (!s || !v || !c || id !== run.current) return false;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const snap = (snapshot.current ??= document.createElement("canvas"));
    const scale = Math.min(1, 960 / (v.videoWidth || 960));
    snap.width = Math.round((v.videoWidth || 960) * scale);
    snap.height = Math.round((v.videoHeight || 540) * scale);
    // The same moment twice: a picture to show and the model's input (the whole frame stretched
    // to its square, as in the processor).
    snap.getContext("2d")!.drawImage(v, 0, 0, snap.width, snap.height);
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const rgba = ctx.getImageData(0, 0, c.width, c.height).data,
      rgb = new Uint8Array(c.width * c.height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const f = await api<Frame>(`${base}/video/live/${s.id}/frames`, "POST", {
      seq: Date.now(),
      rgb: base64(rgb),
    });
    if (id !== run.current) return false;
    const out = shown.current;
    if (out) {
      out.width = snap.width;
      out.height = snap.height;
      out.getContext("2d")!.drawImage(snap, 0, 0);
    }
    setFrame(f);
    return true;
  }
  async function loop(k: "camera" | "file", id: number) {
    const v = video.current!;
    try {
      if (k === "camera") {
        while (id === run.current) {
          const started = performance.now();
          if (!(await analyze(id))) return;
          const wait = 1000 / FPS - (performance.now() - started);
          if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
        }
        return;
      }
      // A file is stepped: seek, analyze that exact frame, show it with its boxes, next.
      while (id === run.current) {
        if (!(await analyze(id))) return;
        const next = v.currentTime + 1 / FPS;
        setProgress(v.duration ? Math.min(1, next / v.duration) : null);
        if (!v.duration || next >= v.duration) {
          setState("done");
          return;
        }
        await new Promise<void>((ok) => {
          v.onseeked = () => ok();
          v.currentTime = next;
        });
      }
    } catch (e) {
      if (id !== run.current) return;
      setProblem(msg(e instanceof ApiError ? e.code : "NETWORK"));
      setState("paused");
    }
  }
  const restart = (cfg: { lines: OverlayLine[]; zones: OverlayZone[] }) => {
    setLines(cfg.lines);
    setZones(cfg.zones);
    if (kind && session.current)
      begin(kind, cfg).catch((e) =>
        setProblem(msg(e instanceof ApiError ? e.code : "NETWORK")),
      );
  };
  const counts = lines.length ? frame?.crossings[lines[0].id] : undefined;
  const active = state === "running" || state === "paused" || state === "done";
  return (
    <section className="panel video-check">
      <h2>{t("Проверка на видео", "Бейнедегі тексеру")}</h2>
      <p>
        {t(
          "Встаньте перед камерой этого устройства или выберите запись из магазина: люди будут обведены рамками, счётчики обновляются сразу. Кадры обрабатываются на сервере TirekAI только для подсчёта и не сохраняются; во внешние сервисы не отправляются. Распознавания лиц нет.",
          "Осы құрылғының камерасының алдына тұрыңыз немесе дүкен жазбасын таңдаңыз: адамдар жақтаумен белгіленеді, есептегіштер бірден жаңарады. Кадрлар TirekAI серверінде тек санау үшін өңделеді және сақталмайды; сыртқы қызметтерге жіберілмейді. Бет тану жоқ.",
        )}
      </p>
      <div className="commerce-actions">
        <button
          type="button"
          className="primary-button"
          onClick={() => open("camera")}
          disabled={state === "starting"}
        >
          {t(
            "Включить камеру этого устройства",
            "Осы құрылғының камерасын қосу",
          )}
        </button>
        <label className="secondary-button file-button">
          {t("Выбрать видеофайл", "Бейнефайлды таңдау")}
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) open("file", file);
            }}
          />
        </label>
        {active && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              release();
              setState("idle");
              setKind(null);
            }}
          >
            {kind === "camera"
              ? t("Остановить и выключить камеру", "Тоқтатып, камераны өшіру")
              : t("Остановить", "Тоқтату")}
          </button>
        )}
      </div>
      {problem && (
        <p role="alert" className="commerce-alert">
          {problem}
        </p>
      )}
      <div className={`video-check-body${kind ? "" : " empty"}`}>
        <VideoOverlay
          aspect={aspect}
          people={frame?.people}
          lines={lines}
          zones={zones}
          mode={mode}
          locale={locale}
          label={t(
            "Кадр с отмеченными людьми, линией и зонами",
            "Адамдар, сызық және аймақтар белгіленген кадр",
          )}
          onLine={(a: Pt, b: Pt) => {
            setMode("none");
            restart({
              lines: [{ ...(lines[0] ?? defaultLine(kind ?? "file")), a, b }],
              zones,
            });
          }}
          onZone={(polygon: Pt[]) => {
            setMode("none");
            restart({
              lines,
              zones: [{ id: "zone", name: t("Зона", "Аймақ"), polygon }],
            });
          }}
        >
          <video ref={video} muted playsInline className="video-source" />
          <canvas ref={shown} className="video-media" />
          {!kind && (
            <div className="video-placeholder">
              {t(
                "Здесь появится изображение с отмеченными людьми.",
                "Мұнда адамдар белгіленген сурет пайда болады.",
              )}
            </div>
          )}
          {state === "starting" && (
            <div className="video-placeholder" aria-busy="true">
              {t(
                "Подключаем камеру и модель… первый запуск модели занимает до минуты.",
                "Камера мен модель қосылуда… модельдің алғашқы іске қосылуы бір минутқа дейін.",
              )}
            </div>
          )}
        </VideoOverlay>
        <div className="video-metrics" aria-live="polite">
          <div className="stat-card video-now">
            <div>
              <span>{t("Сейчас в кадре", "Қазір кадрда")}</span>
            </div>
            <strong>{frame ? frame.visible : "—"}</strong>
            <small>
              {frame
                ? t("людей на последнем кадре", "соңғы кадрдағы адамдар")
                : t("ещё нет кадров", "кадр әлі жоқ")}
            </small>
          </div>
          <div className="stat-card">
            <div>
              <span>{t("Вошли", "Кірді")}</span>
            </div>
            <strong>{counts ? counts.in : "—"}</strong>
            <small>
              {t("через линию по стрелке", "сызық арқылы, бағыт бойынша")}
            </small>
          </div>
          <div className="stat-card">
            <div>
              <span>{t("Вышли", "Шықты")}</span>
            </div>
            <strong>{counts ? counts.out : "—"}</strong>
            <small>{t("против стрелки", "бағытқа қарсы")}</small>
          </div>
          <div className="stat-card">
            <div>
              <span>{t("Разных людей", "Әртүрлі адамдар")}</span>
            </div>
            <strong>{frame ? frame.totals.unique : "—"}</strong>
            <small>
              {t(
                "за проверку; вернувшийся считается снова",
                "тексеру бойынша; қайтқан адам қайта саналады",
              )}
            </small>
          </div>
          <div className="stat-card">
            <div>
              <span>{t("Максимум одновременно", "Бір уақытта ең көбі")}</span>
            </div>
            <strong>{frame ? frame.totals.peak : "—"}</strong>
          </div>
          <div className="stat-card">
            <div>
              <span>{t("Среднее время в кадре", "Кадрдағы орташа уақыт")}</span>
            </div>
            <strong className="text-stat">
              {frame?.totals.averageSeconds != null
                ? `${frame.totals.averageSeconds} ${t("с", "с")}`
                : t("пока никто не ушёл", "әзірге ешкім кетпеді")}
            </strong>
          </div>
          {zones.length > 0 && (
            <div className="stat-card">
              <div>
                <span>{t("В зоне сейчас", "Қазір аймақта")}</span>
              </div>
              <strong>{frame ? (frame.zones.zone ?? 0) : "—"}</strong>
            </div>
          )}
        </div>
      </div>
      {active && (
        <div className="commerce-actions">
          <button
            type="button"
            className="secondary-button"
            aria-pressed={mode === "line"}
            onClick={() => setMode(mode === "line" ? "none" : "line")}
          >
            {t("Нарисовать линию входа", "Кіру сызығын салу")}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!lines.length}
            onClick={() =>
              restart({
                lines: lines.map((l) => ({
                  ...l,
                  inSide: (l.inSide * -1) as 1 | -1,
                })),
                zones,
              })
            }
          >
            {t("Поменять направление входа", "Кіру бағытын ауыстыру")}
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-pressed={mode === "zone"}
            onClick={() => setMode(mode === "zone" ? "none" : "zone")}
          >
            {t("Нарисовать зону", "Аймақ салу")}
          </button>
          {zones.length > 0 && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => restart({ lines, zones: [] })}
            >
              {t("Убрать зону", "Аймақты алу")}
            </button>
          )}
          {state === "paused" && (
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setProblem("");
                setState("running");
                loop(kind!, ++run.current);
              }}
            >
              {t("Продолжить", "Жалғастыру")}
            </button>
          )}
        </div>
      )}
      {frame && (
        <p className="video-footnote">
          {progress !== null &&
            `${t("Просмотрено", "Қаралды")} ${Math.round(progress * 100)}% · `}
          {t("Модель", "Модель")} {model} + ByteTrack ·{" "}
          {t(
            "экспериментально: точность на ваших камерах не измерена",
            "эксперименттік: сіздің камераларыңыздағы дәлдік өлшенбеген",
          )}{" "}
          · {frame.totals.averageMs} {t("мс на кадр", "мс/кадр")}
          {frame.diagnosis.frames >= 25 && frame.diagnosis.withDetections === 0
            ? ` · ${t("модель пока не видит людей: проверьте свет, расстояние и что человек в кадре", "модель әзірге адамдарды көрмейді: жарықты, қашықтықты тексеріңіз")}`
            : ""}
        </p>
      )}
    </section>
  );
}
