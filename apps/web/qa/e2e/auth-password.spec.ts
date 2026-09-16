import { expect, test } from "@playwright/test";

import {
  expectSignedIn,
  fillStable,
  markConvexLogPosition,
  openSecurityTab,
  signIn,
  signOut,
  submitEmailStep,
  submitPassword,
  throttleSignIn,
  throttlePasswordResetRequest,
  waitForAuthEmail,
} from "./helpers/auth";
import { createDisposableUser, disposablePassword } from "./helpers/fixtures";

/**
 * Password Lifecycle E2E Tests
 *
 * Covers changing a password while signed in, and recovering one while signed
 * out via the emailed reset link.
 *
 * Every test mints its own throwaway account, so nothing here can strand shared
 * state — an earlier revision shared the dev-seed user and a mid-flow failure
 * would leave it on a temporary password, cascading into every later spec.
 *
 * The reset link is read from `.convex-dev.log`: with no `RESEND_API_KEY`,
 * `sendAuthEmail` logs the URL to the Convex server console, which
 * `dev-start.sh` redirects to that file.
 */
test.describe.configure({ timeout: 120_000 });

test.describe("Change password while signed in", () => {
  test("changes the password and the new one signs in", async ({ page }) => {
    const user = await createDisposableUser();
    const newPassword = disposablePassword();

    await signIn(page, user.email, user.password);
    await openSecurityTab(page, "password");

    await fillStable(page, "#current-password", user.password);
    await fillStable(page, "#new-password", newPassword);
    await fillStable(page, "#confirm-password", newPassword);
    await page.locator('form:has(#current-password) button[type="submit"]').click();

    await expect(page.getByText(/updated|changed|success/i).first()).toBeVisible({
      timeout: 15_000,
    });

    await signOut(page);

    // The old password must stop working...
    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, user.password);
    await expect(page.getByText("Invalid email or password")).toBeVisible({ timeout: 15_000 });

    // ...and the new one must work.
    await page.context().clearCookies();
    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, newPassword);
    await expectSignedIn(page);
  });

  test("rejects a change when the current password is wrong", async ({ page }) => {
    const user = await createDisposableUser();

    await signIn(page, user.email, user.password);
    await openSecurityTab(page, "password");

    const attempted = disposablePassword();
    await fillStable(page, "#current-password", disposablePassword());
    await fillStable(page, "#new-password", attempted);
    await fillStable(page, "#confirm-password", attempted);
    await page.locator('form:has(#current-password) button[type="submit"]').click();

    await expect(page.getByText(/incorrect|invalid|wrong/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // The original password must still work, proving nothing changed.
    await signOut(page);
    await signIn(page, user.email, user.password);
    await expectSignedIn(page);
  });

  test("revoking other sessions on password change ends them", async ({ page, browser }) => {
    const user = await createDisposableUser();

    await signIn(page, user.email, user.password);

    // A second, independent session for the same account.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signIn(otherPage, user.email, user.password);
    await expectSignedIn(otherPage);

    await page.bringToFront();
    await openSecurityTab(page, "password");

    const newPassword = disposablePassword();
    await fillStable(page, "#current-password", user.password);
    await fillStable(page, "#new-password", newPassword);
    await fillStable(page, "#confirm-password", newPassword);
    await page.locator("#revoke-sessions").check();
    await page.locator('form:has(#current-password) button[type="submit"]').click();

    await expect(page.getByText(/updated|changed|success/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // Ours survives; the other is gone.
    await page.goto("/en/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);

    await otherPage.goto("/en/dashboard");
    await expect(otherPage).toHaveURL(/\/sign-in/, { timeout: 20_000 });

    await otherContext.close();
  });
});

test.describe.serial("Password reset via emailed link", () => {
  // Previously quarantined on a bogus INVALID_CALLBACKURL. The product was fine;
  // `waitForAuthEmail` was capturing the log block's border into the URL's query
  // string. See the regex note in helpers/auth.ts.
  test("resets the password from the emailed link and signs in with it", async ({ page }) => {
    const user = await createDisposableUser();
    const newPassword = disposablePassword();
    const logOffset = markConvexLogPosition();

    await throttlePasswordResetRequest();
    await page.goto("/en/forgot-password");
    await fillStable(page, "#forgot-email", user.email);
    await page.locator('form:has(#forgot-email) button[type="submit"]').click();

    // The response is deliberately generic to avoid email enumeration, so the
    // server log is the only place the link surfaces.
    const resetUrl = await waitForAuthEmail("reset-password", logOffset);
    expect(resetUrl).toContain("reset-password");

    await page.goto(resetUrl);
    await fillStable(page, "#new-password", newPassword);
    await fillStable(page, "#confirm-new-password", newPassword);
    await page.locator('form:has(#new-password) button[type="submit"]').click();

    // The app confirms in place and offers a manual "Sign in now" button rather
    // than redirecting on its own.
    await expect(page.getByText(/password updated|reset successfully/i).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.context().clearCookies();
    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, newPassword);
    await expectSignedIn(page);
  });

  test("a reset link cannot be replayed once consumed", async ({ page }) => {
    const user = await createDisposableUser();
    const firstPassword = disposablePassword();
    const logOffset = markConvexLogPosition();

    await throttlePasswordResetRequest();
    await page.goto("/en/forgot-password");
    await fillStable(page, "#forgot-email", user.email);
    await page.locator('form:has(#forgot-email) button[type="submit"]').click();

    const resetUrl = await waitForAuthEmail("reset-password", logOffset);

    // Consume it once.
    await page.goto(resetUrl);
    await fillStable(page, "#new-password", firstPassword);
    await fillStable(page, "#confirm-new-password", firstPassword);
    await page.locator('form:has(#new-password) button[type="submit"]').click();
    await expect(page.getByText(/password updated|reset successfully/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // Replaying the same token must not reset again.
    await page.context().clearCookies();
    const secondPassword = disposablePassword();
    await page.goto(resetUrl);

    const stillHasForm = await page
      .locator("#new-password")
      .isVisible()
      .catch(() => false);

    if (stillHasForm) {
      await fillStable(page, "#new-password", secondPassword);
      await fillStable(page, "#confirm-new-password", secondPassword);
      await page.locator('form:has(#new-password) button[type="submit"]').click();
      await expect(page.getByText(/invalid|expired|not valid|already/i).first()).toBeVisible({
        timeout: 20_000,
      });
    } else {
      // The page rejected the spent token before offering the form at all.
      await expect(page.getByText(/invalid|expired|not valid|already/i).first()).toBeVisible({
        timeout: 20_000,
      });
    }

    // The password from the first, legitimate reset is the one that stands.
    await page.context().clearCookies();
    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, firstPassword);
    await expectSignedIn(page);
  });

  test("requesting a reset for an unknown address does not reveal that it is unknown", async ({
    page,
  }) => {
    await throttlePasswordResetRequest();
    await page.goto("/en/forgot-password");
    await fillStable(page, "#forgot-email", "e2e-definitely-not-registered@e2e.local");
    await page.locator('form:has(#forgot-email) button[type="submit"]').click();

    // Same generic confirmation as a real address — no enumeration signal.
    await expect(page.getByText(/not found|no account|does not exist/i)).toHaveCount(0);
  });
});

test.describe("Signed-out guards", () => {
  test("settings is not reachable without a session", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/en/dashboard/settings");
    await expect(page).toHaveURL(/\/sign-in/, { timeout: 15_000 });
  });
});
