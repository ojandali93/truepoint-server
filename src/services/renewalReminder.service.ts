// src/services/renewalReminder.service.ts
//
// Sends a "your subscription renews soon" heads-up 0–3 days before a paying
// subscription's current_period_end.
//
// Trigger model: a scheduled sweep (cron-job.org -> POST /api/v1/sync/renewal-reminders),
// NOT an in-process timer — same reasoning as introEmail.service.ts (timers
// don't survive Render restarts/redeploys and don't work across multiple
// instances). Each run grabs a batch of subscriptions renewing within the
// next 3 days that haven't been reminded for THIS renewal yet, sends, and
// stamps subscriptions.renewal_reminder_sent_for = current_period_end so the
// same renewal cycle is never emailed twice — but the next cycle (once
// current_period_end advances past a fresh renewal) re-arms automatically.

import { supabaseAdmin } from "../lib/supabase";
import { sendEmail } from "../lib/email";

const SUPPORT_EMAIL = "support@reverseholo.io";
const WINDOW_DAYS = 3; // remind for renewals landing in the next 3 days
const BATCH = 100; // cap per sweep run (post-dedupe, see note below)

// PostgREST filters compare a column to a literal, not to another column, so
// "renewal_reminder_sent_for <> current_period_end" can't be expressed as a
// single .neq() call (see CLAUDE.md §7 PostgREST pitfalls). We over-fetch on
// the filters PostgREST *can* express (platform/status/window), then apply
// the same-row dedupe check in application code before slicing to BATCH.
const FETCH_LIMIT = 500;

type Platform = "stripe" | "apple" | "google";

export interface RenewalCandidate {
  id: string;
  user_id: string;
  plan: string;
  platform: string;
  status: string;
  current_period_end: string | null;
  renewal_reminder_sent_for: string | null;
}

export interface RenewalReminderSweepResult {
  considered: number;
  sent: number;
  skippedNoEmail: number;
  skippedCancelPending: number;
  failed: number;
}

// ─── Email content (minimal, factual, no dollar amounts) ────────────────────

function capitalizePlan(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

// Human date, no time. UTC so a subscription doesn't appear to renew a day
// early/late depending on the server's local timezone near midnight.
function formatRenewalDate(currentPeriodEnd: string): string {
  return new Date(currentPeriodEnd).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function manageLineFor(platform: string): string {
  switch (platform) {
    case "apple":
      return "You can manage or cancel it anytime from your iPhone or iPad: Settings → your name → Subscriptions.";
    case "google":
      return "You can manage or cancel it anytime through Google Play → Subscriptions.";
    case "stripe":
    default:
      return "You can manage or cancel it anytime from your account's billing page on reverseholo.io.";
  }
}

function buildRenewalReminderEmail(
  plan: string,
  currentPeriodEnd: string,
  platform: string,
): { subject: string; html: string; text: string } {
  const subject = "Your ReverseHolo subscription renews in a few days";
  const planName = capitalizePlan(plan);
  const dateStr = formatRenewalDate(currentPeriodEnd);
  const manageLine = manageLineFor(platform);

  const text = `Hey there,

Your ${planName} plan renews on ${dateStr}.

No action is needed to keep your access — it'll continue automatically.

${manageLine}

Questions? Just reply to this email, or reach us at ${SUPPORT_EMAIL}.

— Reverse Holo`;

  // Same deliberately minimal HTML style as introEmail.service.ts — no logo
  // bar, no buttons.
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px;">
  <p>Hey there,</p>
  <p>Your <strong>${planName}</strong> plan renews on <strong>${dateStr}</strong>.</p>
  <p>No action is needed to keep your access — it'll continue automatically.</p>
  <p>${manageLine}</p>
  <p>Questions? Just reply to this email, or reach us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#1a1a1a;">${SUPPORT_EMAIL}</a>.</p>
  <p style="margin-top:24px;">— Reverse Holo</p>
</div>`;

  return { subject, html, text };
}

// ─── Candidate query (extracted so it's independently testable — see
// scripts/validateCancelLifecycle.ts — without invoking the send loop's
// real email side effects) ──────────────────────────────────────────────────

export interface RenewalReminderCandidates {
  candidates: RenewalCandidate[];
  cancelPendingCount: number;
}

export async function getRenewalReminderCandidates(): Promise<RenewalReminderCandidates> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const windowEndIso = new Date(
    nowMs + WINDOW_DAYS * 24 * 60 * 60_000,
  ).toISOString();

  // platform IN ('stripe','apple','google') — NEVER 'comp'. 'comp' rows are
  // admin-granted free upgrades with no real billing behind them; there is
  // nothing renewing and no payment method to remind anyone about, so a
  // renewal/payment email to a comp user would be both false and confusing.
  const platforms: Platform[] = ["stripe", "apple", "google"];

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "id, user_id, plan, platform, status, current_period_end, renewal_reminder_sent_for",
    )
    .in("platform", platforms)
    .eq("status", "active")
    // A cancel-pending subscription still has status='active' (see
    // migrations/2026-08-28_subscriptions_cancel_requested_at.sql — that's
    // the whole point, access continues) but is NOT "renewing" — it's
    // scheduled to end, not auto-renew. A single-column null check, so it's
    // one PostgREST filter like the rest of this WHERE, no app-code dedupe
    // needed the way the sent-marker check below requires.
    .is("cancel_requested_at", null)
    .gt("current_period_end", nowIso)
    .lte("current_period_end", windowEndIso)
    .limit(FETCH_LIMIT);

  if (error) throw error;

  // Count-only, for the log line / result metric — same filters minus the
  // cancel_requested_at exclusion, inverted. Not folded into the main query
  // since these rows are deliberately never fetched into `candidates`.
  const { count: cancelPendingCount } = await supabaseAdmin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .in("platform", platforms)
    .eq("status", "active")
    .not("cancel_requested_at", "is", null)
    .gt("current_period_end", nowIso)
    .lte("current_period_end", windowEndIso);

  const candidates = ((data ?? []) as RenewalCandidate[])
    .filter(
      (row) =>
        !!row.current_period_end &&
        (row.renewal_reminder_sent_for === null ||
          row.renewal_reminder_sent_for !== row.current_period_end),
    )
    .slice(0, BATCH);

  return { candidates, cancelPendingCount: cancelPendingCount ?? 0 };
}

// ─── The sweep ──────────────────────────────────────────────────────────────

export async function sendRenewalReminders(): Promise<RenewalReminderSweepResult> {
  const { candidates, cancelPendingCount } = await getRenewalReminderCandidates();

  const result: RenewalReminderSweepResult = {
    considered: candidates.length,
    sent: 0,
    skippedNoEmail: 0,
    skippedCancelPending: cancelPendingCount,
    failed: 0,
  };

  for (const sub of candidates) {
    const currentPeriodEnd = sub.current_period_end as string;
    try {
      // Email lives on auth.users — resolve it the same way introEmail does.
      const { data: authData } = await supabaseAdmin.auth.admin.getUserById(
        sub.user_id,
      );
      const email = authData?.user?.email;
      if (!email) {
        result.skippedNoEmail++;
        // Deliberately NOT stamped — unlike introEmail, this row is
        // naturally bounded by the 3-day window (it drops out of the
        // candidate set on its own once current_period_end passes), so
        // there's no unbounded-reconsideration risk to guard against here.
        continue;
      }

      const { subject, html, text } = buildRenewalReminderEmail(
        sub.plan,
        currentPeriodEnd,
        sub.platform,
      );

      await sendEmail({
        to: email,
        subject,
        html,
        text,
        replyTo: SUPPORT_EMAIL,
      });

      // Only stamp on success → a transient send failure retries next sweep.
      const { error: stampError } = await supabaseAdmin
        .from("subscriptions")
        .update({ renewal_reminder_sent_for: currentPeriodEnd })
        .eq("id", sub.id);
      if (stampError) throw stampError;

      result.sent++;
    } catch (err: any) {
      result.failed++;
      console.error(
        `[RenewalReminder] failed for subscription ${sub.id}:`,
        err?.message ?? err,
      );
      // leave renewal_reminder_sent_for as-is → retried next run
    }
  }

  console.log(
    `[RenewalReminder] sweep done: considered=${result.considered} sent=${result.sent} skippedNoEmail=${result.skippedNoEmail} skippedCancelPending=${result.skippedCancelPending} failed=${result.failed}`,
  );

  return result;
}
