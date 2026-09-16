/**
 * Authenticated E2E helpers.
 *
 * These drive the real sign-in UI against the real Convex backend that
 * `scripts/dev-start.sh --ci --app=web` boots for Playwright. Nothing here is
 * mocked — that is the point. The Better Auth <-> Convex adapter integration has
 * no other behavioural coverage, so these helpers are what stands between a
 * breaking adapter upgrade and production.
 *
 * @module qa/e2e/helpers/auth
 */

import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, type Page } from "@playwright/test";

/**
 * The user seeded by `packages/backend/convex/devSeed.ts`. The password is the
 * email repeated three times, and the seed marks the address email-verified, so
 * this account can sign in without an inbox.
 *
 * Signup is `inviteOnly` by default (see `onboardingType.ts`), so tests cannot
 * self-register — every spec shares this one account. Any spec that mutates it
 * (password, 2FA, passkeys) must restore it, and must run serially.
 */
export const SEED_USER = {
  email: "user@user.com",
  password: "user@user.comuser@user.comuser@user.com",
  name: "Dev User",
} as const;

/** `authSignIn` is a 3-per-10s token bucket keyed by email (`rateLimits.ts`). */
const SIGN_IN_RATE_LIMIT = { attempts: 3, windowMs: 10_000 } as const;

const signInTimestamps: number[] = [];

/**
 * Wait, if necessary, so the next sign-in stays inside the per-email rate limit.
 * Without this a serial auth suite trips `failed.rate_limited` and the failure
 * looks like a broken login rather than a pacing problem.
 */
export async function throttleSignIn(): Promise<void> {
  const now = Date.now();
  while (signInTimestamps.length > 0 && now - signInTimestamps[0] > SIGN_IN_RATE_LIMIT.windowMs) {
    signInTimestamps.shift();
  }

  if (signInTimestamps.length >= SIGN_IN_RATE_LIMIT.attempts) {
    const waitMs = SIGN_IN_RATE_LIMIT.windowMs - (now - signInTimestamps[0]) + 250;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    signInTimestamps.shift();
  }

  signInTimestamps.push(Date.now());
}

/**
 * Type into a controlled input and confirm the value stuck.
 *
 * `locator.fill()` does NOT work on this form's inputs: it sets the value and
 * fires a single synthetic `input` event, which these controlled components
 * discard — the field reads back empty and the submit silently does nothing.
 * `pressSequentially` sends real key events, which React always honours.
 *
 * Verified against `#password` on the sign-in form: `fill()` -> `""`,
 * `pressSequentially()` -> the typed value.
 */
export async function fillStable(page: Page, selector: string, value: string): Promise<void> {
  // Typing goes to the focused page, so a backgrounded tab silently swallows
  // every keystroke. Any spec that opens a second tab needs this.
  await page.bringToFront();

  const field = page.locator(selector);
  await field.waitFor({ state: "visible", timeout: 15_000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await field.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await field.pressSequentially(value, { delay: 15 });

    if ((await field.inputValue()) === value) return;
    await page.waitForTimeout(250);
  }

  throw new Error(`Could not get "${selector}" to hold its value after 3 attempts`);
}

/**
 * Submit the email step of the two-step sign-in form and land on the auth step.
 * Selectors target form structure rather than button text, so the 15 locales
 * don't make this brittle.
 */
export async function submitEmailStep(page: Page, email: string): Promise<void> {
  await page.goto("/en/sign-in");
  await fillStable(page, "#email", email);
  await page.locator('form:has(#email) button[type="submit"]').click();
  await expect(page.locator("#password")).toBeVisible({ timeout: 15_000 });
}

/**
 * Complete a full password sign-in. Resolves once the dashboard has rendered,
 * or once a 2FA challenge appears — callers expecting 2FA should use
 * {@link submitEmailStep} plus {@link submitPassword} instead.
 */
export async function signIn(
  page: Page,
  email: string = SEED_USER.email,
  password: string = SEED_USER.password,
): Promise<void> {
  await throttleSignIn();
  await submitEmailStep(page, email);
  await submitPassword(page, password);
  await expectSignedIn(page);
}

/** Fill and submit the password step. Does not assert what happens next. */
export async function submitPassword(page: Page, password: string): Promise<void> {
  await fillStable(page, "#password", password);
  await page.locator('form:has(#password) button[type="submit"]').click();
}

/** Assert the browser holds a usable session by loading a protected route. */
export async function expectSignedIn(page: Page): Promise<void> {
  await page.waitForURL(/\/[a-z]{2}\/dashboard/, { timeout: 20_000 });
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Assert protected routes bounce to sign-in. */
export async function expectSignedOut(page: Page): Promise<void> {
  await page.goto("/en/dashboard");
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 15_000 });
}

/**
 * Sign out through the sidebar account menu, exercising the real
 * `authClient.signOut()` path and the session-delete database hook.
 *
 * `bringToFront` matters: with another tab open this page is backgrounded, and
 * the sidebar's CSS transitions stall while hidden, so Playwright's
 * actionability check on the menu button never settles and the click hangs.
 */
export async function signOut(page: Page): Promise<void> {
  await page.bringToFront();
  await page.goto("/en/dashboard");
  await page.locator('[data-slot="sidebar-footer"] button').first().click();
  await page.getByRole("menuitem").last().click();
  await page.waitForURL((url) => !url.pathname.includes("/dashboard"), { timeout: 15_000 });
}

/**
 * Security settings nest a second tab layer (password / 2fa / passkeys /
 * sessions) inside the account page's own tabs — and both layers read the same
 * `?tab=` query param, so the inner one cannot be deep-linked. Open the security
 * tab, then click through to the sub-tab.
 *
 * Tabs are selected by position rather than label so the 15 locales don't break
 * this.
 */
const SECURITY_TABS = ["password", "2fa", "passkeys", "sessions"] as const;

export type SecurityTab = (typeof SECURITY_TABS)[number];

export async function openSecurityTab(page: Page, tab: SecurityTab): Promise<void> {
  await page.bringToFront();
  await page.goto("/en/dashboard/settings?tab=security");

  // Two tablists are on the page: the account tabs (profile / security) come
  // first, the security sub-tabs second.
  const innerTabs = page.getByRole("tablist").nth(1);
  await expect(innerTabs).toBeVisible({ timeout: 20_000 });

  const trigger = innerTabs.getByRole("tab").nth(SECURITY_TABS.indexOf(tab));
  await trigger.click();
  await expect(trigger).toHaveAttribute("data-state", "active", { timeout: 15_000 });
}

/**
 * Type a code into an `OtpInput`, which renders one `<input maxLength={1}>` per
 * digit and advances focus on each keystroke.
 */
export async function fillOtp(page: Page, code: string): Promise<void> {
  await page.getByLabel("Digit 1 of 6").click();
  await page.keyboard.type(code, { delay: 30 });
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238)
// ---------------------------------------------------------------------------

/** Decode an RFC 4648 base32 string (no padding) into bytes. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/**
 * Compute the current 6-digit TOTP for a base32 secret, matching the
 * `twoFactor` plugin's configuration in `auth.ts` (SHA-1, 30s period, 6 digits).
 *
 * Implemented inline rather than pulling in an OTP dependency — the algorithm is
 * short, and a test-only dependency on the auth stack would defeat the purpose.
 */
export function generateTotp(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Seconds remaining in the current TOTP window. Used to avoid submitting a code
 * that expires mid-request, which would otherwise be a rare, confusing flake.
 */
export function totpSecondsRemaining(atMs: number = Date.now()): number {
  return 30 - Math.floor(atMs / 1000) % 30;
}

/** Wait for a fresh TOTP window if the current one is nearly over. */
export async function awaitStableTotpWindow(minSeconds = 5): Promise<void> {
  const remaining = totpSecondsRemaining();
  if (remaining < minSeconds) {
    await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000));
  }
}

// ---------------------------------------------------------------------------
// Auth emails
// ---------------------------------------------------------------------------

/**
 * With no `RESEND_API_KEY`, `sendAuthEmail` logs a formatted block to the server
 * console, and `dev-start.sh` redirects Convex's output to `.convex-dev.log`.
 * Scraping it is how the email-link flows become testable without an inbox.
 */
const CONVEX_LOG = path.join(__dirname, "../../../../../.convex-dev.log");

export type AuthEmailType = "reset-password" | "verification" | "magic-link" | "email-otp";

function readConvexLog(): string {
  try {
    return fs.readFileSync(CONVEX_LOG, "utf-8");
  } catch {
    return "";
  }
}

/** Byte offset of the log's end, so a later read can ignore earlier emails. */
export function markConvexLogPosition(): number {
  return readConvexLog().length;
}

/**
 * Poll the Convex log for the newest auth email of `type` logged after
 * `fromOffset`, returning the URL or OTP it carries.
 *
 * Convex streams function logs asynchronously, so this polls rather than reading
 * once — the email is typically written within a second of the request.
 */
export async function waitForAuthEmail(
  type: AuthEmailType,
  fromOffset: number,
  timeoutMs = 30_000,
): Promise<string> {
  const label = type.toUpperCase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tail = readConvexLog().slice(fromOffset);
    // The logged block renders as "║  URL:     <value>" (or "Code:" for OTPs).
    const matches = [...tail.matchAll(/AUTH EMAIL \(([A-Z-]+)\s*\)[\s\S]*?(?:URL|Code):\s*(\S+)/g)];
    const match = matches.reverse().find((m) => m[1].trim() === label);
    if (match) return match[2];

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for a ${type} auth email in ${CONVEX_LOG}. ` +
      `Is the Convex dev server logging to that file, and is RESEND_API_KEY unset?`,
  );
}

/** Convert an absolute emailed link into a path Playwright's baseURL can use. */
export function toRelativeUrl(absolute: string): string {
  try {
    const url = new URL(absolute);
    return `${url.pathname}${url.search}`;
  } catch {
    return absolute;
  }
}
