import { expect, test } from "@playwright/test";

import {
  expectSignedIn,
  expectSignedOut,
  signIn,
  signOut,
  submitEmailStep,
  submitPassword,
  throttleSignIn,
} from "./helpers/auth";
import { createDisposableUser } from "./helpers/fixtures";

/**
 * Authenticated Session E2E Tests
 *
 * The rest of the auth E2E suite verifies the *unauthenticated* path — guards,
 * redirects, form attributes. These are the tests that actually hold a session,
 * which makes them the only behavioural coverage of the Better Auth <-> Convex
 * adapter.
 *
 * Each test mints its own throwaway account via the dev fixture endpoint, so
 * nothing here shares mutable state and `authSignIn` rate limiting (3 per 10s,
 * keyed by email) cannot couple one test to another.
 */
test.describe.configure({ timeout: 120_000 });

test.describe("Authenticated session", () => {
  test("signs in with email and password and reaches the dashboard", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);

    // The dashboard only renders for a validated session, so reaching it is the
    // assertion. Confirm the signed-in identity is actually ours.
    await expect(page.locator('[data-slot="sidebar-footer"]')).toContainText(
      user.email,
      { timeout: 15_000 },
    );
  });

  test("session survives a full page reload", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);

    await page.reload();

    // A cookie that round-trips but fails server validation would bounce here.
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator('[data-slot="sidebar-footer"]')).toContainText(user.email);
  });

  test("session is shared across tabs in the same context", async ({ page, context }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);

    const secondTab = await context.newPage();
    await secondTab.goto("/en/dashboard");

    await expect(secondTab).toHaveURL(/\/dashboard/);
    await secondTab.close();
  });

  test("signs out and can no longer reach the dashboard", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);
    await signOut(page);

    await expectSignedOut(page);
  });

  // Server-side revocation invalidating another live session is covered by the
  // "revokes all other sessions" test below, which uses a separate browser
  // context. Asserting it across two tabs of one context is not worth it: the
  // backgrounded tab stalls the sidebar's CSS transitions, so the sign-out menu
  // never becomes actionable.

  test("rejects a wrong password without granting a session", async ({ page }) => {
    const user = await createDisposableUser();

    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, "definitely-not-the-password");

    await expect(page.getByText("Invalid email or password")).toBeVisible({ timeout: 15_000 });
    await expectSignedOut(page);
  });
});

/**
 * Previously quarantined on "renders no session cards under Playwright". Not
 * reproducible against a disposable account: the page lists both the current
 * session and the other device, and "Sign out all others" resolves as a single
 * button by role. The earlier symptom was most likely an artefact of sharing
 * the dev-seed account across specs.
 */
test.describe("Session management from settings", () => {
  test("lists the current session and revokes all other sessions", async ({ page, browser }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);

    // Open a second, independent session for the same user so there is
    // something to revoke that is not our own session.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signIn(otherPage, user.email, user.password);
    await expectSignedIn(otherPage);

    await page.bringToFront();
    await page.goto("/en/dashboard/settings/sessions");

    const revokeAll = page.getByRole("button", { name: /sign out all others/i });
    await expect(revokeAll).toBeVisible({ timeout: 15_000 });
    await revokeAll.click();

    // The confirmation is an AlertDialog whose footer is [Cancel, Action]. Take
    // the last button structurally — matching its label would mean tracking the
    // `dashboard.sessions.revokeAllConfirm` string across 15 locales.
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button").last().click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Our own session must survive.
    await page.goto("/en/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);

    // The other one must not.
    await otherPage.goto("/en/dashboard");
    await expect(otherPage).toHaveURL(/\/sign-in/, { timeout: 20_000 });

    await otherContext.close();
  });
});
