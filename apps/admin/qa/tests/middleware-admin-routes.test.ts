import { beforeEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";

import { proxy } from "../../src/proxy";
import { _resetStore } from "@repo/edge-rate-limit";

// Each test gets a fresh rate limit store to avoid cross-test contamination.
beforeEach(() => {
  _resetStore();
});

let ipCounter = 0;

/** Create a request with a unique IP per call (avoids rate limit collisions). */
function createRequest(
  path: string,
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
): NextRequest {
  ipCounter += 1;
  const url = `http://localhost:3002${path}`;
  const req = new NextRequest(url, {
    headers: { "x-forwarded-for": headers["x-forwarded-for"] ?? `10.0.0.${ipCounter}`, ...headers },
  });
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

describe("proxy — admin session and MFA settings routes", () => {
  describe("sessions page (protected)", () => {
    it("redirects /dashboard/sessions to /sign-in when no session cookie", () => {
      const response = proxy(createRequest("/dashboard/sessions"));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
    });

    it("allows /dashboard/sessions with dev session cookie", () => {
      const response = proxy(
        createRequest("/dashboard/sessions", {
          "lifeor2-client.session_token": "token-123",
        })
      );
      expect(response.status).toBe(200);
    });

    it("allows /dashboard/sessions with production session cookie", () => {
      const response = proxy(
        createRequest("/dashboard/sessions", {
          "__Secure-lifeor2-client.session_token": "token-123",
        })
      );
      expect(response.status).toBe(200);
    });
  });

  describe("settings page (protected)", () => {
    it("redirects /configure/security to /sign-in when no session cookie", () => {
      const response = proxy(createRequest("/configure/security"));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
    });

    it("allows /configure/security with dev session cookie", () => {
      const response = proxy(
        createRequest("/configure/security", { "lifeor2-client.session_token": "token-123" })
      );
      expect(response.status).toBe(200);
    });

    it("allows /settings with dev session cookie", () => {
      const response = proxy(
        createRequest("/settings", { "lifeor2-client.session_token": "token-123" })
      );
      expect(response.status).toBe(200);
    });
  });

  describe("CSP on new admin pages", () => {
    it("sets CSP header on /dashboard/sessions", () => {
      const response = proxy(
        createRequest("/dashboard/sessions", {
          "lifeor2-client.session_token": "token-123",
        })
      );
      const csp = response.headers.get("Content-Security-Policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("sets CSP header on /configure/security", () => {
      const response = proxy(
        createRequest("/configure/security", { "lifeor2-client.session_token": "token-123" })
      );
      const csp = response.headers.get("Content-Security-Policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
    });
  });

  describe("rate limit headers on new admin pages", () => {
    it("includes rate limit headers on /dashboard/sessions", () => {
      const response = proxy(
        createRequest("/dashboard/sessions", {
          "lifeor2-client.session_token": "token-123",
        })
      );
      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
    });
  });
});
