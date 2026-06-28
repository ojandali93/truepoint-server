// src/services/introEmail.service.ts
//
// Sends a single, personal founder intro email ~1 hour after a user signs up.
//
// Trigger model: a scheduled sweep (cron-job.org -> POST /api/v1/sync/intro-emails),
// NOT an in-process timer — timers don't survive Render restarts/redeploys and
// don't work across multiple instances. Each run grabs a batch of users who
// signed up at least DELAY_MINUTES ago and haven't been emailed yet, sends, and
// stamps profiles.welcome_email_sent_at so they're never emailed twice.

import { supabaseAdmin } from "../lib/supabase";
import { sendEmail } from "../lib/email";

const SUPPORT_EMAIL = "support@reverseholo.io";
const DELAY_MINUTES = 60; // send ~1 hour after signup
const MAX_AGE_HOURS = 72; // safety guard: never email users who signed up long ago
//                           (so a first deploy / backfill doesn't blast old users)
const BATCH = 100; // cap per sweep run

interface IntroCandidate {
  id: string;
  full_name: string | null;
  created_at: string;
  welcome_email_sent_at: string | null;
}

export interface IntroSweepResult {
  considered: number;
  sent: number;
  skippedNoEmail: number;
  failed: number;
}

// ─── Email content (48-hour promise + one specific ask) ─────────────────────

function buildIntroEmail(firstName: string | null): {
  subject: string;
  html: string;
  text: string;
} {
  const greeting = firstName ? `Hi ${firstName},` : "Hey there,";
  const subject = "A quick hello from Reverse Holo's founder";

  const text = `${greeting}

Most welcome emails come from a no-reply address. This one doesn't — if you hit reply, it lands in my inbox.

I'm Omar, founder of Reverse Holo. We're a small team of collectors and engineers who got tired of watching this hobby grow while the tools stood still. So we're building the ones it deserves — honest grading calls, real market data, a portfolio you can actually trust — to give every collector a genuine edge.

We're building this with collectors, not just for them. You're early, and the people here now are the ones who shape what Reverse Holo becomes. Which is why I want to ask you one thing:

What's the one feature you wish Reverse Holo had?

Just reply to this email and tell me — or reach us in the app, on reverseholo.io, or at ${SUPPORT_EMAIL}. A real person on our team gets back to you within 48 hours, and every message gets read.

Welcome to the community. Let's push this hobby forward together.

Omar
Founder, Reverse Holo`;

  // Deliberately minimal HTML — this should read like a personal email a founder
  // typed, not a designed marketing template. No logo bar, no buttons.
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px;">
  <p>${greeting}</p>
  <p>Most welcome emails come from a no-reply address. This one doesn't — if you hit reply, it lands in my inbox.</p>
  <p>I'm Omar, founder of Reverse Holo. We're a small team of collectors and engineers who got tired of watching this hobby grow while the tools stood still. So we're building the ones it deserves — honest grading calls, real market data, a portfolio you can actually trust — to give every collector a genuine edge.</p>
  <p>We're building this <em>with</em> collectors, not just for them. You're early, and the people here now are the ones who shape what Reverse Holo becomes. Which is why I want to ask you one thing:</p>
  <p style="font-weight:600;">What's the one feature you wish Reverse Holo had?</p>
  <p>Just reply to this email and tell me — or reach us in the app, on reverseholo.io, or at <a href="mailto:${SUPPORT_EMAIL}" style="color:#1a1a1a;">${SUPPORT_EMAIL}</a>. A real person on our team gets back to you within 48 hours, and every message gets read.</p>
  <p>Welcome to the community. Let's push this hobby forward together.</p>
  <p style="margin-top:24px;">Omar<br/>Founder, Reverse Holo</p>
</div>`;

  return { subject, html, text };
}

// ─── The sweep ──────────────────────────────────────────────────────────────

export async function sendPendingIntroEmails(): Promise<IntroSweepResult> {
  const nowMs = Date.now();
  // Signed up before this instant (i.e. at least DELAY_MINUTES ago)…
  const sentBefore = new Date(nowMs - DELAY_MINUTES * 60_000).toISOString();
  // …but not older than MAX_AGE_HOURS (backfill guard).
  const notOlderThan = new Date(
    nowMs - MAX_AGE_HOURS * 60 * 60_000,
  ).toISOString();

  // NOTE: assumes profiles.created_at exists (Supabase default). If your
  // profiles table has no created_at, swap the two .lte/.gte filters to use
  // "email_verification_sent_at" — it's set at signup and always present.
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, created_at, welcome_email_sent_at")
    .is("welcome_email_sent_at", null)
    .lte("created_at", sentBefore)
    .gte("created_at", notOlderThan)
    .limit(BATCH);

  if (error) throw error;

  const candidates = (data ?? []) as IntroCandidate[];
  const result: IntroSweepResult = {
    considered: candidates.length,
    sent: 0,
    skippedNoEmail: 0,
    failed: 0,
  };

  for (const profile of candidates) {
    try {
      // Email lives on auth.users — resolve it the same way auth.controller does.
      const { data: authData } = await supabaseAdmin.auth.admin.getUserById(
        profile.id,
      );
      const email = authData?.user?.email;
      if (!email) {
        result.skippedNoEmail++;
        // Stamp so we don't reconsider this id forever.
        await supabaseAdmin
          .from("profiles")
          .update({ welcome_email_sent_at: new Date().toISOString() })
          .eq("id", profile.id);
        continue;
      }

      const firstName =
        (profile.full_name ?? "").trim().split(/\s+/)[0] || null;
      const { subject, html, text } = buildIntroEmail(firstName);

      await sendEmail({
        to: email,
        subject,
        html,
        text,
        replyTo: SUPPORT_EMAIL,
      });

      // Only stamp on success → a transient send failure retries next sweep.
      await supabaseAdmin
        .from("profiles")
        .update({ welcome_email_sent_at: new Date().toISOString() })
        .eq("id", profile.id);

      result.sent++;
    } catch (err: any) {
      result.failed++;
      console.error(
        `[IntroEmail] failed for ${profile.id}:`,
        err?.message ?? err,
      );
      // leave welcome_email_sent_at null → retried next run (bounded by MAX_AGE_HOURS)
    }
  }

  return result;
}
