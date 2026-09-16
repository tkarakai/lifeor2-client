import { expect, test, type CDPSession, type Page } from "@playwright/test";

import {
  SEED_USER,
  openSecurityTab,
  fillStable,
  expectSignedIn,
  signIn,
  signOut,
  submitEmailStep,
  throttleSignIn,
} from "./helpers/auth";

/**
 * Passkey (WebAuthn) E2E Tests
 *
 * Driven by Chrome DevTools Protocol's virtual authenticator, so registration
 * and assertion run through the real `@better-auth/passkey` plugin and the real
 * browser WebAuthn API — no mocking, and no physical key needed in CI.
 *
 * The default `userPasskeyPolicy` is `optional` (`securityPolicies.ts`), so the
 * passkey section renders without any admin setup.
 *
 * Serial and self-restoring: passkeys are registered against the shared seed
 * account and deleted afterwards.
 *
 * QUARANTINED (`describe.fixme` — reported as skipped, CI stays green).
 *
 * Written against the real CDP virtual authenticator and the real markup, but
 * not yet verified end-to-end: the shared dev-seed account has to be restored
 * between tests, and a mid-flow failure strands registered credentials on it.
 * Enabling these needs the same disposable-user fixture as the other mutating
 * suites.
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });

/**
 * Attach a virtual platform authenticator with user verification already
 * satisfied, so registration and assertion complete without a UI prompt.
 */
async function addVirtualAuthenticator(page: Page): Promise<{ client: CDPSession; id: string }> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");

  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  return { client, id: authenticatorId };
}

/** Register a passkey from the security tab and return its label. */
async function registerPasskey(page: Page, name: string): Promise<void> {
  await openSecurityTab(page, "passkeys");

  await expect(page.locator("#new-passkey-name")).toBeVisible({ timeout: 20_000 });
  await fillStable(page, "#new-passkey-name", name);
  await page.getByRole("button", { name: /^add/i }).first().click();

  await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });
}

/** Remove every passkey on the account so later tests start clean. */
async function deleteAllPasskeys(page: Page): Promise<void> {
  await openSecurityTab(page, "passkeys");

  for (let i = 0; i < 5; i += 1) {
    const deleteButton = page.getByRole("button", { name: /delete|remove/i }).first();
    if (!(await deleteButton.isVisible().catch(() => false))) return;

    await deleteButton.click();
    const confirm = page.getByRole("button", { name: /^(delete|remove|confirm)/i }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    await page.waitForTimeout(500);
  }
}

test.describe.fixme("Passkey registration and sign-in", () => {
  test.afterEach(async ({ page }) => {
    await page.context().clearCookies();
    await signIn(page).catch(() => {});
    await deleteAllPasskeys(page).catch(() => {});
  });

  test("registers a passkey and lists it in settings", async ({ page }) => {
    await addVirtualAuthenticator(page);
    await signIn(page);

    await registerPasskey(page, "E2E Virtual Key");

    await page.reload();
    await expect(page.getByText("E2E Virtual Key")).toBeVisible({ timeout: 20_000 });
  });

  test("signs in with a passkey instead of a password", async ({ page }) => {
    const { client, id: authenticatorId } = await addVirtualAuthenticator(page);
    await signIn(page);
    await registerPasskey(page, "E2E Sign-in Key");

    // Registration must have produced a real credential in the authenticator.
    const { credentials } = await client.send("WebAuthn.getCredentials", { authenticatorId });
    expect(credentials.length, "registration should store a credential").toBeGreaterThan(0);

    await signOut(page);

    // The credential is held by the virtual authenticator bound to this page's
    // CDP session, so the assertion has to happen in this same page.
    await throttleSignIn();
    await submitEmailStep(page, SEED_USER.email);

    const passkeyButton = page.getByRole("button", { name: /passkey/i }).first();
    await expect(passkeyButton).toBeVisible({ timeout: 15_000 });
    await passkeyButton.click();

    await expectSignedIn(page);
  });

  test("renames a passkey", async ({ page }) => {
    await addVirtualAuthenticator(page);
    await signIn(page);
    await registerPasskey(page, "Before Rename");

    await page.getByRole("button", { name: /rename|edit/i }).first().click();

    const nameInput = page.locator('input[value="Before Rename"]').first();
    await expect(nameInput).toBeVisible({ timeout: 15_000 });
    await nameInput.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await nameInput.pressSequentially("After Rename", { delay: 15 });

    await page.getByRole("button", { name: /save|confirm|rename/i }).first().click();

    await expect(page.getByText("After Rename")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Before Rename")).toHaveCount(0);
  });

  test("deletes a passkey and it can no longer sign in", async ({ page }) => {
    await addVirtualAuthenticator(page);
    await signIn(page);
    await registerPasskey(page, "Doomed Key");

    await deleteAllPasskeys(page);

    await page.reload();
    await expect(page.getByText("Doomed Key")).toHaveCount(0);

    // With no registered passkey, the account falls back to password auth.
    await signOut(page);
    await throttleSignIn();
    await submitEmailStep(page, SEED_USER.email);
    await expect(page.locator("#password")).toBeVisible({ timeout: 15_000 });
  });
});
