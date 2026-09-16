import { expect, test, type Page } from "@playwright/test";

import {
  openSecurityTab,
  fillStable,
  awaitStableTotpWindow,
  expectSignedIn,
  fillOtp,
  generateTotp,
  signIn,
  signOut,
  submitEmailStep,
  submitPassword,
  throttleSignIn,
} from "./helpers/auth";
import { createDisposableUser } from "./helpers/fixtures";

/**
 * Two-Factor Authentication E2E Tests
 *
 * Exercises the full TOTP lifecycle against the real Better Auth `twoFactor`
 * plugin: enrolment, the sign-in challenge, backup-code recovery, regeneration,
 * and disabling.
 *
 * TOTP codes are computed in-process from the secret the enrolment screen
 * renders (`two-factor-section.tsx` prints it for manual entry). The algorithm
 * is implemented in `helpers/auth.ts` rather than pulled from a package, so this
 * suite does not depend on the library it is meant to be testing.
 *
 * Serial and self-restoring: 2FA is enabled on the shared seed account, so every
 * test must leave it disabled again.
 *
 * Previously quarantined. Both blockers are resolved:
 *
 * 1. The backup codes were never lost to a dropped session — Better Auth
 *    returns them from `/two-factor/enable`, and `two-factor-section.tsx` was
 *    reading only `totpURI` and discarding them, so the backup-codes step
 *    rendered empty. Fixed at the source.
 * 2. Isolation: every test now mints its own disposable account, so nothing
 *    mutates the shared dev-seed user and no restore step is needed.
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });

/**
 * Submit the backup-code challenge. The step is a plain <div>, not a <form>, so
 * Enter does not submit — the "Verify" button has to be clicked. Selected by
 * position rather than its label, because there are 15 locales.
 */
async function submitBackupCode(page: Page): Promise<void> {
  await page.locator("button:below(#backup-code)").first().click();
}

/** Walk the security tab from "2FA off" to "enrolled", returning secret + codes. */
async function enableTwoFactor(
  page: Page,
  password: string,
): Promise<{ secret: string; backupCodes: string[] }> {
  await openSecurityTab(page, "2fa");

  // Step: idle -> password-enable
  await page.getByRole("button", { name: /enable/i }).first().click();
  await expect(page.locator("[id='2fa-password']")).toBeVisible({ timeout: 15_000 });

  await fillStable(page, "[id='2fa-password']", password);
  await page.locator(`form:has([id='2fa-password']) button[type="submit"]`).click();

  // Step: totp-uri. The QR code is primary; the base32 secret sits behind a
  // "Can't scan? Enter this key manually" collapsible, so it is not in the DOM
  // until expanded. Target the trigger by Radix's data-state rather than its
  // localised label.
  const panel = page.getByRole("tabpanel").last();
  const collapsibleTrigger = panel.locator('[data-state="closed"]').first();
  await expect(collapsibleTrigger).toBeVisible({ timeout: 20_000 });
  await collapsibleTrigger.click();

  const secretLocator = panel.locator("code, [class*='font-mono']").filter({
    hasText: /^[A-Z2-7\s]{16,}$/,
  });
  await expect(secretLocator.first()).toBeVisible({ timeout: 20_000 });

  // Authenticator apps tolerate grouping whitespace; the algorithm does not.
  const secret = ((await secretLocator.first().textContent()) ?? "").replace(/\s/g, "");
  expect(secret, "TOTP secret should be rendered for manual entry").toMatch(/^[A-Z2-7]{16,}$/);

  await awaitStableTotpWindow();
  await fillOtp(page, generateTotp(secret));

  // Step: backup-codes — shown once, after the code verifies.
  const codesField = page.locator('[data-slot="copyable-field"] pre');
  await expect(codesField.first()).toBeVisible({ timeout: 20_000 });
  const backupCodes = ((await codesField.first().innerText()) ?? "")
    .split("\n")
    .map((code) => code.trim())
    .filter(Boolean);

  expect(backupCodes.length, "enrolment should issue backup codes").toBeGreaterThan(0);

  return { secret, backupCodes };
}

/** Return the seed account to "2FA off", tolerating a partially-enrolled state. */
async function disableTwoFactor(page: Page, password: string): Promise<void> {
  await openSecurityTab(page, "2fa");

  // The section reads 2FA status asynchronously on mount, so a bare isVisible()
  // check races the fetch and silently reports "already off" — which then shows
  // up much later as an unexpected 2FA challenge at sign-in.
  const disableButton = page.getByRole("button", { name: /disable/i }).first();
  await expect(disableButton).toBeVisible({ timeout: 20_000 });

  await disableButton.click();

  // Confirmation dialog -> password-disable step.
  const confirm = page.getByRole("button", { name: /^(disable|confirm|continue)/i }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();

  await expect(page.locator("[id='2fa-disable-password']")).toBeVisible({ timeout: 15_000 });
  await fillStable(page, "[id='2fa-disable-password']", password);
  await page.locator(`form:has([id='2fa-disable-password']) button[type="submit"]`).click();

  await expect(page.getByRole("button", { name: /enable/i }).first()).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("TOTP enrolment and challenge", () => {
  test("enrols in TOTP and issues backup codes", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);
    const { secret, backupCodes } = await enableTwoFactor(page, user.password);

    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    // Codes must be distinct — a duplicate would silently halve recovery.
    expect(new Set(backupCodes).size).toBe(backupCodes.length);
  });

  test("requires a TOTP code at sign-in once enrolled", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);
    const { secret } = await enableTwoFactor(page, user.password);
    await signOut(page);

    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, user.password);

    // The password alone must not produce a session.
    await expect(page).not.toHaveURL(/\/dashboard/, { timeout: 5_000 });
    await expect(page.getByLabel("Digit 1 of 6")).toBeVisible({ timeout: 15_000 });

    await awaitStableTotpWindow();
    await fillOtp(page, generateTotp(secret));

    await expectSignedIn(page);
  });

  test("rejects an incorrect TOTP code", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);
    const { secret } = await enableTwoFactor(page, user.password);
    await signOut(page);

    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, user.password);
    await expect(page.getByLabel("Digit 1 of 6")).toBeVisible({ timeout: 15_000 });

    await fillOtp(page, "000000");
    await expect(page.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).not.toHaveURL(/\/dashboard/);

    // A valid code still works afterwards, so the rejection was not a lockout.
    await page.getByLabel("Digit 1 of 6").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await awaitStableTotpWindow();
    await fillOtp(page, generateTotp(secret));
    await expectSignedIn(page);
  });

    /**
   * QUARANTINED — backup-code sign-in is broken by the Convex adapter, not by
   * this test and not by app code.
   *
   * `POST /api/auth/two-factor/verify-backup-code` returns HTTP 500 with an
   * empty body. The Convex log shows `Error: where clause not supported`.
   *
   * Root cause: better-auth consumes a backup code with a two-condition where
   * clause (an optimistic-concurrency check) —
   *   where: [{ field: "id", ... }, { field: "backupCodes", ... }]
   * (`better-auth/dist/plugins/two-factor/backup-codes/index.mjs`) — but
   * `@convex-dev/better-auth@0.10.10` only supports a single `eq` condition and
   * throws otherwise (`src/client/adapter.ts`, the `update` branch).
   *
   * Not fixable here: `packages/backend/convex/betterAuth/adapter.ts` is a thin
   * re-export of the library's `createApi`.
   *
   * This is the acceptance test for the adapter upgrade (0.10.10 -> 0.12.5).
   * Un-quarantine it there; if it passes, backup-code recovery genuinely works.
   */
  test.fixme("accepts a backup code at the challenge and burns it", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);
    const { backupCodes } = await enableTwoFactor(page, user.password);
    await signOut(page);

    const code = backupCodes[0];

    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, user.password);
    await expect(page.getByLabel("Digit 1 of 6")).toBeVisible({ timeout: 15_000 });

    // Switch the challenge to backup-code entry.
    await page.getByRole("button", { name: /backup/i }).first().click();
    await expect(page.locator("#backup-code")).toBeVisible({ timeout: 15_000 });
    await fillStable(page, "#backup-code", code);
    await submitBackupCode(page);

    await expectSignedIn(page);

    // Single-use: the same code must not work a second time.
    await signOut(page);
    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, user.password);
    await page.getByRole("button", { name: /backup/i }).first().click();
    await fillStable(page, "#backup-code", code);
    await submitBackupCode(page);

    await expect(page.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

    /**
   * QUARANTINED — backup-code sign-in is broken by the Convex adapter, not by
   * this test and not by app code.
   *
   * `POST /api/auth/two-factor/verify-backup-code` returns HTTP 500 with an
   * empty body. The Convex log shows `Error: where clause not supported`.
   *
   * Root cause: better-auth consumes a backup code with a two-condition where
   * clause (an optimistic-concurrency check) —
   *   where: [{ field: "id", ... }, { field: "backupCodes", ... }]
   * (`better-auth/dist/plugins/two-factor/backup-codes/index.mjs`) — but
   * `@convex-dev/better-auth@0.10.10` only supports a single `eq` condition and
   * throws otherwise (`src/client/adapter.ts`, the `update` branch).
   *
   * Not fixable here: `packages/backend/convex/betterAuth/adapter.ts` is a thin
   * re-export of the library's `createApi`.
   *
   * This is the acceptance test for the adapter upgrade (0.10.10 -> 0.12.5).
   * Un-quarantine it there; if it passes, backup-code recovery genuinely works.
   */
  test.fixme("regenerating backup codes invalidates the previous set", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);
    const { backupCodes: original } = await enableTwoFactor(page, user.password);

    await openSecurityTab(page, "2fa");
    await page.getByRole("button", { name: /regenerate/i }).first().click();

    const confirm = page.getByRole("button", { name: /^(regenerate|confirm|continue)/i }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    await expect(page.locator("[id='2fa-regen-password']")).toBeVisible({ timeout: 15_000 });
    await fillStable(page, "[id='2fa-regen-password']", user.password);
    await page.locator(`form:has([id='2fa-regen-password']) button[type="submit"]`).click();

    const codesField = page.locator('[data-slot="copyable-field"] pre').first();
    await expect(codesField).toBeVisible({ timeout: 20_000 });
    const regenerated = ((await codesField.innerText()) ?? "")
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);

    expect(regenerated.length).toBeGreaterThan(0);
    // The new set must genuinely replace the old one.
    expect(regenerated).not.toEqual(original);

    await signOut(page);
    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, user.password);
    await page.getByRole("button", { name: /backup/i }).first().click();
    await fillStable(page, "#backup-code", original[0]);
    await submitBackupCode(page);

    await expect(page.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("disabling 2FA restores plain password sign-in", async ({ page }) => {
    const user = await createDisposableUser();
    await signIn(page, user.email, user.password);
    await enableTwoFactor(page, user.password);
    await disableTwoFactor(page, user.password);

    await signOut(page);
    await throttleSignIn();
    await submitEmailStep(page, user.email);
    await submitPassword(page, user.password);

    // No challenge should appear now.
    await expectSignedIn(page);
  });
});
