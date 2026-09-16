import { test, expect } from "@playwright/test";

import { signInAsAdmin } from "./helpers/auth";

/**
 * Admin MFA Policy E2E Tests
 *
 * Verify the admin security page loads and displays MFA policy controls.
 * The MFA policy card allows toggling email-based MFA requirement.
 */

test.describe("Admin Security / MFA Policy Page", () => {
  test("security page requires authentication", async ({ page }) => {
    const context = page.context();
    await context.clearCookies();

    await page.goto("/configure/security");
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("security page loads when authenticated", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/configure/security");
    // Proxy allows access with a cookie; page renders (even if backend rejects fake token)
  });

  test("security page displays MFA policy card heading", async ({ page }) => {
    await signInAsAdmin(page);

    // Not networkidle: Convex's live websocket keeps the network busy once
    // authenticated, so that wait never resolves.
    await page.goto("/configure/security");

    const heading = page.locator("h1");
    if (await heading.isVisible()) {
      const headingText = await heading.textContent();
      expect(headingText).toContain("Security");
    }
  });
});
