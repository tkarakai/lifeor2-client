import { assertMockEmailAllowed } from "./developmentOnly";
import { Resend } from "resend";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { EmailTemplate, TemplateVariables } from "./emailTemplates";
import {
  DEFAULT_EMAIL_TEMPLATE,
  renderEmailTemplate,
} from "./emailTemplates";
import { sha256Hex } from "./tokenHash";

/** Default token expiry in days (can be overridden via appSettings). */
const DEFAULT_EXPIRY_DAYS = 7;

/**
 * Generate a crypto-random invitation token, store it, and send the invitation
 * email via Resend. Scheduled by the `waitlist.invite` mutation.
 */
export const generateTokenAndSendEmail = internalAction({
  args: {
    entryId: v.id("waitlistEntries"),
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
    await ctx.runMutation(internal.waitlistTokens.create, {
      waitlistEntryId: args.entryId,
      tokenHash,
      email: args.email,
      expiresAt,
    });

    // Build the signup URL
    const siteUrlRaw = process.env.SITE_URL;
    if (!siteUrlRaw) {
      throw new Error("Missing required environment variable: SITE_URL");
    }
    const siteUrl = siteUrlRaw.split(",")[0].trim();
    const signupUrl = `${siteUrl}/signup-with-invitation?token=${token}`;

    // Load custom email template (if any), otherwise use default
    const customTemplate = (await ctx.runQuery(
      internal.appSettings.getInternal,
      { key: "invitationEmailTemplate" }
    )) as EmailTemplate | null;

    const template: EmailTemplate = customTemplate ?? DEFAULT_EMAIL_TEMPLATE;

    // Build template variables (renderEmailTemplate handles HTML escaping)
    const variables: TemplateVariables = {
      invitation_link: signupUrl,
      recipient_name: "there",
      expiry_days: String(expiryDays),
    };

    const rendered = renderEmailTemplate(template, variables);

    // Send invitation email via Resend
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
    assertMockEmailAllowed();
      // In development without Resend configured, log the URL instead
      console.log(
        `[waitlist] Invitation email (no RESEND_API_KEY configured):\n` +
          `  To: ${args.email}\n` +
          `  Subject: ${rendered.subject}\n` +
          `  Signup URL: ${signupUrl}\n` +
          `  Expires in: ${expiryDays} days`
      );
      return;
    }

    const resend = new Resend(apiKey);
    const emailFrom = process.env.EMAIL_FROM ?? "noreply@example.com";

    await resend.emails.send({
      from: emailFrom,
      to: args.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  },
});
