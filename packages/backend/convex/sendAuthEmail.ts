import { assertMockEmailAllowed } from "./developmentOnly";
import { Resend } from "resend";

// ---------------------------------------------------------------------------
// Auth email sender — Resend when configured, console.log fallback for dev
// ---------------------------------------------------------------------------

type AuthEmailType =
  | "reset-password"
  | "verification"
  | "magic-link"
  | "email-otp";

type SendAuthEmailOptions =
  | {
      to: string;
      type: AuthEmailType;
      /** The URL or OTP code to include in the email. */
      urlOrCode: string;
      /** Human-readable link expiry (e.g. "1 hour"). Used by the verification template. */
      linkExpiry?: string;
      subject?: never;
      html?: never;
      text?: never;
    }
  | {
      to: string;
      type: "custom";
      subject: string;
      html: string;
      text: string;
      urlOrCode?: never;
      linkExpiry?: never;
    };

/**
 * Send an authentication email via Resend (if RESEND_API_KEY is set)
 * or fall back to a formatted console.log for local development.
 */
export async function sendAuthEmail(opts: SendAuthEmailOptions): Promise<void> {
  const { to, type } = opts;
  const { subject, html, text } =
    type === "custom"
      ? { subject: opts.subject, html: opts.html, text: opts.text }
      : buildEmailContent(type, opts.urlOrCode, opts.linkExpiry);

  const urlOrCode = type !== "custom" ? opts.urlOrCode : undefined;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    assertMockEmailAllowed();
    // Development fallback — log to server console with clear formatting
    console.log(
      `\n` +
        `╔══════════════════════════════════════════════════════╗\n` +
        `║  AUTH EMAIL (${type.toUpperCase().padEnd(16)})                    ║\n` +
        `╠══════════════════════════════════════════════════════╣\n` +
        `║  To:      ${to}\n` +
        `║  Subject: ${subject}\n` +
        `║  ${type === "email-otp" ? "Code" : "URL"}:     ${urlOrCode ?? "(custom template)"}\n` +
        `╚══════════════════════════════════════════════════════╝\n`,
    );
    return;
  }

  const resend = new Resend(apiKey);
  const emailFrom = process.env.EMAIL_FROM ?? "noreply@example.com";

  await resend.emails.send({
    from: emailFrom,
    to,
    subject,
    html,
    text,
  });
}

// ---------------------------------------------------------------------------
// Email content builders
// ---------------------------------------------------------------------------

function buildEmailContent(
  type: AuthEmailType,
  urlOrCode: string,
  linkExpiry?: string,
): { subject: string; html: string; text: string } {
  switch (type) {
    case "reset-password":
      return {
        subject: "Reset your password",
        html: wrapHtml(
          "Reset your password",
          `<p style="${pStyle}">We received a request to reset your password. Click the link below to set a new password:</p>` +
            ctaButton("Reset password", urlOrCode) +
            `<p style="${smallStyle}">If you didn't request this, you can safely ignore this email. The link expires in 1 hour.</p>` +
            fallbackUrl(urlOrCode),
        ),
        text:
          `Reset your password\n\n` +
          `We received a request to reset your password. Visit the link below to set a new password:\n\n` +
          `${urlOrCode}\n\n` +
          `If you didn't request this, you can safely ignore this email. The link expires in 1 hour.`,
      };

    case "verification": {
      const expiryNote = linkExpiry
        ? `This link is valid for ${escapeHtml(linkExpiry)}. `
        : "";
      const expiryNoteText = linkExpiry
        ? `This link is valid for ${linkExpiry}. `
        : "";
      return {
        subject: "Verify your email address",
        html: wrapHtml(
          "Verify your email",
          `<p style="${pStyle}">Thanks for signing up! Please verify your email address by clicking the link below:</p>` +
            ctaButton("Verify email", urlOrCode) +
            `<p style="${smallStyle}">${expiryNote}If you didn't create an account, you can safely ignore this email.</p>` +
            fallbackUrl(urlOrCode),
        ),
        text:
          `Verify your email address\n\n` +
          `Thanks for signing up! Please verify your email address by visiting:\n\n` +
          `${urlOrCode}\n\n` +
          `${expiryNoteText}If you didn't create an account, you can safely ignore this email.`,
      };
    }

    case "magic-link":
      return {
        subject: "Your sign-in link",
        html: wrapHtml(
          "Sign in to your account",
          `<p style="${pStyle}">Click the link below to sign in to your account:</p>` +
            ctaButton("Sign in", urlOrCode) +
            `<p style="${smallStyle}">This link expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>` +
            fallbackUrl(urlOrCode),
        ),
        text:
          `Sign in to your account\n\n` +
          `Visit the link below to sign in:\n\n` +
          `${urlOrCode}\n\n` +
          `This link expires in 10 minutes. If you didn't request this, you can safely ignore this email.`,
      };

    case "email-otp":
      return {
        subject: `Your verification code is ${urlOrCode}`,
        html: wrapHtml(
          "Your verification code",
          `<p style="${pStyle}">Use the code below to verify your identity:</p>` +
            `<div style="text-align: center; margin: 28px 0;">` +
            `<span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #18181b; background: #f4f4f5; padding: 16px 32px; border-radius: 8px;">${escapeHtml(urlOrCode)}</span>` +
            `</div>` +
            `<p style="${smallStyle}">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>`,
        ),
        text:
          `Your verification code\n\n` +
          `Your verification code is: ${urlOrCode}\n\n` +
          `This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.`,
      };
  }
}

// ---------------------------------------------------------------------------
// HTML helpers — minimal inline-styled email template
// ---------------------------------------------------------------------------

const pStyle =
  "margin: 0 0 16px; font-size: 15px; color: #3f3f46; line-height: 1.6;";
const smallStyle =
  "margin: 0; font-size: 13px; color: #71717a; line-height: 1.5;";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ctaButton(label: string, url: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 28px;">` +
    `<tr><td style="border-radius: 8px; background-color: #18181b;">` +
    `<a href="${escapeHtml(url)}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">` +
    `${escapeHtml(label)}</a></td></tr></table>`
  );
}

function fallbackUrl(url: string): string {
  return (
    `<hr style="border: none; border-top: 1px solid #e4e4e7; margin: 24px 0 16px;">` +
    `<p style="margin: 0; font-size: 12px; color: #a1a1aa; line-height: 1.5;">` +
    `If the button doesn't work, copy and paste this URL into your browser:</p>` +
    `<p style="margin: 6px 0 0; font-size: 12px; color: #a1a1aa; line-height: 1.5; word-break: break-all;">` +
    `${escapeHtml(url)}</p>`
  );
}

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="height: 4px; background: linear-gradient(135deg, #18181b 0%, #3f3f46 100%);"></td>
          </tr>
          <tr>
            <td style="padding: 40px 36px 32px;">
              <h1 style="margin: 0 0 24px; font-size: 22px; font-weight: 700; color: #18181b; line-height: 1.3;">
                ${escapeHtml(title)}
              </h1>
              ${body}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
