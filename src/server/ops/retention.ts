import type { Database } from "../db/database";

// T053 / SPECIFICATION §20 "настраиваемые сроки хранения". Only operational data is trimmed:
// expired sessions and login counters, bodies of long-processed inbound events (the row stays for
// de-duplication), old sync logs, read notifications, used/expired chat-link codes and old rule
// test runs. Business history — audit, stock and money journals, documents, outbox, tasks — is
// never deleted by this tool. Days are configurable (RETENTION_<NAME>_DAYS) and dry-run is default.
export type RetentionPolicy = {
  inboxPayloadDays: number;
  syncRunDays: number;
  readNotificationDays: number;
  messagingLinkDays: number;
  automationTestDays: number;
  insightRunDays: number;
};
export const defaultPolicy: RetentionPolicy = {
  inboxPayloadDays: 30,
  syncRunDays: 180,
  readNotificationDays: 90,
  messagingLinkDays: 30,
  automationTestDays: 180,
  insightRunDays: 180,
};
export function policyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RetentionPolicy {
  const days = (name: string, fallback: number) => {
    const v = env[`RETENTION_${name}_DAYS`];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 3650)
      throw Error(`RETENTION_${name}_DAYS_INVALID`);
    return n;
  };
  return {
    inboxPayloadDays: days("INBOX_PAYLOAD", defaultPolicy.inboxPayloadDays),
    syncRunDays: days("SYNC_RUN", defaultPolicy.syncRunDays),
    readNotificationDays: days(
      "READ_NOTIFICATION",
      defaultPolicy.readNotificationDays,
    ),
    messagingLinkDays: days("MESSAGING_LINK", defaultPolicy.messagingLinkDays),
    automationTestDays: days(
      "AUTOMATION_TEST",
      defaultPolicy.automationTestDays,
    ),
    insightRunDays: days("INSIGHT_RUN", defaultPolicy.insightRunDays),
  };
}
type Rule = {
  name: string;
  where: string;
  action: "delete" | "redact";
  table: string;
  set?: string;
  days?: keyof RetentionPolicy;
};
const rules: Rule[] = [
  {
    name: "expired_sessions",
    table: "sessions",
    action: "delete",
    where: "expires_at<now()",
  },
  {
    name: "expired_login_limits",
    table: "auth_limits",
    action: "delete",
    where: "reset_at<now()",
  },
  {
    name: "processed_inbox_payloads",
    table: "integration_inbox",
    action: "redact",
    set: "payload='{}'::jsonb",
    where:
      "state IN ('processed','ignored') AND processed_at<now()-make_interval(days=>$1) AND payload<>'{}'::jsonb",
    days: "inboxPayloadDays",
  },
  {
    name: "old_sync_runs",
    table: "sync_runs",
    action: "delete",
    where: "state<>'running' AND started_at<now()-make_interval(days=>$1)",
    days: "syncRunDays",
  },
  {
    name: "read_notifications",
    table: "notifications",
    action: "delete",
    where: "read_at IS NOT NULL AND read_at<now()-make_interval(days=>$1)",
    days: "readNotificationDays",
  },
  {
    name: "used_or_expired_chat_links",
    table: "messaging_links",
    action: "delete",
    where: "coalesce(used_at,expires_at)<now()-make_interval(days=>$1)",
    days: "messagingLinkDays",
  },
  {
    name: "old_automation_test_runs",
    table: "automation_test_runs",
    action: "delete",
    where: "created_at<now()-make_interval(days=>$1)",
    days: "automationTestDays",
  },
  {
    name: "old_insight_runs",
    table: "insight_runs",
    action: "delete",
    where: "started_at<now()-make_interval(days=>$1)",
    days: "insightRunDays",
  },
];
export async function retention(
  db: Database,
  policy: RetentionPolicy,
  apply: boolean,
) {
  const result: Record<string, number> = {};
  for (const r of rules) {
    const params = r.days ? [policy[r.days]] : [];
    if (!apply) {
      const [c] = await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM ${r.table} WHERE ${r.where}`,
        params,
      );
      result[r.name] = c.n;
      continue;
    }
    result[r.name] = await db.transaction(
      async (tx) =>
        (
          await tx.query(
            r.action === "delete"
              ? `DELETE FROM ${r.table} WHERE ${r.where} RETURNING 1`
              : `UPDATE ${r.table} SET ${r.set} WHERE ${r.where} RETURNING 1`,
            params,
          )
        ).length,
    );
  }
  return result;
}
