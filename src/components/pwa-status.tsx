"use client";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/domain/contracts";
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
export function PwaStatus({ initialLocale }: { initialLocale: Locale }) {
  const [locale, setLocale] = useState(initialLocale),
    [offline, setOffline] = useState(false),
    [prompt, setPrompt] = useState<InstallEvent | null>(null),
    [update, setUpdate] = useState<ServiceWorker | null>(null),
    [failed, setFailed] = useState(false);
  const reload = useRef(false);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setLocale(document.documentElement.lang === "ru" ? "ru" : "kk"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
    });
    const online = () => setOffline(!navigator.onLine),
      install = (e: Event) => {
        e.preventDefault();
        setPrompt(e as InstallEvent);
      },
      installed = () => setPrompt(null);
    online();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    window.addEventListener("beforeinstallprompt", install);
    window.addEventListener("appinstalled", installed);
    let disposed = false;
    const changed = () => {
      if (reload.current) window.location.reload();
    };
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((reg) => {
          if (disposed) return;
          if (reg.waiting) setUpdate(reg.waiting);
          reg.addEventListener("updatefound", () => {
            const next = reg.installing;
            next?.addEventListener("statechange", () => {
              if (
                !disposed &&
                next.state === "installed" &&
                navigator.serviceWorker.controller
              )
                setUpdate(next);
            });
          });
        })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    }
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      window.removeEventListener("beforeinstallprompt", install);
      window.removeEventListener("appinstalled", installed);
      navigator.serviceWorker?.removeEventListener("controllerchange", changed);
    };
  }, []);
  const ru = locale === "ru";
  if (!offline && !prompt && !update && !failed) return null;
  return (
    <aside
      className="pwa-status"
      aria-label={ru ? "Состояние приложения" : "Қолданба күйі"}
    >
      {offline && (
        <p role="status">
          {ru
            ? "Нет сети. Отправка операций недоступна; перед повтором проверьте результат после подключения."
            : "Желі жоқ. Операцияларды жіберу қолжетімсіз; қайта жібермес бұрын байланыс орнағанда нәтижені тексеріңіз."}
        </p>
      )}
      {failed && (
        <p role="status">
          {ru
            ? "Офлайн-экран недоступен. Приложение продолжает работать через сеть."
            : "Офлайн экраны қолжетімсіз. Қолданба желі арқылы жұмыс істейді."}
        </p>
      )}
      {prompt && (
        <button
          type="button"
          onClick={async () => {
            try {
              await prompt.prompt();
              await prompt.userChoice;
            } finally {
              setPrompt(null);
            }
          }}
        >
          {ru ? "Установить приложение" : "Қолданбаны орнату"}
        </button>
      )}
      {update && (
        <div>
          <span>
            {ru
              ? "Доступна новая версия. Сохраните открытые формы перед обновлением."
              : "Жаңа нұсқа қолжетімді. Жаңарту алдында ашық пішіндерді сақтаңыз."}
          </span>
          <button
            type="button"
            onClick={() => {
              reload.current = true;
              update.postMessage({ type: "ACTIVATE_UPDATE" });
            }}
          >
            {ru ? "Обновить приложение" : "Қолданбаны жаңарту"}
          </button>
        </div>
      )}
    </aside>
  );
}
