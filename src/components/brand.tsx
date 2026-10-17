import { useId } from "react";

// TirekAI brand: a column (тірек — support) with an orbit of connected points. Vector, so it
// stays sharp at any size; the same shapes are in public/icons/app.svg and src/app/icon.svg.
// `tone="dark"` is for dark backgrounds (navigation): the navy parts become light.
export function LogoMark({
  size = 32,
  tone = "light",
}: {
  size?: number;
  tone?: "light" | "dark";
}) {
  const id = useId().replace(/:/g, "");
  const solid = tone === "dark" ? "#E8F0F8" : "#0B1A33";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className="logo-mark"
    >
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14E0D4" />
          <stop offset="1" stopColor="#1E4BFF" />
        </linearGradient>
      </defs>
      {/* capital */}
      <path d="M4 11.5 24 4v11H6.5L4 13z" fill={solid} />
      <path d="M24 4l20 7.5V15H24z" fill={`url(#g${id})`} />
      {/* columns */}
      <path d="M9 18.5l6-1.8V42l-6-2z" fill={solid} />
      <path d="M19 16.5l5-1.6 5 1.6V44l-5 1.6-5-1.6z" fill={`url(#g${id})`} />
      <path d="M33 16.7l6 1.8V40l-6 2z" fill={solid} />
      {/* orbit with two connected points */}
      <path
        d="M10.5 31.5C5 37 4.5 41 9 41.5c5 .5 13-3.5 20-9.5 5-4.3 9-9 11-12.5"
        fill="none"
        stroke={`url(#g${id})`}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="40.5" cy="19" r="3.4" fill={`url(#g${id})`} />
      <circle cx="18" cy="38.2" r="2.6" fill={`url(#g${id})`} />
    </svg>
  );
}
export function Logo({
  tone = "light",
  size = 32,
  note,
}: {
  tone?: "light" | "dark";
  size?: number;
  note?: string;
}) {
  return (
    <span className={`logo logo-${tone}`}>
      <LogoMark size={size} tone={tone} />
      <span className="logo-text">
        <span className="brand-name">
          Tirek<span>AI</span>
        </span>
        {note && <small>{note}</small>}
      </span>
    </span>
  );
}
