import axios from "axios";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
}

/** Sends transactional email via Resend. */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error("RESEND_API_KEY is not configured"), {
      status: 503,
    });
  }

  const from =
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "TruePoint <onboarding@resend.dev>";

  const { data } = await axios.post<{ id?: string }>(
    "https://api.resend.com/emails",
    {
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    },
  );

  return { ok: true, id: data?.id };
}
