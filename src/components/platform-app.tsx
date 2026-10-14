"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  CheckCheck,
  ChevronDown,
  CircleCheck,
  Clock3,
  Copy,
  Database,
  History,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MapPin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  assignableRoles,
  profiles,
  type Locale,
  type Member,
  type Organization,
  type SessionView,
  type Workspace,
} from "@/domain/contracts";
import {
  dictionary,
  errorText,
  eventText,
  profileNames,
  roleNames,
} from "@/lib/i18n";
import { api, ApiError } from "@/lib/client";
import { businessDate } from "@/lib/dates";
import { CustomersPage } from "./customers-page";
import { InventoryPage } from "./inventory-page";
import { can } from "@/domain/permissions";

type Page =
  "today" | "team" | "organization" | "activity" | "customers" | "inventory";
type Modal = "invite" | "newOrg" | "branch" | null;
const field = (form: FormData, name: string) => String(form.get(name) || "");
const branchName = (name: string, locale: Locale) =>
  name === "01" ? dictionary(locale).mainBranch : name;

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
function Language({
  locale,
  onChange,
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
}) {
  return (
    <div
      className="language"
      role="group"
      aria-label={dictionary(locale).language}
    >
      {(["kk", "ru"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => onChange(l)}
        >
          {l === "kk" ? "ҚАЗ" : "РУС"}
        </button>
      ))}
    </div>
  );
}
function ErrorNotice({ error, locale }: { error: unknown; locale: Locale }) {
  if (!error) return null;
  return (
    <div className="error-notice" role="alert">
      <strong>{dictionary(locale).errorTitle}</strong>
      <span>
        {errorText(
          error instanceof ApiError ? error.code : "INTERNAL_ERROR",
          locale,
        )}
      </span>
      {error instanceof ApiError && error.requestId && (
        <small>ID: {error.requestId}</small>
      )}
    </div>
  );
}
function Form({
  onSubmit,
  children,
  submit,
  locale,
  secondary = false,
}: {
  onSubmit: (data: FormData) => Promise<void>;
  children: ReactNode;
  submit: string;
  locale: Locale;
  secondary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(data);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={handle} className="form">
      <fieldset disabled={busy}>{children}</fieldset>
      <ErrorNotice error={error} locale={locale} />
      <button
        className={`button ${secondary ? "secondary" : "primary"}`}
        disabled={busy}
        type="submit"
      >
        {busy ? <LoaderCircle className="spin" size={17} /> : null}
        {busy ? dictionary(locale).working : submit}
        {!busy && !secondary ? <ArrowRight size={17} /> : null}
      </button>
    </form>
  );
}
function Dialog({
  title,
  onClose,
  children,
  locale,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  locale: Locale;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label={dictionary(locale).dismiss}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function OrganizationFields({
  locale,
  organization,
}: {
  locale: Locale;
  organization?: Organization;
}) {
  const t = dictionary(locale);
  return (
    <>
      <label>
        {t.orgName}
        <input
          name="name"
          required
          minLength={2}
          maxLength={100}
          placeholder={t.orgPlaceholder}
          defaultValue={organization?.name}
          autoComplete="organization"
        />
      </label>
      <label>
        {t.profile}
        <select
          aria-label={t.profile}
          name="profile"
          defaultValue={organization?.profile || "retail"}
        >
          {profiles.map((p) => (
            <option value={p} key={p}>
              {profileNames[locale][p]}
            </option>
          ))}
        </select>
        <small>{t.profileNote}</small>
      </label>
      <div className="form-grid">
        <label>
          {t.timezone}
          <select
            aria-label={t.timezone}
            name="timezone"
            defaultValue={organization?.timezone || "Asia/Qyzylorda"}
          >
            {[
              "Asia/Qyzylorda",
              "Asia/Almaty",
              "Asia/Aqtau",
              "Asia/Aqtobe",
              "Asia/Atyrau",
              "Asia/Oral",
              "UTC",
            ].map((zone) => (
              <option key={zone}>{zone}</option>
            ))}
          </select>
        </label>
        <label>
          {t.currency}
          <input value="KZT · ₸" readOnly aria-readonly="true" />
        </label>
      </div>
    </>
  );
}

function Auth({
  locale,
  onLocale,
  onLogin,
  invitation,
  localPreview,
}: {
  locale: Locale;
  onLocale: (l: Locale) => void;
  onLogin: () => Promise<void>;
  invitation: boolean;
  localPreview: boolean;
}) {
  const t = dictionary(locale);
  const [mode, setMode] = useState<"login" | "register">("register");
  return (
    <main className="auth-page">
      <div className="auth-top">
        <Link className="brand" href="/">
          <Mark />
          <span>
            {t.brand}
            <small>{t.workspace}</small>
          </span>
        </Link>
        <Language locale={locale} onChange={onLocale} />
      </div>
      <div className="auth-layout">
        <section className="welcome">
          <p className="eyebrow">{t.welcomeEyebrow}</p>
          <h1>{t.welcomeTitle}</h1>
          <p className="welcome-intro">{t.welcomeText}</p>
          <div className="welcome-steps">
            {[
              [t.step1, t.step1note, Building2],
              [t.step2, t.step2note, Users],
              [t.step3, t.step3note, ShieldCheck],
            ].map(([title, note, Icon], i) => {
              const I = Icon as typeof Building2;
              return (
                <div key={i}>
                  <span className="step-icon">
                    <I size={21} />
                  </span>
                  <span>
                    <strong>{title as string}</strong>
                    <small>{note as string}</small>
                  </span>
                  <span className="step-count">0{i + 1}</span>
                </div>
              );
            })}
          </div>
          <div className="welcome-foot">
            <span className="status-dot" />
            {t.localOnly}
            <span>KK / RU</span>
          </div>
        </section>
        <section className="auth-card">
          <div className="section-tag">
            <ShieldCheck size={15} />
            {t.workspace}
          </div>
          <h2>{mode === "register" ? t.registerTitle : t.loginTitle}</h2>
          <p className="muted">
            {mode === "register" ? t.registerNote : t.loginNote}
          </p>
          {invitation && (
            <div className="info-box">
              <strong>{t.invitationReceived}</strong>
              <p>{t.invitationReceivedNote}</p>
            </div>
          )}
          <Form
            key={mode}
            locale={locale}
            submit={mode === "register" ? t.register : t.login}
            onSubmit={async (data) => {
              await api(
                `auth/${mode}`,
                "POST",
                mode === "register"
                  ? {
                      name: field(data, "name"),
                      email: field(data, "email"),
                      password: field(data, "password"),
                    }
                  : {
                      email: field(data, "email"),
                      password: field(data, "password"),
                    },
              );
              await onLogin();
            }}
          >
            {mode === "register" && (
              <label>
                {t.name}
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={100}
                  autoComplete="name"
                  placeholder={
                    locale === "kk" ? "Атыңызды енгізіңіз" : "Введите имя"
                  }
                />
              </label>
            )}
            <label>
              {t.email}
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="name@example.test"
              />
            </label>
            <label>
              {t.password}
              <input
                aria-label={t.password}
                aria-describedby={
                  mode === "register" ? "password-note" : undefined
                }
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
              />
              {mode === "register" && (
                <small id="password-note">{t.passwordNote}</small>
              )}
            </label>
          </Form>
          <p className="auth-toggle">
            {mode === "register" ? t.haveAccount : t.needAccount}
            <button
              className="text-button"
              onClick={() =>
                setMode(mode === "register" ? "login" : "register")
              }
            >
              {mode === "register" ? t.login : t.register}
            </button>
          </p>
          {localPreview && (
            <div className="test-disclaimer">
              <span className="tag">
                <span className="status-dot" />
                {t.testData}
              </span>
              <p>{t.testNote}</p>
            </div>
          )}
        </section>
      </div>
      <footer className="auth-footer">
        <span>{t.foundationNote}</span>
        <span>{t.brandNote}</span>
      </footer>
    </main>
  );
}

function InvitationForm({
  locale,
  workspace,
  onCreated,
}: {
  locale: Locale;
  workspace: Workspace;
  onCreated: () => Promise<void>;
}) {
  const t = dictionary(locale);
  const [link, setLink] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  if (link)
    return (
      <div className="invite-result">
        <div className="success-orb">
          <CheckCheck size={28} />
        </div>
        <p>{t.linkNote}</p>
        <label>
          {t.inviteLink}
          <input
            value={link}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <button
          className="button primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopyMessage(t.copied);
            } catch {
              setCopyMessage(t.copyFallback);
            }
          }}
        >
          <Copy size={17} />
          {t.copy}
        </button>
        <p role="status" className="muted">
          {copyMessage}
        </p>
      </div>
    );
  return (
    <>
      <p className="muted">{t.inviteNote}</p>
      <Form
        locale={locale}
        submit={t.createLink}
        onSubmit={async (data) => {
          const result = await api<{ token: string }>(
            `organizations/${workspace.organization.id}/invitations`,
            "POST",
            {
              email: field(data, "email"),
              role: field(data, "role"),
              branchId: field(data, "branchId") || null,
            },
          );
          setLink(`${window.location.origin}/#invite=${result.token}`);
          await onCreated();
        }}
      >
        <label>
          {t.email}
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            placeholder="colleague@example.test"
          />
        </label>
        <label>
          {t.role}
          <select aria-label={t.role} name="role" defaultValue="employee">
            {assignableRoles.map((role) => (
              <option value={role} key={role}>
                {roleNames[locale][role]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.access}
          <select aria-label={t.access} name="branchId" defaultValue="">
            <option value="">{t.allBranches}</option>
            {workspace.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {branchName(b.name, locale)}
              </option>
            ))}
          </select>
        </label>
      </Form>
    </>
  );
}

function Activity({
  workspace,
  locale,
  compact = false,
}: {
  workspace: Workspace;
  locale: Locale;
  compact?: boolean;
}) {
  const t = dictionary(locale);
  if (!workspace.canReadAudit)
    return (
      <div className="empty">
        <ShieldCheck size={25} />
        <p>{t.noAuditAccess}</p>
      </div>
    );
  const events = workspace.activity.slice(0, compact ? 4 : 30);
  if (!events.length)
    return (
      <div className="empty">
        <History size={25} />
        <p>{t.noActivity}</p>
      </div>
    );
  return (
    <div className="activity-list">
      {events.map((event) => (
        <div className="activity-row" key={event.id}>
          <span className="activity-icon">
            <ArrowDownLeft size={17} />
          </span>
          <div>
            <strong>{eventText(event.action, locale)}</strong>
            <span>
              {event.actor_name}
              {event.details.role
                ? ` · ${roleNames[locale][event.details.role as keyof typeof roleNames.ru]}`
                : ""}
            </span>
          </div>
          <time dateTime={new Date(event.created_at).toISOString()}>
            {businessDate(
              new Date(event.created_at),
              locale,
              workspace.organization.timezone,
              true,
            )}
          </time>
        </div>
      ))}
    </div>
  );
}

function Today({
  workspace,
  locale,
  onNavigate,
  onInvite,
}: {
  workspace: Workspace;
  locale: Locale;
  onNavigate: (p: Page) => void;
  onInvite: () => void;
}) {
  const t = dictionary(locale);
  const hasTeam = workspace.members.length > 1;
  const hasBranches = workspace.branches.length > 1;
  return (
    <>
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">{t.readyEyebrow}</p>
          <h2>
            {workspace.canManageTeam
              ? hasTeam
                ? t.teamReadyTitle
                : t.readyTitle
              : t.employeeTitle}
          </h2>
          <p>
            {workspace.canManageTeam
              ? hasTeam
                ? t.teamReadyNote
                : t.readyNote
              : t.employeeNote}
          </p>
          <button
            className="button dark"
            onClick={
              workspace.canManageTeam && !hasTeam
                ? onInvite
                : () => onNavigate("team")
            }
          >
            {workspace.canManageTeam
              ? hasTeam
                ? t.teamAccess
                : t.invite
              : t.ownAccess}
            <ArrowUpRight size={17} />
          </button>
        </div>
        <div className="hero-illustration" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="floating-card card-back">
            <Building2 size={22} />
            <span />
            <span />
          </div>
          <div className="floating-card card-front">
            <span className="illus-avatar">A</span>
            <span className="illus-avatar lavender">M</span>
            <span className="illus-avatar sand">+1</span>
            <div className="illus-line" />
            <div className="illus-line short" />
            <div className="illus-status">
              <Check size={14} />
            </div>
          </div>
          <div className="floating-check">
            <Check size={22} />
          </div>
          <div className="tiny-spark">
            <Sparkles size={22} />
          </div>
        </div>
      </section>
      <div className="stat-grid">
        <div className="stat-card">
          <div>
            <span>{t.members}</span>
            <Users size={18} />
          </div>
          <strong>
            {workspace.members.length.toString().padStart(2, "0")}
          </strong>
          <small>{t.peopleNote}</small>
        </div>
        <div className="stat-card">
          <div>
            <span>{t.branches}</span>
            <MapPin size={18} />
          </div>
          <strong>
            {workspace.branches.length.toString().padStart(2, "0")}
          </strong>
          <small>{t.branchesNote}</small>
        </div>
        <div className="stat-card">
          <div>
            <span>{workspace.canReadAudit ? t.events : t.role}</span>
            <ShieldCheck size={18} />
          </div>
          <strong className={workspace.canReadAudit ? "" : "text-stat"}>
            {workspace.canReadAudit
              ? workspace.activity.length.toString().padStart(2, "0")
              : roleNames[locale][workspace.organization.role]}
          </strong>
          <small>{workspace.canReadAudit ? t.eventsNote : t.ownAccess}</small>
        </div>
      </div>
      <div className="dashboard-grid">
        <section className="panel checklist-panel">
          <div className="panel-heading">
            <div>
              <h3>{t.startChecklist}</h3>
              <p>{t.checklistNote}</p>
            </div>
            <span className="count-tag">
              {1 + Number(hasTeam) + Number(hasBranches)}/3
            </span>
          </div>
          <div className="checklist">
            <div className="checklist-row">
              <CircleCheck size={22} className="check-done" />
              <div>
                <strong>{t.created}</strong>
                <span>{t.createdNote}</span>
              </div>
              <Check size={15} />
            </div>
            <button
              className="checklist-row"
              onClick={
                workspace.canManageTeam && !hasTeam
                  ? onInvite
                  : () => onNavigate("team")
              }
            >
              <span className={hasTeam ? "check-done" : "step-number"}>
                {hasTeam ? <CircleCheck size={22} /> : "2"}
              </span>
              <div>
                <strong>{hasTeam ? t.teamAdded : t.invited}</strong>
                <span>{hasTeam ? t.teamAddedNote : t.invitedNote}</span>
              </div>
              <ArrowRight size={16} />
            </button>
            <button
              className="checklist-row"
              onClick={() => onNavigate("organization")}
            >
              <span className={hasBranches ? "check-done" : "step-number"}>
                {hasBranches ? <CircleCheck size={22} /> : "3"}
              </span>
              <div>
                <strong>
                  {hasBranches ? t.configuredBranches : t.configureBranches}
                </strong>
                <span>{t.configureBranchesNote}</span>
              </div>
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>{t.connections}</h3>
            <Database size={18} />
          </div>
          <div className="source-row">
            <span className="source-icon">
              <Mark small />
            </span>
            <div>
              <strong>{t.internalSource}</strong>
              <small>{t.internalSourceNote}</small>
            </div>
          </div>
          <span className="source-status">
            <span className="status-dot" />
            {t.available}
          </span>
          <div className="source-divider" />
          <div className="external-source">
            <span>МойСклад</span>
            <span className="muted-tag">{t.notConnected}</span>
          </div>
          <div className="external-source">
            <span>Битрикс24</span>
            <span className="muted-tag">{t.notConnected}</span>
          </div>
          <p className="source-note">{t.integrationNote}</p>
        </section>
      </div>
      <section className="panel activity-panel">
        <div className="panel-heading">
          <h3>{t.latestActivity}</h3>
          {workspace.canReadAudit && (
            <button
              className="text-button"
              onClick={() => onNavigate("activity")}
            >
              {t.seeAll}
              <ArrowRight size={15} />
            </button>
          )}
        </div>
        <Activity workspace={workspace} locale={locale} compact />
      </section>
    </>
  );
}

export function PlatformApp({ initialLocale }: { initialLocale: Locale }) {
  const [locale, setLocale] = useState(initialLocale);
  const t = dictionary(locale);
  const [session, setSession] = useState<SessionView>();
  const [organizationId, setOrganizationId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>();
  const [page, setPage] = useState<Page>("today");
  const [modal, setModal] = useState<Modal>(null);
  const [removeMember, setRemoveMember] = useState<Member | null>(null);
  const [invitation, setInvitation] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<unknown>(null);
  async function reloadSession(preferred?: string) {
    const data = await api<SessionView>("session");
    setSession(data);
    setOrganizationId((current) =>
      preferred && data.organizations.some((o) => o.id === preferred)
        ? preferred
        : data.organizations.some((o) => o.id === current)
          ? current
          : data.organizations[0]?.id || "",
    );
    setRevision((v) => v + 1);
  }
  useEffect(() => {
    let active = true;
    const readInvitation = () => {
      const candidate = new URLSearchParams(window.location.hash.slice(1)).get(
        "invite",
      );
      setInvitation(
        candidate && /^[a-f0-9]{64}$/.test(candidate) ? candidate : "",
      );
    };
    window.addEventListener("hashchange", readInvitation);
    api<SessionView>("session")
      .then((data) => {
        if (active) {
          setSession(data);
          setOrganizationId(data.organizations[0]?.id || "");
          readInvitation();
        }
      })
      .catch((e) => {
        if (active) setError(e);
      });
    return () => {
      active = false;
      window.removeEventListener("hashchange", readInvitation);
    };
  }, []);
  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    api<Workspace>(`organizations/${organizationId}`)
      .then((data) => {
        if (active) {
          setWorkspace(data);
          setWorkspaceError(null);
        }
      })
      .catch((e) => {
        if (active) {
          setWorkspace(undefined);
          setWorkspaceError(e);
        }
      });
    return () => {
      active = false;
    };
  }, [organizationId, revision]);
  function changeLocale(l: Locale) {
    setLocale(l);
    document.documentElement.lang = l;
    document.cookie = `smb_locale=${l}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await reloadSession();
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
    }
  }
  async function logout() {
    setError(null);
    try {
      await api("auth/logout", "POST", {});
      setWorkspace(undefined);
      setOrganizationId("");
      setPage("today");
      await reloadSession();
    } catch (e) {
      setError(e);
    }
  }
  function dismissInvitation() {
    setInvitation("");
    window.history.replaceState(null, "", window.location.pathname);
  }
  function navigate(p: Page) {
    setPage(p);
    setNotice("");
    setError(null);
  }
  async function createOrganization(data: FormData) {
    const result = await api<{ id: string }>("organizations", "POST", {
      name: field(data, "name"),
      profile: field(data, "profile"),
      timezone: field(data, "timezone"),
    });
    await reloadSession(result.id);
    setPage("today");
    setModal(null);
  }
  const invitationPanel =
    invitation && session?.user ? (
      <div className="invitation-banner">
        <div>
          <strong>{t.invitationReady}</strong>
          <p>
            {t.invitationAccount} <b>{session.user.email}</b>
          </p>
        </div>
        <Form
          locale={locale}
          submit={t.acceptInvitation}
          onSubmit={async () => {
            const result = await api<{ id: string }>(
              "invitations/accept",
              "POST",
              { token: invitation },
            );
            dismissInvitation();
            await reloadSession(result.id);
          }}
        >
          <span />
        </Form>
        <button
          className="icon-button"
          onClick={dismissInvitation}
          aria-label={t.dismiss}
        >
          <X size={18} />
        </button>
      </div>
    ) : null;
  if (!session)
    return (
      <main className="loading-page">
        <Mark />
        <p>{t.loading}</p>
        <ErrorNotice error={error} locale={locale} />
        {Boolean(error) && (
          <button className="button secondary" onClick={refresh}>
            {t.retry}
          </button>
        )}
      </main>
    );
  if (!session.user)
    return (
      <Auth
        locale={locale}
        onLocale={changeLocale}
        onLogin={reloadSession}
        invitation={!!invitation}
        localPreview={session.localPreview}
      />
    );
  if (!session.organizations.length)
    return (
      <main className="setup-page">
        <div className="auth-top">
          <div className="brand">
            <Mark />
            <span>{t.brand}</span>
          </div>
          <div className="top-actions">
            <Language locale={locale} onChange={changeLocale} />
            <button
              className="icon-button"
              onClick={logout}
              aria-label={t.logout}
            >
              <LogOut size={19} />
            </button>
          </div>
        </div>
        {invitationPanel}
        <section className="setup-card">
          <span className="section-icon">
            <Building2 size={25} />
          </span>
          <p className="eyebrow">01 / {t.createWorkspace}</p>
          <h1>{t.setupTitle}</h1>
          <p className="muted">{t.setupNote}</p>
          <Form
            locale={locale}
            submit={t.createOrg}
            onSubmit={createOrganization}
          >
            <OrganizationFields locale={locale} />
          </Form>
          <p className="setup-note">
            <span className="tag">{t.testData}</span>
            {t.testNote}
          </p>
        </section>
        <ErrorNotice error={error} locale={locale} />
      </main>
    );
  const ready = workspace?.organization.id === organizationId;
  const currentOrg = session.organizations.find((o) => o.id === organizationId);
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        {t.continue}
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/">
          <Mark />
          <span>
            {t.brand}
            <small>{t.workspace}</small>
          </span>
        </Link>
        <div className="organization-picker">
          <span className="org-avatar">
            {(currentOrg?.name || "B").slice(0, 1).toUpperCase()}
          </span>
          <label className="sr-only" htmlFor="organization-select">
            {t.switchOrg}
          </label>
          <select
            id="organization-select"
            value={organizationId}
            onChange={(e) => {
              if (e.target.value === "new") {
                setModal("newOrg");
                return;
              }
              setOrganizationId(e.target.value);
              setPage("today");
            }}
          >
            {session.organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
            <option value="new">+ {t.newOrg}</option>
          </select>
          <ChevronDown size={15} />
        </div>
        <div className="sidebar-label">{t.workspace}</div>
        <nav aria-label={t.workspace}>
          {(
            [
              { id: "today", Icon: LayoutDashboard },
              { id: "customers", Icon: Users },
              { id: "inventory", Icon: Database },
              { id: "team", Icon: Users },
              { id: "organization", Icon: Building2 },
              { id: "activity", Icon: History },
            ] as const
          )
            .filter((item) => item.id !== "activity" || workspace?.canReadAudit)
            .filter(
              (item) =>
                item.id !== "inventory" ||
                (workspace &&
                  can(workspace.organization.role, "inventory:read")),
            )
            .filter(
              (item) =>
                item.id !== "customers" ||
                (workspace &&
                  can(workspace.organization.role, "customers:read")),
            )
            .map(({ id, Icon }) => (
              <button
                key={id}
                className={`nav-item ${page === id ? "selected" : ""}`}
                onClick={() => navigate(id)}
                aria-current={page === id ? "page" : undefined}
              >
                <Icon size={19} />
                <span>{t[id]}</span>
                {page === id && <span className="nav-dot" />}
              </button>
            ))}
        </nav>
        <button className="new-org-button" onClick={() => setModal("newOrg")}>
          <Plus size={17} />
          {t.newOrg}
        </button>
        <div className="sidebar-bottom">
          <div className="foundation-card">
            <span className="tag">
              <span className="status-dot" />
              {t.testData}
            </span>
            <p>{t.foundationNote}</p>
            <small>{t.futureNote}</small>
          </div>
          <div className="user-card">
            <span className="user-avatar">{session.user.name.slice(0, 1)}</span>
            <div>
              <strong>{session.user.name}</strong>
              <small>
                {currentOrg ? roleNames[locale][currentOrg.role] : ""}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label={t.logout}
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{t.workspace}</span>
            <span>/</span>
            <strong>{t[page]}</strong>
          </div>
          <span className="tag mobile-test">{t.testData}</span>
          <div className="top-actions">
            <span className="local-indicator">
              <span className="status-dot" />
              {t.localOnly}
            </span>
            <Language locale={locale} onChange={changeLocale} />
            <button
              className="icon-button"
              aria-label={t.refresh}
              onClick={refresh}
              disabled={refreshing}
            >
              <RefreshCw size={17} className={refreshing ? "spin" : ""} />
            </button>
          </div>
        </header>
        <main id="main-content" className="content">
          <div className="page-heading">
            <div>
              <div className="page-kicker">
                {currentOrg
                  ? profileNames[locale][currentOrg.profile]
                  : t.workspace}
              </div>
              <h1>
                {t[page]}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {page === "today"
                  ? t.todayNote
                  : page === "team"
                    ? t.teamNote
                    : page === "customers"
                      ? t.customersNote
                      : page === "inventory"
                        ? t.inventoryNote
                        : page === "organization"
                          ? t.orgNote
                          : t.activityNote}
              </p>
            </div>
            {page === "today" ? (
              <span className="date-chip">
                <Clock3 size={15} />
                {businessDate(
                  new Date(),
                  locale,
                  currentOrg?.timezone || "Asia/Qyzylorda",
                )}
              </span>
            ) : page === "team" && workspace?.canManageTeam ? (
              <button
                className="button primary"
                onClick={() => setModal("invite")}
              >
                <Plus size={17} />
                {t.invite}
              </button>
            ) : null}
          </div>
          {invitationPanel}
          <ErrorNotice error={error} locale={locale} />
          {notice && (
            <div className="success-notice" role="status">
              <CircleCheck size={18} />
              {notice}
              <button
                className="icon-button"
                aria-label={t.dismiss}
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {!ready ? (
            <section className="panel">
              <ErrorNotice error={workspaceError} locale={locale} />
              {workspaceError ? (
                <button className="button secondary" onClick={refresh}>
                  {t.retry}
                </button>
              ) : (
                <div className="empty">
                  <LoaderCircle className="spin" />
                  {t.loading}
                </div>
              )}
            </section>
          ) : (
            <>
              {page === "inventory" &&
                can(workspace.organization.role, "inventory:read") && (
                  <InventoryPage
                    key={workspace.organization.id}
                    workspace={workspace}
                    locale={locale}
                  />
                )}
              {page === "customers" &&
                can(workspace.organization.role, "customers:read") && (
                  <CustomersPage
                    key={workspace.organization.id}
                    workspace={workspace}
                    locale={locale}
                  />
                )}
              {page === "today" && (
                <Today
                  workspace={workspace}
                  locale={locale}
                  onNavigate={navigate}
                  onInvite={() => setModal("invite")}
                />
              )}
              {page === "activity" && (
                <section className="panel">
                  <Activity workspace={workspace} locale={locale} />
                </section>
              )}
              {page === "team" && (
                <>
                  <section className="panel">
                    <div className="panel-heading">
                      <h3>
                        {t.members}
                        <span className="inline-count">
                          {workspace.members.length}
                        </span>
                      </h3>
                      <span className="tag">
                        <ShieldCheck size={13} />
                        {t.access}
                      </span>
                    </div>
                    {!["owner", "manager"].includes(
                      workspace.organization.role,
                    ) && <p className="muted">{t.onlySelf}</p>}
                    <div className="member-list">
                      {workspace.members.map((member, i) => (
                        <div className="member-row" key={member.id}>
                          <span className={`member-avatar color-${i % 3}`}>
                            {member.name.slice(0, 1)}
                          </span>
                          <div className="member-identity">
                            <strong>
                              {member.name}
                              {member.user_id === session.user!.id && (
                                <small>{t.you}</small>
                              )}
                            </strong>
                            <span>{member.email}</span>
                          </div>
                          <div className="member-role">
                            <span>{roleNames[locale][member.role]}</span>
                            <small>
                              {member.branch_name
                                ? branchName(member.branch_name, locale)
                                : t.allBranches}
                            </small>
                          </div>
                          <span className="member-status">
                            <span className="status-dot" />
                            {t.active}
                          </span>
                          {workspace.canManageTeam &&
                            member.role !== "owner" && (
                              <button
                                className="text-button danger-text"
                                onClick={() => setRemoveMember(member)}
                              >
                                {t.remove}
                              </button>
                            )}
                        </div>
                      ))}
                    </div>
                  </section>
                  {workspace.canManageTeam && (
                    <section className="panel spaced-panel">
                      <div className="panel-heading">
                        <h3>{t.pendingInvites}</h3>
                        <span className="muted-tag">
                          48 {locale === "ru" ? "часов" : "сағат"}
                        </span>
                      </div>
                      {workspace.invitations.length ? (
                        workspace.invitations.map((inv) => (
                          <div className="invitation-row" key={inv.id}>
                            <div>
                              <strong>{inv.email}</strong>
                              <small>
                                {roleNames[locale][inv.role]} ·{" "}
                                {inv.branch_id
                                  ? branchName(
                                      workspace.branches.find(
                                        (b) => b.id === inv.branch_id,
                                      )?.name || "",
                                      locale,
                                    )
                                  : t.allBranches}
                              </small>
                            </div>
                            <span
                              className={`pill ${inv.status === "pending" ? "amber" : ""}`}
                            >
                              {t[inv.status]}
                            </span>
                            {inv.status === "pending" && (
                              <button
                                className="text-button"
                                onClick={async () => {
                                  try {
                                    await api(
                                      `organizations/${organizationId}/invitations/${inv.id}`,
                                      "DELETE",
                                    );
                                    await reloadSession();
                                  } catch (e) {
                                    setError(e);
                                  }
                                }}
                              >
                                {t.revoke}
                              </button>
                            )}
                          </div>
                        ))
                      ) : (
                        <div className="empty">
                          <Users size={26} />
                          <p>{t.noInvites}</p>
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}
              {page === "organization" && (
                <div className="settings-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <h3>{t.organization}</h3>
                      <span className="tag">{t.testData}</span>
                    </div>
                    {workspace.canManageOrganization ? (
                      <Form
                        key={organizationId}
                        locale={locale}
                        submit={t.save}
                        onSubmit={async (data) => {
                          await api(
                            `organizations/${organizationId}`,
                            "PATCH",
                            {
                              name: field(data, "name"),
                              profile: field(data, "profile"),
                              timezone: field(data, "timezone"),
                            },
                          );
                          await reloadSession();
                          setNotice(t.saved);
                        }}
                      >
                        <OrganizationFields
                          locale={locale}
                          organization={workspace.organization}
                        />
                      </Form>
                    ) : (
                      <>
                        <p className="muted">{t.ownerOnly}</p>
                        <dl className="details-list">
                          <dt>{t.orgName}</dt>
                          <dd>{workspace.organization.name}</dd>
                          <dt>{t.profile}</dt>
                          <dd>
                            {
                              profileNames[locale][
                                workspace.organization.profile
                              ]
                            }
                          </dd>
                          <dt>{t.timezone}</dt>
                          <dd>{workspace.organization.timezone}</dd>
                          <dt>{t.currency}</dt>
                          <dd>KZT</dd>
                        </dl>
                      </>
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h3>{t.branches}</h3>
                      <span className="inline-count">
                        {workspace.branches.length}
                      </span>
                    </div>
                    {workspace.branches.map((b) => (
                      <div className="branch-row" key={b.id}>
                        <span className="branch-icon">
                          <MapPin size={19} />
                        </span>
                        <strong>{branchName(b.name, locale)}</strong>
                      </div>
                    ))}
                    {workspace.canManageOrganization && (
                      <button
                        className="button secondary full-width"
                        onClick={() => setModal("branch")}
                      >
                        <Plus size={16} />
                        {t.addBranch}
                      </button>
                    )}
                  </section>
                </div>
              )}
            </>
          )}
          <footer className="content-footer">
            <span>{t.foundationNote}</span>
            <span>
              {currentOrg?.currency} · {currentOrg?.timezone}
            </span>
          </footer>
        </main>
      </div>
      {modal === "newOrg" && (
        <Dialog
          title={t.createOrg}
          locale={locale}
          onClose={() => setModal(null)}
        >
          <Form
            locale={locale}
            submit={t.createOrg}
            onSubmit={createOrganization}
          >
            <OrganizationFields locale={locale} />
          </Form>
        </Dialog>
      )}
      {modal === "invite" && ready && (
        <Dialog title={t.invite} locale={locale} onClose={() => setModal(null)}>
          <InvitationForm
            locale={locale}
            workspace={workspace}
            onCreated={reloadSession}
          />
        </Dialog>
      )}
      {modal === "branch" && (
        <Dialog
          title={t.addBranch}
          locale={locale}
          onClose={() => setModal(null)}
        >
          <Form
            locale={locale}
            submit={t.addBranch}
            onSubmit={async (data) => {
              await api(`organizations/${organizationId}/branches`, "POST", {
                name: field(data, "name"),
              });
              await reloadSession();
              setModal(null);
            }}
          >
            <label>
              {t.branchName}
              <input name="name" required minLength={2} maxLength={100} />
            </label>
          </Form>
        </Dialog>
      )}
      {removeMember && (
        <Dialog
          title={t.removeTitle}
          locale={locale}
          onClose={() => setRemoveMember(null)}
        >
          <p>{removeMember.name}</p>
          <p className="muted">{t.removeNote}</p>
          <Form
            locale={locale}
            submit={t.confirmRemove}
            onSubmit={async () => {
              await api(
                `organizations/${organizationId}/members/${removeMember.id}`,
                "DELETE",
              );
              await reloadSession();
              setRemoveMember(null);
            }}
          >
            <span />
          </Form>
        </Dialog>
      )}
    </div>
  );
}
