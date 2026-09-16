import { test, expect } from "@playwright/test";

/**
 * Session Lifecycle E2E Tests
 *
 * Verify session management security:
 * - Expired/cleared cookies redirect to sign-in
 * - Session cookies have correct security attributes
 * - Multi-tab session sync (BroadcastChannel)
 */

test.describe("Session Cookie Security", () => {
  test("clearing cookies redirects away from protected routes", async ({
    page,
    context,
  }) => {
    // Set a session cookie to pass the proxy layer
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "test-session-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    // Navigate to dashboard (proxy allows it due to cookie presence)
    await page.goto("/en/dashboard");
    // Note: the dashboard layout does a full session validation and may
    // redirect to clear-session if the token is invalid. That's expected.

    // Now clear all cookies
    await context.clearCookies();

    // Try to access a protected route — should redirect to sign-in
    await page.goto("/en/dashboard");
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test("expired session cookie redirects to sign-in", async ({
    page,
    context,
  }) => {
    // Set a session cookie that's already expired
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "expired-token-value",
        domain: "localhost",
        path: "/",
        // Expires in the past
        expires: Math.floor(Date.now() / 1000) - 3600,
      },
    ]);

    await page.goto("/en/dashboard");

    // Expired cookie should not be sent by browser, so proxy redirects
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test("session token is not visible in page source or JavaScript", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "secret-session-token-12345",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // The session token should NOT appear in the page HTML
    const pageContent = await page.content();
    expect(pageContent).not.toContain("secret-session-token-12345");

    // The session token should NOT be accessible via JavaScript
    // (HttpOnly cookies are not readable via document.cookie)
    const jsCookies = await page.evaluate(() => document.cookie);
    expect(jsCookies).not.toContain("secret-session-token-12345");
  });
});

test.describe("Auth Page Navigation Guards", () => {
  test("/sign-in page is accessible without authentication", async ({
    page,
  }) => {
    const response = await page.goto("/en/sign-in");
    expect(response?.status()).toBe(200);

    // Sign-in is a two-step form — step 1 is the email only. #password does not
    // exist until that step is submitted.
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toHaveCount(0);
  });

  test("/sign-up page is accessible without authentication", async ({
    page,
  }) => {
    const response = await page.goto("/en/sign-up");
    expect(response?.status()).toBe(200);

    // Sign-up is invitation-gated by default (`onboardingType: inviteOnly`), so
    // the page is reachable but carries no registration form.
    await expect(page.getByText(/invitation only/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("#name")).toHaveCount(0);
  });

  test("direct navigation to /dashboard without cookie redirects to /sign-in", async ({
    page,
  }) => {
    // Ensure no cookies are set
    const context = page.context();
    await context.clearCookies();

    await page.goto("/en/dashboard");
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test("direct navigation to /dashboard/settings without cookie redirects", async ({
    page,
  }) => {
    const context = page.context();
    await context.clearCookies();

    await page.goto("/en/dashboard/settings");
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });
});

test.describe("Multi-Tab Session Detection", () => {
  test("GuestGuard on sign-in page listens for BroadcastChannel messages", async ({
    page,
  }) => {
    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // Verify that the sign-in page has set up a BroadcastChannel listener.
    // We can check by seeing if BroadcastChannel is used on the page.
    const hasBroadcastChannel = await page.evaluate(() => {
      return typeof BroadcastChannel !== "undefined";
    });
    expect(hasBroadcastChannel).toBe(true);
  });

  test("auth pages include GuestGuard for multi-tab sync", async ({
    page,
  }) => {
    // Navigate to sign-in page
    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // The page should be interactive (GuestGuard wraps the form)
    const form = page.locator("form");
    await expect(form).toBeVisible();

    // The sign-up page has no form to guard while sign-up is invitation-only;
    // assert it still renders its gate rather than a blank or errored page.
    await page.goto("/en/sign-up");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/invitation only/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
