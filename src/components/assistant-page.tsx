"use client";
import { useEffect, useRef, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { AssistantMessage, AssistantStatus } from "@/domain/assistant";
import { api, ApiError } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { executionError, stateText } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Conversation = {
  id: string;
  locale: Locale;
  title: string;
  messages: AssistantMessage[];
};
export function AssistantPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`;
  const [status, setStatus] = useState<AssistantStatus | null>(null),
    [conversations, setConversations] = useState<
      { id: string; title: string }[]
    >([]),
    [current, setCurrent] = useState<Conversation | null>(null),
    [text, setText] = useState(""),
    [answerLocale, setAnswerLocale] = useState<Locale>(locale),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useRevision();
  const pending = useRef<{ text: string; key: string } | null>(null);
  const message = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<AssistantStatus>(`${base}/assistant`),
      api<{ items: { id: string; title: string }[] }>(
        `${base}/assistant/conversations`,
      ),
    ])
      .then(([s, c]) => live && (setStatus(s), setConversations(c.items)))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
  }, [base, revision]);
  async function open(id: string) {
    setCurrent(
      await api<Conversation>(`${base}/assistant/conversations/${id}`),
    );
  }
  async function send() {
    if (!text.trim() || busy) return;
    // The same key is reused on retry of the same text, so a repeated click never asks twice.
    if (pending.current?.text !== text)
      pending.current = { text, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const r = await api<{ conversationId: string }>(
        `${base}/assistant/messages`,
        "POST",
        {
          key: pending.current.key,
          conversationId: current?.id || null,
          locale: answerLocale,
          text,
        },
      );
      pending.current = null;
      setText("");
      await open(r.conversationId);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "INTERNAL_ERROR");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="commerce-page assistant-page">
      {error && (
        <p role="alert" className="commerce-alert">
          {message(error)}
        </p>
      )}
      {status && (
        <details className="panel assistant-settings">
          <summary>
            {t(
              "Состояние помощника и настройки",
              "Көмекшінің күйі мен баптаулары",
            )}
          </summary>
          <p>
            {t("Модель", "Модель")}: {stateText(status.provider.status, locale)}
            {status.provider.model && ` · ${status.provider.model}`} ·{" "}
            {t("распознавание речи", "сөйлеуді тану")}:{" "}
            {stateText(status.speech.status, locale)}
          </p>
          <p>
            {t("Использовано в этом месяце", "Осы айда пайдаланылды")}:{" "}
            {status.usage.month_tokens.toLocaleString("ru-RU")} /{" "}
            {status.settings.monthly_token_budget.toLocaleString("ru-RU")}{" "}
            {t("токенов", "токен")} · {status.usage.month_calls}{" "}
            {t("вызовов", "шақыру")}
            {status.usage.last_error &&
              ` · ${t("последняя ошибка", "соңғы қате")}: ${message(status.usage.last_error) || status.usage.last_error}`}
          </p>
          <p>
            {t(
              "Использовано с резервом на текущие и неподтверждённые запросы",
              "Ағымдағы және расталмаған сұраулар резервімен пайдаланылды",
            )}
            : {status.usage.committed_tokens.toLocaleString("ru-RU")}{" "}
            {t("токенов", "токен")}.
          </p>
          <p>
            {t(
              "Помощник читает данные и считает только через инструменты приложения с вашими правами, может создать черновик закупки, но не оплачивает, не согласует и не отправляет сообщения. Тексты документов он воспринимает как данные.",
              "Көмекші деректерді тек сіздің құқықтарыңызбен қосымша құралдары арқылы оқып, есептейді, сатып алу жобасын құра алады, бірақ төлемейді, келіспейді және хабар жібермейді. Құжат мәтіндерін деректер ретінде қабылдайды.",
            )}
          </p>
          {status.provider.status === "not_configured" && (
            <p className="commerce-alert">
              {t(
                "AI-провайдер не подключён на сервере. Все разделы и формы работают без помощника.",
                "AI провайдері серверде қосылмаған. Барлық бөлімдер мен формалар көмекшісіз жұмыс істейді.",
              )}
            </p>
          )}
          {status.canConfigure && (
            <details>
              <summary>
                {t("Настройки и бюджет", "Баптаулар мен бюджет")}
              </summary>
              <ActionForm
                key={status.settings.version}
                locale={locale}
                label={t("Сохранить", "Сақтау")}
                submit={async (d) => {
                  await api(`${base}/assistant/settings`, "POST", {
                    version: status.settings.version,
                    enabled: d.has("enabled"),
                    voiceEnabled: d.has("voice"),
                    monthlyTokenBudget: Number(f(d, "budget")),
                    maxOutputTokens: Number(f(d, "max")),
                  });
                  setRevision((v) => v + 1);
                }}
              >
                <label className="commerce-check">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={status.settings.enabled}
                  />
                  {t("Помощник включён", "Көмекші қосулы")}
                </label>
                <label className="commerce-check">
                  <input
                    type="checkbox"
                    name="voice"
                    defaultChecked={status.settings.voice_enabled}
                  />
                  {t(
                    "Разрешить голос (дорогая функция)",
                    "Дауысқа рұқсат (қымбат функция)",
                  )}
                </label>
                <Field
                  label={t("Бюджет токенов в месяц", "Айлық токен бюджеті")}
                >
                  <input
                    name="budget"
                    type="number"
                    min={0}
                    defaultValue={status.settings.monthly_token_budget}
                    required
                  />
                </Field>
                <Field
                  label={t("Максимум токенов ответа", "Жауаптың ең көп токені")}
                >
                  <input
                    name="max"
                    type="number"
                    min={256}
                    max={16000}
                    defaultValue={status.settings.max_output_tokens}
                    required
                  />
                </Field>
              </ActionForm>
            </details>
          )}
        </details>
      )}
      <section className="panel assistant-conversation">
        <div className="assistant-heading">
          <span className="ai-label">AI</span>
          <h2>{t("Помощник TirekAI", "TirekAI көмекшісі")}</h2>
        </div>
        {status?.provider.status === "not_configured" && (
          <p className="commerce-alert">
            {t(
              "Помощник пока не подключён. История разговоров доступна.",
              "Көмекші әзірге қосылмаған. Әңгімелер тарихы қолжетімді.",
            )}
          </p>
        )}
        <div className="commerce-toolbar">
          <Field label={t("Разговор", "Әңгіме")}>
            <select
              value={current?.id || ""}
              onChange={(e) =>
                e.target.value
                  ? open(e.target.value).catch((x) => setError(x.code))
                  : setCurrent(null)
              }
            >
              <option value="">{t("Новый разговор", "Жаңа әңгіме")}</option>
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Язык ответа", "Жауап тілі")}>
            <select
              value={answerLocale}
              onChange={(e) => setAnswerLocale(e.target.value as Locale)}
            >
              <option value="kk">Қазақша</option>
              <option value="ru">Русский</option>
            </select>
          </Field>
        </div>
        <div className="assistant-log" aria-live="polite">
          {!current?.messages.length && (
            <div className="assistant-empty">
              <h3>{t("С чего начнём?", "Неден бастаймыз?")}</h3>
              <p>
                {t(
                  "Задайте вопрос о бизнесе. Помощник использует доступные вам данные и показывает источники.",
                  "Бизнес туралы сұрақ қойыңыз. Көмекші сізге қолжетімді деректерді пайдаланып, дереккөздерді көрсетеді.",
                )}
              </p>
              <div className="assistant-suggestions">
                {[
                  t(
                    "Какие заказы требуют внимания?",
                    "Қай тапсырыстар назар аударуды қажет етеді?",
                  ),
                  t("Что заканчивается на складе?", "Қоймада не азайып жатыр?"),
                  t(
                    "Какие задачи просрочены?",
                    "Қай тапсырмалардың мерзімі өтті?",
                  ),
                ].map((prompt) => (
                  <button
                    className="secondary-button"
                    key={prompt}
                    onClick={() => setText(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {current?.messages.map((m) => (
            <article key={m.id} className={`assistant-message ${m.role}`}>
              <strong>
                {m.role === "user" ? t("Вы", "Сіз") : t("Помощник", "Көмекші")}
              </strong>
              {m.role === "assistant" && m.status !== "ok" && (
                <p className="commerce-alert">
                  {stateText(m.status, locale)}
                  {m.error_code && `: ${message(m.error_code)}`}
                </p>
              )}
              {m.content && <p className="assistant-text">{m.content}</p>}
              {m.unverified_numbers.length > 0 && (
                <p className="commerce-alert">
                  {t(
                    "Эти числа не найдены в данных инструментов, проверьте их",
                    "Бұл сандар құрал деректерінде табылмады, тексеріңіз",
                  )}
                  : {m.unverified_numbers.join(", ")}
                </p>
              )}
              {m.tool_calls.length > 0 && (
                <small>
                  {t("Использовано", "Пайдаланылды")}:{" "}
                  {m.tool_calls
                    .map(
                      (c) =>
                        `${c.name}${c.ok ? "" : ` (${message(c.error || "") || c.error})`}`,
                    )
                    .join(", ")}
                </small>
              )}
              {m.sources.length > 0 && (
                <details>
                  <summary>{t("Источники", "Дереккөздер")}</summary>
                  <ul className="today-list">
                    {m.sources.map((s, i) => (
                      <li key={i}>
                        {s.type}: {s.label}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          ))}
        </div>
        <Field label={t("Вопрос или поручение", "Сұрақ немесе тапсырма")}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={2000}
          />
        </Field>
        <div className="commerce-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy || !text.trim()}
            onClick={send}
          >
            {busy
              ? t("Готовим ответ…", "Жауап дайындалуда…")
              : t("Отправить", "Жіберу")}
          </button>
        </div>
        {status && (
          <Voice
            base={base}
            locale={locale}
            enabled={status.settings.voice_enabled}
            speech={status.speech.status}
            onTranscript={(v) => setText(v)}
          />
        )}
      </section>
    </div>
  );
}
// T028: push-to-talk. The microphone is requested only after an explicit click, stays visibly
// indicated, and every track is stopped on stop, cancel or leaving the page.
function Voice({
  base,
  locale,
  enabled,
  speech,
  onTranscript,
}: {
  base: string;
  locale: Locale;
  enabled: boolean;
  speech: string;
  onTranscript: (v: string) => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [state, setState] = useState<"idle" | "recording" | "sending">("idle"),
    [problem, setProblem] = useState(""),
    [voiceLocale, setVoiceLocale] = useState<Locale>(locale);
  const recorder = useRef<MediaRecorder | null>(null),
    chunks = useRef<Blob[]>([]),
    cancelled = useRef(false);
  const release = () => {
    recorder.current?.stream.getTracks().forEach((track) => track.stop());
    recorder.current = null;
  };
  useEffect(() => release, []);
  async function start() {
    setProblem("");
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setProblem(
        t(
          "Браузер не поддерживает запись звука.",
          "Браузер дыбыс жазуды қолдамайды.",
        ),
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      cancelled.current = false;
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        release();
        if (cancelled.current) return setState("idle");
        setState("sending");
        try {
          const blob = new Blob(chunks.current, {
            type: r.mimeType || "audio/webm",
          });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (const b of bytes) bin += String.fromCharCode(b);
          const mime =
            (
              ["audio/webm", "audio/ogg", "audio/wav", "audio/mp4"] as const
            ).find((m) => blob.type.startsWith(m)) || "audio/webm";
          const result = await api<{ text: string; uncertain: string[] }>(
            `${base}/assistant/transcriptions`,
            "POST",
            {
              key: crypto.randomUUID(),
              locale: voiceLocale,
              mime,
              audio: btoa(bin),
            },
          );
          // The transcript is only placed into the editable field; the user confirms and sends it.
          onTranscript(result.text);
          if (result.uncertain.length)
            setProblem(
              `${t("Проверьте неуверенно распознанное", "Сенімсіз танылғанды тексеріңіз")}: ${result.uncertain.join(", ")}`,
            );
        } catch (e) {
          const code = e instanceof ApiError ? e.code : "NETWORK";
          setProblem(executionError(code, locale) || errorText(code, locale));
        } finally {
          setState("idle");
        }
      };
      recorder.current = r;
      r.start();
      setState("recording");
      // Hard stop after 60 seconds so the microphone never stays open.
      setTimeout(
        () => recorder.current === r && r.state === "recording" && r.stop(),
        60_000,
      );
    } catch (e) {
      const name = (e as DOMException).name;
      setProblem(
        name === "NotAllowedError"
          ? t(
              "Доступ к микрофону запрещён в браузере.",
              "Браузерде микрофонға рұқсат жоқ.",
            )
          : name === "NotFoundError"
            ? t("Микрофон не найден.", "Микрофон табылмады.")
            : t(
                "Не удалось включить микрофон.",
                "Микрофонды қосу мүмкін болмады.",
              ),
      );
      release();
    }
  }
  return (
    <fieldset className="voice-panel">
      <legend>{t("Голос", "Дауыс")}</legend>
      {!enabled ? (
        <p>
          {t(
            "Голос выключен в настройках помощника.",
            "Дауыс көмекші баптауларында өшірілген.",
          )}
        </p>
      ) : (
        <>
          {speech === "not_configured" && (
            <p className="commerce-alert">
              {t(
                "Распознавание речи не подключено: запись будет отклонена сервером и не сохранится.",
                "Сөйлеуді тану қосылмаған: жазбаны сервер қабылдамайды және сақталмайды.",
              )}
            </p>
          )}
          <Field label={t("Язык речи", "Сөйлеу тілі")}>
            <select
              value={voiceLocale}
              onChange={(e) => setVoiceLocale(e.target.value as Locale)}
              disabled={state !== "idle"}
            >
              <option value="kk">Қазақша</option>
              <option value="ru">Русский</option>
            </select>
          </Field>
          <div className="commerce-actions">
            {state === "idle" && (
              <button
                type="button"
                className="secondary-button"
                onClick={start}
              >
                {t("Записать вопрос", "Сұрақты жазу")}
              </button>
            )}
            {state === "recording" && (
              <>
                <span role="status" className="recording-indicator">
                  ●{" "}
                  {t(
                    "Микрофон включён, идёт запись",
                    "Микрофон қосулы, жазылуда",
                  )}
                </span>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => recorder.current?.stop()}
                >
                  {t("Остановить и распознать", "Тоқтату және тану")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => (
                    (cancelled.current = true),
                    recorder.current?.stop()
                  )}
                >
                  {t("Отменить запись", "Жазбадан бас тарту")}
                </button>
              </>
            )}
            {state === "sending" && (
              <span role="status">{t("Распознаём…", "Танылуда…")}</span>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled
              title={t(
                "Нужен подключённый провайдер живой речи",
                "Тірі сөйлеу провайдері қажет",
              )}
            >
              {t(
                "Живой разговор: провайдер не подключён",
                "Тірі әңгіме: провайдер қосылмаған",
              )}
            </button>
          </div>
          {problem && (
            <p role="alert" className="commerce-alert">
              {problem}
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
