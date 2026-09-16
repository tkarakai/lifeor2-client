import { test, expect } from "@playwright/test";

import { fillStable } from "./helpers/auth";

test.describe("Admin Sign-In Page", () => {
  test("loads and displays the correct title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Admin - Web App Starter");
  });

  test("displays the sign-in form", async ({ page }) => {
    // Two-step form: the email step comes first and #password does not exist
    // until it is submitted, so assert each step in turn.
    await page.goto("/");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.locator("#password")).toHaveCount(0);

    await fillStable(page, "#email", "nobody@e2e.local");
    await page.locator('form:has(#email) button[type="submit"]').click();

    await expect(page.locator("#password")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('form:has(#password) button[type="submit"]'),
    ).toBeVisible();
  });

  test("has no console errors on load", async ({ page }) => {
    // Strings, not ConsoleMessage objects: a failure on the object array
    // prints an unreadable dump of Playwright internals, which makes a CI
    // failure impossible to diagnose without re-running locally.
    const consoleErrors: string[] = [];

    const isExpectedError = (text: string, locationUrl: string): boolean => {
      const isAuthSessionUrl = /\/api\/auth\/get-session/.test(locationUrl);
      const is400Error = /400|Bad Request/.test(text);
      const isFailedToLoad = /Failed to load resource/.test(text);

      if (isAuthSessionUrl && (is400Error || isFailedToLoad)) {
        return true;
      }

      if (/\/api\/auth\/get-session.*400/.test(text)) {
        return true;
      }

      return false;
    };

    page.on("console", (message) => {
      if (message.type() === "error") {
        const text = message.text();
        const locationUrl = message.location().url;
        if (!isExpectedError(text, locationUrl)) {
          consoleErrors.push(`${message.text()} @ ${message.location().url}`);
        }
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(consoleErrors).toHaveLength(0);
  });

  test("main element is visible", async ({ page }) => {
    await page.goto("/");
    const mainElement = page.locator("main");
    await expect(mainElement).toBeVisible();
  });
});
