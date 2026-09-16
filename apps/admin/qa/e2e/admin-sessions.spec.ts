import { test, expect } from "@playwright/test";

import { signInAsAdmin } from "./helpers/auth";

/**
 * Admin User Sessions E2E Tests
 *
 * Verify sessions management is available through the Users page.
 *
 * NOTE: These tests require authentication to the admin app.
 * The admin app uses cookie-based auth like the web app.
 */

test.describe("Admin User Sessions", () => {
  test("users page requires authentication", async ({ page }) => {
    // Clear cookies to ensure unauthenticated state
    const context = page.context();
    await context.clearCookies();

    await page.goto("/manage/users");
    // Should redirect to sign-in
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("legacy sessions route redirects to users when authenticated", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/dashboard/sessions");
    await expect(page).toHaveURL(/\/manage\/users/);
  });

  test("users page has user search input", async ({ page }) => {
    await signInAsAdmin(page);

    // Not networkidle: once signed in, Convex holds a live websocket open and
    // the network never goes idle, so the wait burns the whole test timeout.
    await page.goto("/manage/users");

    // Assert unconditionally — the old `if (visible)` guard meant this test
    // could not fail, and it was running against /sign-in anyway.
    await expect(page.locator('input[placeholder*="Search"]')).toBeVisible({
      timeout: 20_000,
    });
  });
});
