import { test, expect } from "@playwright/test";

test.describe("Landing Homepage", () => {
  test("loads and displays the correct title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Web App Starter");
  });

  test("displays main heading", async ({ page }) => {
    await page.goto("/");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();
  });

  test("has no console errors on load", async ({ page }) => {
    // Strings, not ConsoleMessage objects: a failure on the object array
    // prints an unreadable dump of Playwright internals, which makes a CI
    // failure impossible to diagnose without re-running locally.
    const consoleErrors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(`${message.text()} @ ${message.location().url}`);
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(consoleErrors).toHaveLength(0);
  });

  test("page has proper heading hierarchy", async ({ page }) => {
    await page.goto("/");
    const h1Elements = page.getByRole("heading", { level: 1 });
    await expect(h1Elements).toHaveCount(1);
    const mainElement = page.locator("main");
    await expect(mainElement).toBeVisible();
  });
});

test.describe("Footer", () => {
  test("displays footer with legal links", async ({ page }) => {
    await page.goto("/");
    const footer = page.locator("footer");
    await expect(footer).toBeVisible();
    await expect(footer.getByRole("link", { name: "About" })).toBeVisible();
    await expect(
      footer.getByRole("link", { name: "Privacy Policy" }),
    ).toBeVisible();
    await expect(
      footer.getByRole("link", { name: "Terms of Service" }),
    ).toBeVisible();
  });
});

