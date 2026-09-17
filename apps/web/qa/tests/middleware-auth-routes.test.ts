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
  const url = `http://localhost:3001${path}`;
  const req = new NextRequest(url, {
    headers: { "x-forwarded-for": headers["x-forwarded-for"] ?? `10.0.0.${ipCounter}`, ...headers },
  });
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

describe("proxy — new auth guest routes", () => {
  describe("forgot-password", () => {
    it("allows /en/forgot-password when unauthenticated", () => {
      const response = proxy(createRequest("/en/forgot-password"));
      expect(response.status).toBe(200);
    });

    it("redirects /en/forgot-password to /en/dashboard when authenticated", () => {
      const response = proxy(
        createRequest("/en/forgot-password", { "lifeor2-client.session_token": "token-123" })
      );
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/dashboard");
    });

    it("allows /en/forgot-password with session_cleared param even when authenticated", () => {
      const response = proxy(
        createRequest("/en/forgot-password?session_cleared=1", {
          "lifeor2-client.session_token": "token-123",
        })
      );
      expect(response.status).toBe(200);
    });

    it("redirects /en/forgot-password to /en/dashboard with __Secure- cookie", () => {
      const response = proxy(
        createRequest("/en/forgot-password", {
          "__Secure-lifeor2-client.session_token": "token-123",
        })
      );
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/dashboard");
    });
  });

  describe("reset-password", () => {
    it("allows /en/reset-password when unauthenticated", () => {
      const response = proxy(createRequest("/en/reset-password"));
      expect(response.status).toBe(200);
    });

    it("allows /en/reset-password with token param when unauthenticated", () => {
      const response = proxy(createRequest("/en/reset-password?token=abc123"));
      expect(response.status).toBe(200);
    });

    it("redirects /en/reset-password to /en/dashboard when authenticated", () => {
      const response = proxy(
        createRequest("/en/reset-password", { "lifeor2-client.session_token": "token-123" })
      );
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/dashboard");
    });
  });

  describe("verify-email", () => {
    it("allows /en/verify-email when unauthenticated", () => {
      const response = proxy(createRequest("/en/verify-email"));
      expect(response.status).toBe(200);
    });

    it("allows /en/verify-email when authenticated", () => {
      const response = proxy(
        createRequest("/en/verify-email", { "lifeor2-client.session_token": "token-123" })
      );
      expect(response.status).toBe(200);
    });
  });

  describe("CSP on new auth pages", () => {
    it("sets CSP header on /en/forgot-password", () => {
      const response = proxy(createRequest("/en/forgot-password"));
      const csp = response.headers.get("Content-Security-Policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("sets CSP header on /en/reset-password", () => {
      const response = proxy(createRequest("/en/reset-password"));
      const csp = response.headers.get("Content-Security-Policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
    });

    it("sets CSP header on /en/verify-email", () => {
      const response = proxy(createRequest("/en/verify-email"));
      const csp = response.headers.get("Content-Security-Policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
    });
  });

  describe("rate limit headers on new auth pages", () => {
    it("includes rate limit headers on /en/forgot-password", () => {
      const response = proxy(createRequest("/en/forgot-password"));
      expect(response.headers.get("X-RateLimit-Limit")).toBe("200");
      expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
    });

    it("includes rate limit headers on /en/reset-password", () => {
      const response = proxy(createRequest("/en/reset-password"));
      expect(response.headers.get("X-RateLimit-Limit")).toBe("200");
      expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
    });
  });

  describe("locale variations", () => {
    it("allows /fr/forgot-password when unauthenticated", () => {
      const response = proxy(createRequest("/fr/forgot-password"));
      expect(response.status).toBe(200);
    });

    it("redirects /fr/forgot-password to /fr/dashboard when authenticated", () => {
      const response = proxy(
        createRequest("/fr/forgot-password", { "lifeor2-client.session_token": "token-123" })
      );
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/fr/dashboard");
    });

    it("allows /de/reset-password when unauthenticated", () => {
      const response = proxy(createRequest("/de/reset-password"));
      expect(response.status).toBe(200);
    });

    it("allows /ja/verify-email when unauthenticated", () => {
      const response = proxy(createRequest("/ja/verify-email"));
      expect(response.status).toBe(200);
    });
  });
});
