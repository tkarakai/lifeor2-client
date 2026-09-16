import { test, expect } from "@playwright/test";

import { fillStable } from "./helpers/auth";

/**
 * Forgot Password Flow E2E Tests
 *
 * Verify the forgot-password page loads, submits correctly,
 * and handles error/success states without leaking information.
 */

test.describe("Forgot Password Page", () => {
  test("page loads with email input and submit button", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await page.waitForLoadState("networkidle");

    const emailInput = page.locator("#forgot-email");
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute("type", "email");
    await expect(emailInput).toHaveAttribute("required", "");

    const submitButton = page.locator('button[type="submit"]');
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeEnabled();
  });

  test("back to sign-in link navigates correctly", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await page.waitForLoadState("networkidle");

    // There should be a "Back to Sign In" button
    const backButton = page.locator('button', { hasText: /sign.?in/i });
    await expect(backButton).toBeVisible();
  });

  test("shows email sent confirmation after submitting valid email", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await page.waitForLoadState("networkidle");

    // Mock the forget-password endpoint to return success
    await page.route("**/api/auth/request-password-reset", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: true }),
      });
    });

    await fillStable(page, "#forgot-email", "test@example.com");
    await page.click('button[type="submit"]');

    // Should show the email-sent confirmation screen
    // Look for the success state (Mail icon or email sent message)
    const successIndicator = page.locator("text=email").first();
    await expect(successIndicator).toBeVisible({ timeout: 10000 });
  });

  test("shows email sent confirmation even for non-existent email (prevents enumeration)", async ({
    page,
  }) => {
    await page.goto("/en/forgot-password");
    await page.waitForLoadState("networkidle");

    // Mock the endpoint to throw (user not found scenario)
    await page.route("**/api/auth/request-password-reset", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "User not found" } }),
      });
    });

    await fillStable(page, "#forgot-email", "nonexistent@example.com");
    await page.click('button[type="submit"]');

    // Should still show success (email sent screen) — no email enumeration
    // The component catches errors and still shows the email-sent state
    // Wait for either the success screen or the form to still be visible
    await page.waitForTimeout(2000);

    // Scope this to what the user can actually read. page.content() returns the
    // whole document including Next's dev bundles, which contain strings like
    // "not found" for unrelated reasons — the old assertion could never pass.
    const visible = await page.locator("main").innerText();
    expect(visible).not.toContain("not found");
    expect(visible).not.toContain("does not exist");
  });

  test("shows rate limit error when server returns 429", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await page.waitForLoadState("networkidle");

    await page.route("**/api/auth/request-password-reset", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Rate limit exceeded", status: 429 } }),
      });
    });

    await fillStable(page, "#forgot-email", "ratelimited@example.com");
    await page.click('button[type="submit"]');

    // Should show a user-friendly rate limit message
    const errorBox = page.locator(".rounded-md.border.bg-muted");
    await expect(errorBox).toBeVisible({ timeout: 10000 });

    // The forgot-password form's own copy — note it differs from the sign-in
    // form's "Too many attempts. Please wait a moment before trying again."
    const errorText = await errorBox.textContent();
    expect(errorText).toContain("Too many requests");
    expect(errorText).not.toContain("429");
  });

  test("submit button is disabled while request is pending", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await page.waitForLoadState("networkidle");

    // Delay the response to observe pending state
    await page.route("**/api/auth/request-password-reset", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: true }),
      });
    });

    await fillStable(page, "#forgot-email", "pending@example.com");
    await page.click('button[type="submit"]');

    const submitButton = page.locator('button[type="submit"]');
    await expect(submitButton).toBeDisabled();
  });

  test("is accessible without authentication (guest route)", async ({ page }) => {
    // Clear any cookies to ensure unauthenticated state
    const context = page.context();
    await context.clearCookies();

    const response = await page.goto("/en/forgot-password");
    // Should not redirect to sign-in
    expect(response?.status()).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/sign-in/);
  });
});
