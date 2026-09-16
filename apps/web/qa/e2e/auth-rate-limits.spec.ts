import { test, expect } from "@playwright/test";

import { fillStable, submitEmailStep } from "./helpers/auth";

/**
 * Auth Rate Limit E2E Tests
 *
 * Verify that the sign-in/sign-up forms handle rate limiting correctly:
 * - Better Auth rate limits: sign-in (3/10s), sign-up (5/60s)
 * - The UI shows a user-friendly rate limit message
 *
 * NOTE: These tests hit the real auth endpoints and may trigger actual
 * rate limits. They use unique emails to avoid side effects.
 *
 * Sign-in is a two-step form: #password only exists after the email step is
 * submitted, and the email cannot be re-entered without going back. Route mocks
 * are installed *after* the email step so they do not intercept it.
 */

test.describe("Sign-In Rate Limiting", () => {
  test("shows rate limit error when server returns 429", async ({
    page,
  }) => {
    await submitEmailStep(page, "ratelimit-test@example.com");

    // Mock the auth endpoint to return a 429 rate limit response
    await page.route("**/api/auth/sign-in/email", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ message: "Rate limit exceeded" }),
      });
    });

    await fillStable(page, "#password", "wrongpassword");
    await page.locator('form:has(#password) button[type="submit"]').click();

    // The UI should show the user-friendly rate limit message
    const errorBox = page.locator(".rounded-md.border.bg-muted");
    await expect(errorBox).toBeVisible({ timeout: 10000 });

    const errorText = await errorBox.textContent();
    expect(errorText).toBe("Too many attempts. Please wait a moment before trying again.");
  });

  test("rate limit error message does not expose internals", async ({
    page,
  }) => {
    await submitEmailStep(page, "ratelimit-internal@example.com");

    // Even if rate limited, the message should be user-friendly and not expose
    // server details. The email step is behind us, so hammer the password step.
    for (let i = 0; i < 5; i++) {
      await fillStable(page, "#password", "wrong");
      await page.locator('form:has(#password) button[type="submit"]').click();
      await page.waitForTimeout(300);
    }

    const errorBox = page.locator(".rounded-md.border.bg-muted");
    if (await errorBox.isVisible()) {
      const text = await errorBox.textContent();
      // Should never expose server error details
      expect(text).not.toContain("429");
      expect(text).not.toContain("rate_limit");
      expect(text).not.toContain("Too Many Requests");
      expect(text).not.toContain("x-forwarded-for");
    }
  });
});

test.describe("Sign-In Form Security", () => {
  test("submit button is disabled while request is pending", async ({
    page,
  }) => {
    await submitEmailStep(page, "pending-test@example.com");
    await fillStable(page, "#password", "somepassword123");

    // Intercept the auth request to delay it
    await page.route("**/api/auth/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });

    const submitButton = page.locator('form:has(#password) button[type="submit"]');
    await submitButton.click();

    // Button should be disabled while pending
    await expect(submitButton).toBeDisabled();
  });

  test("error is cleared when form is resubmitted", async ({ page }) => {
    await submitEmailStep(page, "error-clear@example.com");

    // First attempt: trigger an error
    await fillStable(page, "#password", "wrong");
    await page.locator('form:has(#password) button[type="submit"]').click();

    const errorBox = page.locator(".rounded-md.border.bg-muted");
    await expect(errorBox).toBeVisible({ timeout: 10000 });

    // Intercept the next request to hold it pending so we can observe
    // the error being cleared before a new response arrives
    await page.route("**/api/auth/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });

    // Second attempt: error should be cleared during submission
    await fillStable(page, "#password", "anotherpassword");
    await page.locator('form:has(#password) button[type="submit"]').click();

    // While the request is pending, the old error should be hidden
    await expect(errorBox).not.toBeVisible({ timeout: 2000 });
  });
});
