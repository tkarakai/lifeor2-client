import { test, expect } from "@playwright/test";

/**
 * Playwright E2E tests for the web app.
 * These tests verify the homepage loads correctly and basic navigation works.
 */

test.describe("Homepage", () => {
  test("loads and displays the correct title", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle("Web App Starter");
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
});

test.describe("Accessibility", () => {
  test("page has proper heading hierarchy", async ({ page }) => {
    await page.goto("/");

    const h1Elements = page.getByRole("heading", { level: 1 });
    await expect(h1Elements).toHaveCount(1);

    const mainElement = page.locator("main");
    await expect(mainElement).toBeVisible();
  });

  test("interactive elements are keyboard accessible", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    const focusedElement = page.locator(":focus");
    await expect(focusedElement).toBeVisible();
  });
});
