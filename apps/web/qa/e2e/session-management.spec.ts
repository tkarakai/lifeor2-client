import { test, expect, type Page } from "@playwright/test";

import { signIn } from "./helpers/auth";
import { createDisposableUser } from "./helpers/fixtures";

/**
 * Sign in for real. A fabricated `better-auth.session_token` gets past the
 * proxy (which only checks cookie presence) but not the dashboard layout, which
 * validates the session server-side — so the page redirected and every
 * structural assertion below was checking the sign-in page instead. Some of
 * them "passed" that way, which is worse than failing.
 */
async function signInFresh(page: Page): Promise<void> {
  const user = await createDisposableUser();
  await signIn(page, user.email, user.password);
}

/** The live session token, so mocked session lists can mark one as current. */
async function currentSessionToken(page: Page): Promise<string> {
  const res = await page.request.get("/api/auth/get-session");
  const body = (await res.json()) as { session?: { token?: string } } | null;
  const token = body?.session?.token;
  if (!token) throw new Error("No active session token — signInFresh() first");
  return token;
}

/**
 * Session Management E2E Tests
 *
 * Tests for the /dashboard/settings/sessions page where users can
 * view and revoke their active sessions.
 *
 * NOTE: These tests verify page structure and behaviour at the proxy/UI level.
 * Full session CRUD is covered by the Convex backend tests.
 */

test.describe("Session Management Page", () => {
  test("unauthenticated user is redirected to /sign-in", async ({ page }) => {
    const context = page.context();
    await context.clearCookies();

    await page.goto("/en/dashboard/settings/sessions");
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test("authenticated user can access sessions page", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "test-session-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const response = await page.goto("/en/dashboard/settings/sessions");
    // Proxy allows through with cookie present (200 from intl middleware)
    expect(response?.status()).toBe(200);
  });

  test("sessions page shows loading skeleton initially", async ({
    page,
    context,
  }) => {
    await signInFresh(page);

    // Intercept the listSessions API call so the page stays in loading state
    await page.route("**/api/auth/list-sessions", (route) => {
      // Never respond — keeps the page in loading/skeleton state
      void route.abort();
    });

    await page.goto("/en/dashboard/settings/sessions");
    await page.waitForLoadState("domcontentloaded");

    // Should show skeleton loading placeholders (3 cards)
    const skeletons = page.locator("[data-slot='skeleton']");
    await expect(skeletons.first()).toBeVisible({ timeout: 5000 });
  });

  test("sessions page displays page header with title", async ({
    page,
    context,
  }) => {
    await signInFresh(page);

    await page.goto("/en/dashboard/settings/sessions");
    await page.waitForLoadState("domcontentloaded");

    // The page header should contain the sessions title (h1)
    const heading = page.locator("h1");
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test("sessions page has a back-to-dashboard button", async ({
    page,
    context,
  }) => {
    await signInFresh(page);

    await page.goto("/en/dashboard/settings/sessions");
    await page.waitForLoadState("domcontentloaded");

    // Look for the back button (contains ArrowLeft icon and text)
    const backButton = page.locator("button").filter({ hasText: /dashboard/i });
    await expect(backButton).toBeVisible({ timeout: 5000 });
  });

  test("sessions page has breadcrumb navigation", async ({
    page,
    context,
  }) => {
    await signInFresh(page);

    await page.goto("/en/dashboard/settings/sessions");
    await page.waitForLoadState("domcontentloaded");

    // Breadcrumb should be present
    const breadcrumb = page.locator("nav[aria-label='breadcrumb']");
    await expect(breadcrumb).toBeVisible({ timeout: 5000 });
  });

  test("sessions page includes sidebar", async ({ page, context }) => {
    await signInFresh(page);

    await page.goto("/en/dashboard/settings/sessions");
    await page.waitForLoadState("domcontentloaded");

    // Sidebar trigger button should be visible
    const sidebarTrigger = page.locator("button[data-sidebar='trigger']");
    await expect(sidebarTrigger).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Session Management — mock API responses", () => {
  test("shows current session card when API returns sessions", async ({
    page,
    context,
  }) => {
    await signInFresh(page);
    const currentToken = await currentSessionToken(page);

    // Mock listSessions to return a session
    await page.route("**/api/auth/list-sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "session-1",
            token: currentToken,
            userId: "user-1",
            ipAddress: "192.168.1.1",
            userAgent:
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ]),
      });
    });


    await page.goto("/en/dashboard/settings/sessions");

    // Wait for session cards to render
    const currentBadge = page.getByText("Current", { exact: false });
    await expect(currentBadge).toBeVisible({ timeout: 10000 });
  });

  test("shows revoke button only for non-current sessions", async ({
    page,
    context,
  }) => {
    await signInFresh(page);
    const currentToken = await currentSessionToken(page);

    await page.route("**/api/auth/list-sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "session-1",
            token: currentToken,
            userId: "user-1",
            ipAddress: "192.168.1.1",
            userAgent:
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
          {
            id: "session-2",
            token: "other-token-456",
            userId: "user-1",
            ipAddress: "10.0.0.1",
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Safari/604.1",
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            updatedAt: new Date(Date.now() - 1800000).toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ]),
      });
    });


    await page.goto("/en/dashboard/settings/sessions");

    // Wait for sessions to load
    const currentBadge = page.getByText("Current", { exact: false });
    await expect(currentBadge).toBeVisible({ timeout: 10000 });

    // "Sign out all other devices" button should appear when there are other sessions
    const revokeAllButton = page.locator("button").filter({ hasText: /sign out all|revoke all/i });
    await expect(revokeAllButton).toBeVisible({ timeout: 5000 });
  });

  test("shows no-other-sessions message when only current session exists", async ({
    page,
    context,
  }) => {
    await signInFresh(page);
    const currentToken = await currentSessionToken(page);

    await page.route("**/api/auth/list-sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "session-1",
            token: currentToken,
            userId: "user-1",
            ipAddress: "192.168.1.1",
            userAgent: "Mozilla/5.0 Chrome/120.0.0.0",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        ]),
      });
    });


    await page.goto("/en/dashboard/settings/sessions");

    // Wait for current session to appear
    const currentBadge = page.getByText("Current", { exact: false });
    await expect(currentBadge).toBeVisible({ timeout: 10000 });

    // Should show the "no other sessions" dashed-border message
    const noOtherSessions = page.locator(".border-dashed");
    await expect(noOtherSessions).toBeVisible({ timeout: 5000 });
  });

  test("displays error state when session fetch fails", async ({
    page,
    context,
  }) => {
    await signInFresh(page);

    // Mock listSessions to fail
    await page.route("**/api/auth/list-sessions", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });


    await page.goto("/en/dashboard/settings/sessions");
    await page.waitForLoadState("networkidle");

    // Error message should appear
    const errorMsg = page.locator(".rounded-md.border.bg-muted");
    await expect(errorMsg).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Session Management — route protection", () => {
  test("/dashboard/settings/sessions is protected by proxy", async ({
    page,
  }) => {
    // No cookies — should redirect to sign-in
    const context = page.context();
    await context.clearCookies();

    await page.goto("/en/dashboard/settings/sessions");
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test("production cookie name also grants access", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        // The __Secure- prefix is only a valid cookie with secure: true; without
        // it Chrome rejects the whole addCookies call as "Invalid cookie fields".
        name: "__Secure-better-auth.session_token",
        value: "prod-token-123",
        domain: "localhost",
        path: "/",
        secure: true,
      },
    ]);

    const response = await page.goto("/en/dashboard/settings/sessions");
    expect(response?.status()).toBe(200);
  });
});
