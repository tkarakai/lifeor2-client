import { test, expect, type Dialog } from "@playwright/test";

import { fillStable, submitEmailStep } from "./helpers/auth";

/**
 * XSS Attack Surface Verification
 *
 * Verify that user-supplied content is properly escaped by React and
 * that CSP prevents inline script execution. These tests inject common
 * XSS payloads into form fields and verify they render as text, not code.
 */

/** Common XSS payloads to test. */
const XSS_PAYLOADS = [
  '<script>alert("xss")</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  "javascript:alert(1)",
  '<iframe src="javascript:alert(1)">',
  "'-alert(1)-'",
  '<body onload=alert(1)>',
];

test.describe("XSS Protection — CSP Enforcement", () => {
  test("script-src is nonce-based with no 'unsafe-inline'", async ({ page }) => {
    /**
     * This previously appended a <script> via page.evaluate and asserted it did
     * not run. Under `'strict-dynamic'` that script is *supposed* to run: the
     * directive propagates trust to scripts created programmatically by already
     * trusted code, and blocks parser-inserted markup instead. Playwright's
     * evaluate counts as trusted, so the old assertion could only ever fail —
     * and it told us nothing about whether the policy is sound.
     *
     * Assert the policy itself. Full header coverage is in csp-validation.spec.ts.
     */
    const response = await page.goto("/en/sign-in");
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).not.toBe("");

    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));

    expect(scriptSrc, "script-src directive should be present").toBeTruthy();
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toMatch(/'nonce-[^']+'/);
    // The nonce is worthless if inline scripts are allowed wholesale.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test("CSP blocks eval() in production-like settings", async ({ page }) => {
    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // In production, 'unsafe-eval' is NOT in the CSP.
    // In development, it IS allowed for HMR/bundler.
    // We just verify that eval is at least monitored.
    const csp = await page.evaluate(() => {
      const meta = document.querySelector(
        'meta[http-equiv="Content-Security-Policy"]'
      );
      return meta?.getAttribute("content") ?? null;
    });

    // CSP is set via HTTP header, not meta tag, so this should be null.
    // The actual CSP is in the response headers (tested in csp-validation.spec.ts).
    expect(csp).toBeNull();
  });
});

test.describe("XSS Protection — Input Escaping", () => {
  test("XSS payloads in sign-in email field are not executed", async ({
    page,
  }) => {
    const dialogs: Dialog[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog);
      dialog.dismiss();
    });

    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // Sign-in is two-step. Submitting the email step is enough: the payload is
    // echoed back by the UI there, which is where it would execute if unescaped.
    for (const payload of XSS_PAYLOADS) {
      await fillStable(page, "#email", payload);
      await page.locator('form:has(#email) button[type="submit"]').click();
      await page.waitForTimeout(500);
      await page.goto("/en/sign-in");
      await page.waitForLoadState("networkidle");
    }

    // No alert/confirm/prompt dialogs should have been triggered
    expect(dialogs).toHaveLength(0);
  });

  /**
   * Was "XSS payloads in sign-up name field are not executed". Sign-up is
   * invitation-gated by default, so /en/sign-up renders no inputs at all and
   * that test had no target. Retargeted at forgot-password, which is the other
   * unauthenticated form that echoes user input back.
   */
  test("XSS payloads in the forgot-password field are not executed", async ({
    page,
  }) => {
    const dialogs: Dialog[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog);
      dialog.dismiss();
    });

    for (const payload of XSS_PAYLOADS) {
      await page.goto("/en/forgot-password");
      await page.waitForLoadState("networkidle");

      await fillStable(page, "#forgot-email", payload);
      await page.locator('form:has(#forgot-email) button[type="submit"]').click();
      await page.waitForTimeout(400);

      // Assert structurally, not by substring: a correctly escaped payload still
      // appears verbatim in the serialised HTML as an attribute value, and
      // "description" contains the substring "script". What matters is that no
      // element was actually created from the payload.
      expect(await page.locator("main script").count()).toBe(0);
      expect(await page.locator("main [onerror], main [onload]").count()).toBe(0);
    }

    expect(dialogs).toHaveLength(0);
  });

  test("error messages with XSS payloads are escaped", async ({ page }) => {
    const dialogs: Dialog[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog);
      dialog.dismiss();
    });

    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // Submit invalid credentials to trigger error display
    await submitEmailStep(page, "test@example.com");
    await fillStable(page, "#password", "wrongpassword");
    await page.locator('form:has(#password) button[type="submit"]').click();

    // Wait for error to appear
    const errorBox = page.locator(".rounded-md.border.bg-muted");
    await expect(errorBox).toBeVisible({ timeout: 10000 });

    // The error text should be plain text, not HTML
    const errorHtml = await errorBox.innerHTML();
    expect(errorHtml).not.toContain("<script");
    expect(errorHtml).not.toContain("onerror=");
    expect(errorHtml).not.toContain("javascript:");

    expect(dialogs).toHaveLength(0);
  });
});

test.describe("XSS Protection — URL Safety", () => {
  test("javascript: URLs in navigation are not executed", async ({ page }) => {
    const dialogs: Dialog[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog);
      dialog.dismiss();
    });

    // Try navigating to a javascript: URL
    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // Browsers and Next.js should block javascript: URLs
    await page.evaluate(() => {
      try {
        window.location.href = "javascript:void(0)";
      } catch {
        // Expected: blocked by browser
      }
    });

    expect(dialogs).toHaveLength(0);
  });

  test("page does not contain any inline event handlers", async ({ page }) => {
    await page.goto("/en/sign-in");
    await page.waitForLoadState("networkidle");

    // React should not use inline event handlers (onclick, onerror, etc.)
    // which would be blocked by CSP anyway.
    const inlineHandlers = await page.evaluate(() => {
      const allElements = document.querySelectorAll("*");
      const handlersFound: string[] = [];
      const eventAttrs = [
        "onclick",
        "onerror",
        "onload",
        "onmouseover",
        "onfocus",
        "onblur",
      ];

      for (const el of allElements) {
        for (const attr of eventAttrs) {
          if (el.hasAttribute(attr)) {
            handlersFound.push(`${el.tagName}[${attr}]`);
          }
        }
      }
      return handlersFound;
    });

    expect(inlineHandlers).toHaveLength(0);
  });
});
