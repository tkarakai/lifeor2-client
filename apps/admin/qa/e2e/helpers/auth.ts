/**
 * Authenticated E2E helpers for the admin app.
 *
 * Admin specs used to "authenticate" by planting a fabricated
 * `better-auth.session_token` cookie. That satisfies the proxy, which only
 * checks the cookie is present, but not the dashboard layout, which validates
 * the session server-side — so every such test actually landed on /sign-in.
 * Strict assertions failed; lenient ones passed vacuously, which is worse.
 *
 * These helpers sign in for real against a disposable admin account.
 *
 * @module qa/e2e/helpers/auth
 */

import { expect, type Page } from "@playwright/test";

import { createDisposableUser } from "./fixtures";

/**
 * Type into a controlled input and confirm the value stuck.
 *
 * `locator.fill()` sets the value and fires one synthetic event, which these
 * controlled components discard — the field reads back empty and the submit
 * silently does nothing. `pressSequentially` sends real key events.
 */
export async function fillStable(page: Page, selector: string, value: string): Promise<void> {
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
 * Sign in as a freshly minted admin. Sign-in is a two-step form: the email step
 * must be submitted before #password exists.
 */
export async function signInAsAdmin(page: Page): Promise<void> {
  const user = await createDisposableUser({ isAdmin: true });

  await page.goto("/sign-in");
  await fillStable(page, "#email", user.email);
  await page.locator('form:has(#email) button[type="submit"]').click();

  await expect(page.locator("#password")).toBeVisible({ timeout: 15_000 });
  await fillStable(page, "#password", user.password);
  await page.locator('form:has(#password) button[type="submit"]').click();

  await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 20_000 });
}
