import { assertMockEmailAllowed } from "./developmentOnly";
import { Resend } from "resend";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { escapeHtml } from "./emailTemplates";
import { sha256Hex } from "./tokenHash";

/** Default token expiry in days (can be overridden via appSettings). */
const DEFAULT_EXPIRY_DAYS = 7;

/**
 * Generate a crypto-random invitation token, store it, and send the invitation
 * email via Resend. Scheduled by the `adminInvitations.invite` mutation.
 */
export const generateTokenAndSendEmail = internalAction({
  args: {
    adminInvitationId: v.id("adminInvitations"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    // Read configurable expiry from appSettings (admin-configurable, default 7)
    const expiryDays: number =
      ((await ctx.runQuery(internal.appSettings.getInternal, {
        key: "invitationTokenExpiryDays",
      })) as number | null) ?? DEFAULT_EXPIRY_DAYS;

    // Generate crypto-random token (32 bytes = 64 hex chars)
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes, (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");

    const now = Date.now();
    const expiresAt = now + expiryDays * 24 * 60 * 60 * 1000;

    // Store only the SHA-256 hash — the raw token is sent in the email only.
    const tokenHash = sha256Hex(token);
    await ctx.runMutation(internal.adminInvitations.setToken, {
      adminInvitationId: args.adminInvitationId,
      tokenHash,
      expiresAt,
    });

    // Build the admin onboarding URL
    const adminSiteUrlRaw = process.env.ADMIN_SITE_URL;
    if (!adminSiteUrlRaw) {
      throw new Error("Missing required environment variable: ADMIN_SITE_URL");
    }
    const adminSiteUrl = adminSiteUrlRaw.trim();
    const onboardingUrl = `${adminSiteUrl}/onboarding?token=${token}`;

    // Send invitation email via Resend
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
    assertMockEmailAllowed();
      // In development without Resend configured, log the URL instead
      console.log(
        `[admin-invitation] Invitation email (no RESEND_API_KEY configured):\n` +
          `  To: ${args.email}\n` +
          `  Onboarding URL: ${onboardingUrl}\n` +
          `  Expires in: ${expiryDays} days`
      );
      return;
    }

    const resend = new Resend(apiKey);
    const emailFrom = process.env.EMAIL_FROM ?? "noreply@example.com";

    const safeUrl = escapeHtml(onboardingUrl);
    const safeExpiry = escapeHtml(String(expiryDays));

    await resend.emails.send({
      from: emailFrom,
      to: args.email,
      subject: "You've been invited as an administrator",
      html: buildAdminInviteHtml(safeUrl, safeExpiry),
      text: buildAdminInviteText(onboardingUrl, String(expiryDays)),
    });
  },
});

// ---------------------------------------------------------------------------
// Email templates (inline for admin invitations)
// ---------------------------------------------------------------------------

function buildAdminInviteHtml(
  onboardingUrl: string,
  expiryDays: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Invitation</title>
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
                You've been invited as an administrator
              </h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #3f3f46; line-height: 1.6;">
                You've been invited to set up an administrator account. Click the button below to begin the onboarding process. You'll create your account, set up two-factor authentication, and optionally add a passkey.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 28px;">
                <tr>
                  <td style="border-radius: 8px; background-color: #18181b;">
                    <a href="${onboardingUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">
                      Set up your admin account
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 0; font-size: 13px; color: #71717a; line-height: 1.5;">
                This invitation expires in ${expiryDays} days. If you didn't expect this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 36px;">
              <hr style="border: none; border-top: 1px solid #e4e4e7; margin: 0;">
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 36px 32px;">
              <p style="margin: 0; font-size: 12px; color: #a1a1aa; line-height: 1.5;">
                If the button doesn't work, copy and paste this URL into your browser:
              </p>
              <p style="margin: 6px 0 0; font-size: 12px; color: #a1a1aa; line-height: 1.5; word-break: break-all;">
                ${onboardingUrl}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildAdminInviteText(
  onboardingUrl: string,
  expiryDays: string,
): string {
  return `You've been invited as an administrator

You've been invited to set up an administrator account. Visit the link below to begin the onboarding process:

${onboardingUrl}

You'll create your account, set up two-factor authentication, and optionally add a passkey.

This invitation expires in ${expiryDays} days. If you didn't expect this invitation, you can safely ignore this email.`;
}
