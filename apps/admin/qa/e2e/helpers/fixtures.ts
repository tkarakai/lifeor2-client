/**
 * Disposable user fixtures for E2E tests.
 *
 * Every mutating auth spec used to share the single dev-seed account, so a test
 * that failed part-way through left it on a changed password or with 2FA
 * enabled — breaking every later spec, and local development with it. These
 * helpers hand each test its own throwaway account instead.
 *
 * Backed by `POST /api/dev/e2e-user` on the Convex HTTP router, which is gated
 * on `DEV_SEED_ENABLED` and refuses any address outside `e2e-<token>@e2e.local`.
 * See `packages/backend/convex/e2eFixtures.ts` for the safety rationale.
 *
 * @module qa/e2e/helpers/fixtures
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DisposableUser {
  email: string;
  password: string;
  name: string;
}

/**
 * Read a value from .env.local the way playwright.config.ts does — dev-start.sh
 * rewrites these with the ports Convex actually claimed, so they cannot be
 * hardcoded.
 */
function getEnvValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];

  for (const envPath of [
    path.join(__dirname, "../../../.env.local"),
    path.join(__dirname, "../../../../../.env.local"),
  ]) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(new RegExp(`^${name}=(.*)`, "m"));
      if (match) {
        const value = match[1].trim();
        if (value) return value;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function convexSiteUrl(): string {
  const url = getEnvValue("NEXT_PUBLIC_CONVEX_SITE_URL");
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_SITE_URL is not set. E2E fixtures call the Convex HTTP " +
        "router directly; run `bun run dev` (or dev-start.sh) so the URL is written " +
        "to .env.local.",
    );
  }
  return url.replace(/\/$/, "");
}

/**
 * A fixture address in the reserved `.local` TLD, which cannot receive mail and
 * so can never collide with a real account. The backend rejects anything else.
 */
export function disposableEmail(): string {
  return `e2e-${randomUUID().slice(0, 18)}@e2e.local`;
}

/**
 * A password with enough entropy to clear zxcvbn — the app scores credentials,
 * not just their length, and rejects anything derived from the email.
 */
export function disposablePassword(): string {
  return `Qx7!${randomBytes(18).toString("base64url")}#2z`;
}

/**
 * Create a fresh, email-verified account and return its credentials.
 *
 * The account is admitted past `inviteOnly` gating by the backend, which mints
 * the invitation rows first — tests cannot self-register otherwise.
 */
export async function createDisposableUser(
  options: { isAdmin?: boolean } = {},
): Promise<DisposableUser> {
  const user: DisposableUser = {
    email: disposableEmail(),
    password: disposablePassword(),
    name: "E2E User",
  };

  const response = await fetch(`${convexSiteUrl()}/api/dev/e2e-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...user, isAdmin: options.isAdmin === true }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new Error(
        "E2E fixture endpoint is disabled (404). It requires DEV_SEED_ENABLED=true " +
          "on the Convex deployment, which dev-start.sh sets for local backends. " +
          `Response: ${detail}`,
      );
    }
    throw new Error(
      `Could not create a disposable user (HTTP ${response.status}): ${detail}`,
    );
  }

  return user;
}
