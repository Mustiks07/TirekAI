"use client";
import { useState, type ReactNode } from "react";

// T057: boxes, lines and zones drawn over a video frame, and drawing lines and zones by mouse or
// touch. Everything is in normalized frame coordinates (0..1), the same as the processor's, so a
// box sits on the same frame the detector analyzed whatever the displayed size.
export type Pt = { x: number; y: number };
export type OverlayLine = {
  id: string;
  name: string;
  a: Pt;
  b: Pt;
  inSide: 1 | -1;
};
export type OverlayZone = { id: string; name: string; polygon: Pt[] };
export type OverlayPerson = {
  id: number;
  box: [number, number, number, number] | null;
  counted: boolean;
  seen: boolean;
  seconds?: number;
};
export type DrawMode = "none" | "line" | "zone";
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
// Arrow from the "out" side to the "in" side, at the middle of the line.
function arrow(l: OverlayLine) {
  const mx = (l.a.x + l.b.x) / 2,
    my = (l.a.y + l.b.y) / 2,
    dx = l.b.x - l.a.x,
    dy = l.b.y - l.a.y,
    len = Math.hypot(dx, dy) || 1;
  // crossing() counts a move from the negative side as +1; inSide picks which side is "in".
  const nx = (-dy / len) * l.inSide,
    ny = (dx / len) * l.inSide,
    s = 0.06;
  return { x1: mx - nx * s, y1: my - ny * s, x2: mx + nx * s, y2: my + ny * s };
}
export function VideoOverlay({
  aspect,
  children,
  people = [],
  lines = [],
  zones = [],
  mode = "none",
  onLine,
  onZone,
  label,
  locale,
}: {
  aspect: number;
  children: ReactNode;
  people?: OverlayPerson[];
  lines?: OverlayLine[];
  zones?: OverlayZone[];
  mode?: DrawMode;
  onLine?: (a: Pt, b: Pt) => void;
  onZone?: (polygon: Pt[]) => void;
  label: string;
  locale: "ru" | "kk";
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [points, setPoints] = useState<Pt[]>([]);
  const at = (e: React.PointerEvent<HTMLDivElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return {
      x: Math.round(clamp((e.clientX - r.left) / r.width) * 1000) / 1000,
      y: Math.round(clamp((e.clientY - r.top) / r.height) * 1000) / 1000,
    };
  };
  const tap = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode === "none") return;
    e.preventDefault();
    const p = at(e);
    if (mode === "line") {
      if (!points.length) return setPoints([p]);
      setPoints([]);
      if (Math.hypot(p.x - points[0].x, p.y - points[0].y) >= 0.05)
        onLine?.(points[0], p);
      return;
    }
    setPoints((x) => [...x, p].slice(0, 20));
  };
  const drawing = mode !== "none";
  return (
    <div className="video-overlay-wrap">
      <div
        className={`video-stage${drawing ? " drawing" : ""}`}
        style={{ aspectRatio: String(aspect) }}
        onPointerDown={tap}
        role={drawing ? "application" : "img"}
        aria-label={label}
      >
        {children}
        <svg
          className="video-svg"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {zones.map((z) => (
            <polygon
              key={z.id}
              points={z.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
              className="video-zone"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {lines.map((l) => {
            const ar = arrow(l);
            return (
              <g key={l.id}>
                <line
                  x1={l.a.x}
                  y1={l.a.y}
                  x2={l.b.x}
                  y2={l.b.y}
                  className="video-line"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  {...ar}
                  className="video-arrow"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {points.length > 0 && (
            <polyline
              points={points.map((p) => `${p.x},${p.y}`).join(" ")}
              className="video-draft"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {lines.map((l) => {
          const ar = arrow(l);
          return (
            <span key={l.id}>
              <span
                className="video-tag line"
                style={{ left: pct(ar.x2), top: pct(ar.y2) }}
              >
                {t("вход", "кіру")}
              </span>
              <span
                className="video-tag zone"
                style={{
                  left: pct(Math.min(l.a.x, 0.85)),
                  top: pct(Math.min(l.a.y, 0.92)),
                }}
              >
                {l.name}
              </span>
            </span>
          );
        })}
        {zones.map((z) => (
          <span
            key={z.id}
            className="video-tag zone"
            style={{ left: pct(z.polygon[0].x), top: pct(z.polygon[0].y) }}
          >
            {z.name}
          </span>
        ))}
        {people
          .filter((p) => p.box)
          .map((p) => {
            const [x0, y0, x1, y1] = p.box!;
            return (
              <div
                key={p.id}
                className={`video-box${p.counted ? " counted" : ""}${p.seen ? "" : " lost"}`}
                style={{
                  left: pct(x0),
                  top: pct(y0),
                  width: pct(x1 - x0),
                  height: pct(y1 - y0),
                }}
              >
                <span>
                  {t("Человек", "Адам")} {p.id}
                  {p.seconds !== undefined && ` · ${Math.round(p.seconds)} с`}
                </span>
              </div>
            );
          })}
        {points.map((p, i) => (
          <span
            key={i}
            className="video-point"
            style={{ left: pct(p.x), top: pct(p.y) }}
          />
        ))}
      </div>
      {mode === "line" && (
        <p className="video-hint" role="status">
          {points.length
            ? t("Нажмите конец линии.", "Сызықтың соңғы нүктесін басыңыз.")
            : t(
                "Нажмите начало линии на кадре.",
                "Кадрдағы сызықтың басын басыңыз.",
              )}
        </p>
      )}
      {mode === "zone" && (
        <div className="video-hint">
          <span role="status">
            {t(
              `Нажимайте вершины зоны по кадру (отмечено ${points.length}).`,
              `Аймақ төбелерін кадрда басыңыз (белгіленді ${points.length}).`,
            )}
          </span>
          <button
            type="button"
            className="primary-button"
            disabled={points.length < 3}
            onClick={() => {
              onZone?.(points);
              setPoints([]);
            }}
          >
            {t("Замкнуть зону", "Аймақты жабу")}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setPoints([])}
          >
            {t("Начать заново", "Қайта бастау")}
          </button>
        </div>
      )}
    </div>
  );
}
