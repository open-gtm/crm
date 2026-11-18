import { anchorTenant, sealTenant, tenantIds } from "../core/auditchain.js";
import { config } from "../config.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { runScheduler } from "../core/alerts.js";
import { runAutomationPass } from "../core/automation-runner.js";
import { sendDueEmails } from "../core/notifications.js";
import { getMailer } from "../providers/mailer.js";
import { deliverDue, processEventsRound, pruneHistory } from "./events.js";
import { pruneSessions } from "../auth/sessions.js";
import { pruneSignInFlows } from "../auth/signin.js";
import { pruneClients } from "../oauth/clients.js";
import { pruneGrants } from "../oauth/grants.js";
import { deleteOldIdempotencyKeys, enterWorkspace } from "./queries.js";

/**
 * Background worker: processes outbox events (automations and webhook subscriptions), runs queued
 * and scheduled automations, sends webhook deliveries with retries, seals and anchors the audit log,
 * and expires old data.
 */
export async function sealAll(): Promise<number> {
  let total = 0;
  for (const t of await tenantIds(db())) total += await sealTenant(t);
  return total;
}

export async function anchorAll(): Promise<number> {
  let n = 0;
  for (const t of await tenantIds(db())) if (await anchorTenant(t)) n++;
  return n;
}

export function startWorker(): () => void {
  const cfg = config();
  let stopped = false;
  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    const tick = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (e) {
        logger.error({ job: name, err: (e as Error).message }, "worker job failed");
      }
      if (!stopped) timers.push(setTimeout(tick, everyMs));
    };
    timers.push(setTimeout(tick, 1000));
  };
  const timers: NodeJS.Timeout[] = [];
  loop("audit-seal", cfg.AUDIT_SEAL_INTERVAL_MS, async () => {
    const n = await sealAll();
    if (n) logger.info({ sealed: n }, "sealed audit rows");
  });
  loop("events", cfg.EVENT_POLL_INTERVAL_MS, async () => {
    // Bounded per tenant per tick (time and batches), so one tenant's backlog or slow automations can't starve the others.
    await processEventsRound(await tenantIds(db()));
  });
  loop("webhook-delivery", cfg.EVENT_POLL_INTERVAL_MS, async () => {
    for (const t of await tenantIds(db())) {
      for (let pass = 0; pass < 10 && (await deliverDue(t)) > 0; pass++);
    }
  });
  // Schedule ticks, run-now requests and event automations that call out: one run per tenant per pass, a few at once.
  loop("automation-runs", cfg.EVENT_POLL_INTERVAL_MS, async () => {
    await runAutomationPass(await tenantIds(db()), { wait: false });
  });
  loop("alert-scheduler", cfg.ALERT_SCHEDULER_INTERVAL_MS, async () => {
    for (const t of await tenantIds(db())) {
      for (let pass = 0; pass < 20 && (await runScheduler(t)).checked > 0; pass++);
    }
  });
  loop("notification-email", 15_000, async () => {
    for (const t of await tenantIds(db())) {
      for (let pass = 0; pass < 10 && (await sendDueEmails(t)) > 0; pass++);
    }
  });
  loop("history-retention", 6 * 3_600_000, async () => {
    for (const t of await tenantIds(db())) await pruneHistory(t);
  });
  loop("audit-anchor", cfg.AUDIT_ANCHOR_INTERVAL_MS, anchorAll);
  loop("idempotency-expiry", 3_600_000, async () => {
    for (const t of await tenantIds(db())) {
      await db().begin(async (tx) => {
        await enterWorkspace(tx, t);
        await deleteOldIdempotencyKeys(tx);
      }).catch((e: Error) => logger.error({ job: "idempotency-expiry", tenantId: t, err: e.message }, "retention job failed"));
    }
    // Ended sessions and expired sign-in steps (codes, links, SSO state, workspace choices); OAuth (ADR 0010):
    // ended codes, tokens and grants, lapsed registrations, stale client documents, used assertion IDs.
    // Each on its own, so one that fails doesn't keep the others' rows past their time.
    for (const [job, prune] of [["sessions", pruneSessions], ["sign-in-flows", pruneSignInFlows], ["oauth-grants", pruneGrants], ["oauth-clients", pruneClients]] as const) {
      await prune().catch((e: Error) => logger.error({ job, err: e.message }, "retention job failed"));
    }
  });
  if (cfg.WEBHOOK_ALLOW_INSECURE_TARGETS) {
    logger.warn("WEBHOOK_ALLOW_INSECURE_TARGETS is on: webhooks may target http:// and private addresses (metadata IPs stay blocked)");
  }
  if (!getMailer().enabled) logger.warn("SMTP_URL is not set: notification emails are skipped (inbox and webhooks still work)");
  logger.info("worker started");
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
  };
}
