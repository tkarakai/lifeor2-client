import { test, expect } from "@playwright/test";

import { fillStable, submitEmailStep } from "./helpers/auth";

/**
 * Authentication Flow E2E Tests
 *
 * These tests verify the sign-in, sign-up, and sign-out flows work correctly
 * and that error handling prevents information leakage.
 *
 * NOTE: These tests require the dev server running with a real Convex backend.
 * Some tests create real user accounts — use unique emails per test run.
 */

const TEST_EMAIL_PREFIX = `e2e-auth-${Date.now()}`;

test.describe("Sign-In Flow", () => {
  test("shows generic error for wrong password (no email enumeration)", async ({
    page,
  }) => {
    // Sign-in is a two-step form: #password does not exist until the email
    // step is submitted.
    await submitEmailStep(page, "nonexistent@example.com");
    await fillStable(page, "#password", "wrongpassword123");
    await page.locator('form:has(#password) button[type="submit"]').click();

    // Wait for the error message to appear
    const errorBox = page.locator(".rounded-md.border.bg-muted");
    await expect(errorBox).toBeVisible({ timeout: 10000 });

    // Error must be generic — NOT "User not found" or similar
    const errorText = await errorBox.textContent();
    expect(errorText).toBe("Invalid email or password");
    expect(errorText).not.toContain("not found");
    expect(errorText).not.toContain("does not exist");
  });

  test("each step of the sign-in form has the right required field", async ({
    page,
  }) => {
    // Step 1 offers the email only — there is no single screen carrying both
    // fields any more, so this asserts each step in turn.
    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    const emailInput = page.locator("#email");
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute("type", "email");
    await expect(emailInput).toHaveAttribute("required", "");
    await expect(page.locator("#password")).toHaveCount(0);

    // Step 2 swaps in the password.
    await submitEmailStep(page, "nonexistent@example.com");

    const passwordInput = page.locator("#password");
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toHaveAttribute("type", "password");
    await expect(passwordInput).toHaveAttribute("required", "");
  });

  test("unauthenticated user accessing /dashboard is redirected to /sign-in", async ({
    page,
  }) => {
    await page.goto("/en/dashboard");
    // Should end up on sign-in page
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test("password field is type=password (not plain text)", async ({ page }) => {
    await submitEmailStep(page, "nonexistent@example.com");

    const passwordInput = page.locator("#password");
    await expect(passwordInput).toHaveAttribute("type", "password");
  });
});

/**
 * Sign-up is gated. `onboardingType` defaults to `inviteOnly`
 * (`packages/backend/convex/onboardingType.ts`), and the self-service form only
 * renders under `publicSignup`.
 *
 * These previously asserted #name / #password / #confirm-password on
 * /en/sign-up. That form has not existed under the default setting for a long
 * time, and the tests had been failing unnoticed because SKIP_E2E hid them.
 * They now cover the gate itself, which is the security-relevant behaviour:
 * a stranger must not be able to self-register.
 */
test.describe("Sign-Up Flow (invitation-gated)", () => {
  test("offers no self-registration form under the default onboarding type", async ({
    page,
  }) => {
    await page.goto("/en/sign-up");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/invitation only/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // No credential fields at all — not a hidden or disabled form.
    await expect(page.locator("#name")).toHaveCount(0);
    await expect(page.locator("#password")).toHaveCount(0);
    await expect(page.locator("#confirm-password")).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test("points would-be users at the waitlist instead", async ({ page }) => {
    await page.goto("/en/sign-up");
    await page.waitForLoadState("networkidle");

    // The only route forward is the waitlist on the marketing site. Note there
    // is deliberately no "back to sign in" link here — if one is ever added,
    // this is the test that should start asserting it.
    const waitlist = page.getByRole("link", { name: /waitlist/i }).first();
    await expect(waitlist).toBeVisible({ timeout: 15_000 });
    await expect(waitlist).toHaveAttribute("href", /.+/);
  });
});

test.describe("Auth Route Guards", () => {
  test("authenticated user accessing /sign-in is redirected to /dashboard", async ({
    page,
    context,
  }) => {
    // Set a session cookie to simulate an authenticated user.
    // The proxy layer checks cookie presence (not validity), so this
    // will trigger the redirect to /dashboard.
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "fake-session-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    // Intercept network to capture the redirect before Playwright follows it
    const redirectUrls: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers()["location"];
        if (location) redirectUrls.push(location);
      }
    });

    await page.goto("/en/sign-in", { waitUntil: "commit" });

    // The proxy should issue a 307 redirect to /en/dashboard
    const dashboardRedirect = redirectUrls.some((url) =>
      url.includes("/dashboard")
    );
    expect(dashboardRedirect).toBe(true);
  });

  test("authenticated user accessing /sign-up is redirected to /dashboard", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "fake-session-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    const redirectUrls: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers()["location"];
        if (location) redirectUrls.push(location);
      }
    });

    await page.goto("/en/sign-up", { waitUntil: "commit" });

    const dashboardRedirect = redirectUrls.some((url) =>
      url.includes("/dashboard")
    );
    expect(dashboardRedirect).toBe(true);
  });
});
