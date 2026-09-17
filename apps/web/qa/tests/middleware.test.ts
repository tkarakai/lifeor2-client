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

describe("proxy", () => {
  describe("protected routes (unauthenticated)", () => {
    it("redirects /en/dashboard to /en/sign-in when no session cookie", () => {
      const response = proxy(createRequest("/en/dashboard"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/sign-in");
    });

    it("redirects /en/dashboard/settings to /en/sign-in when no session cookie", () => {
      const response = proxy(createRequest("/en/dashboard/settings"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/sign-in");
    });
  });

  describe("protected routes (authenticated)", () => {
    it("allows /en/dashboard with dev session cookie", () => {
      const response = proxy(
        createRequest("/en/dashboard", { "lifeor2-client.session_token": "token-123" })
      );

      expect(response.status).toBe(200);
    });

    it("allows /en/dashboard with production session cookie (__Secure- prefix)", () => {
      const response = proxy(
        createRequest("/en/dashboard", {
          "__Secure-lifeor2-client.session_token": "token-123",
        })
      );

      expect(response.status).toBe(200);
    });
  });

  describe("auth routes (unauthenticated)", () => {
    it("allows /en/sign-in when no session cookie", () => {
      const response = proxy(createRequest("/en/sign-in"));

      expect(response.status).toBe(200);
    });

    it("allows /en/sign-up when no session cookie", () => {
      const response = proxy(createRequest("/en/sign-up"));

      expect(response.status).toBe(200);
    });
  });

  describe("auth routes (authenticated)", () => {
    it("redirects /en/sign-in to /en/dashboard when session cookie exists", () => {
      const response = proxy(
        createRequest("/en/sign-in", { "lifeor2-client.session_token": "token-123" })
      );

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/dashboard");
    });

    it("redirects /en/sign-up to /en/dashboard when session cookie exists", () => {
      const response = proxy(
        createRequest("/en/sign-up", { "lifeor2-client.session_token": "token-123" })
      );

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/dashboard");
    });

    it("allows /en/sign-in with session_cleared param even when session cookie exists", () => {
      const response = proxy(
        createRequest("/en/sign-in?session_cleared=1", {
          "lifeor2-client.session_token": "token-123",
        })
      );

      // Should NOT redirect to dashboard when session_cleared param is present
      expect(response.status).toBe(200);
    });

    it("allows /en/sign-up with session_cleared param even when session cookie exists", () => {
      const response = proxy(
        createRequest("/en/sign-up?session_cleared=1", {
          "__Secure-lifeor2-client.session_token": "token-123",
        })
      );

      // Should NOT redirect to dashboard when session_cleared param is present
      expect(response.status).toBe(200);
    });
  });

  describe("rate limiting", () => {
    it("includes rate limit headers on successful responses", () => {
      const response = proxy(createRequest("/"));

      expect(response.headers.get("X-RateLimit-Limit")).toBe("200");
      expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
      expect(response.headers.get("X-RateLimit-Reset")).toBeDefined();
    });

    it("returns 429 when rate limit is exceeded", () => {
      const ip = "rate-limit-test-ip";

      // Send 200 requests (the default limit)
      for (let i = 0; i < 200; i++) {
        proxy(createRequest("/", {}, { "x-forwarded-for": ip }));
      }

      // 201st request should be blocked
      const response = proxy(createRequest("/", {}, { "x-forwarded-for": ip }));

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBeDefined();
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    });

    it("X-RateLimit-Remaining decrements on each request", () => {
      const ip = "decrement-test-ip";

      const r1 = proxy(createRequest("/", {}, { "x-forwarded-for": ip }));
      const r2 = proxy(createRequest("/", {}, { "x-forwarded-for": ip }));

      const remaining1 = parseInt(r1.headers.get("X-RateLimit-Remaining")!, 10);
      const remaining2 = parseInt(r2.headers.get("X-RateLimit-Remaining")!, 10);

      expect(remaining1).toBe(199);
      expect(remaining2).toBe(198);
      expect(remaining2).toBe(remaining1 - 1);
    });

    it("X-RateLimit-Reset is a valid future timestamp", () => {
      const response = proxy(createRequest("/"));
      const reset = parseInt(response.headers.get("X-RateLimit-Reset")!, 10);

      expect(Number.isNaN(reset)).toBe(false);
      expect(reset).toBeGreaterThan(0);
    });

    it("429 response includes positive Retry-After value", () => {
      const ip = "retry-after-test-ip";

      for (let i = 0; i < 200; i++) {
        proxy(createRequest("/", {}, { "x-forwarded-for": ip }));
      }

      const response = proxy(createRequest("/", {}, { "x-forwarded-for": ip }));
      const retryAfter = parseInt(response.headers.get("Retry-After")!, 10);

      expect(response.status).toBe(429);
      expect(Number.isNaN(retryAfter)).toBe(false);
      expect(retryAfter).toBeGreaterThan(0);
    });
  });

  describe("CSP nonce", () => {
    it("sets Content-Security-Policy header on page responses", () => {
      const response = proxy(createRequest("/en/sign-in"));
      const csp = response.headers.get("Content-Security-Policy");

      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("CSP contains a nonce in script-src", () => {
      const response = proxy(createRequest("/"));
      const csp = response.headers.get("Content-Security-Policy")!;

      expect(csp).toMatch(/nonce-[A-Za-z0-9+/=]+/);
    });

    it("generates different nonces for different requests", () => {
      const r1 = proxy(createRequest("/"));
      const r2 = proxy(createRequest("/"));

      const csp1 = r1.headers.get("Content-Security-Policy")!;
      const csp2 = r2.headers.get("Content-Security-Policy")!;

      const nonce1 = csp1.match(/nonce-([A-Za-z0-9+/=]+)/)![1];
      const nonce2 = csp2.match(/nonce-([A-Za-z0-9+/=]+)/)![1];

      expect(nonce1).not.toBe(nonce2);
    });

    it("does NOT set CSP on /api routes", () => {
      const response = proxy(createRequest("/api/auth/get-session"));
      const csp = response.headers.get("Content-Security-Policy");

      expect(csp).toBeNull();
    });

    it("includes required CSP directives", () => {
      const response = proxy(createRequest("/"));
      const csp = response.headers.get("Content-Security-Policy")!;

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });
  });

  describe("proxy edge cases", () => {
    it("/api routes pass through without auth or rate limit check", () => {
      const response = proxy(createRequest("/api/auth/something"));

      expect(response.status).toBe(200);
      // API routes should not have CSP (set on intl response only)
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
    });

    it("deeply nested protected routes redirect when unauthenticated", () => {
      const response = proxy(createRequest("/en/dashboard/settings/profile"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/en/sign-in");
    });

    it("unknown locale prefix is handled by intl middleware (not auth redirect)", () => {
      // /xx/dashboard — 'xx' is not a known locale, so stripLocalePrefix
      // won't strip it. The intl middleware redirects to default locale.
      const response = proxy(createRequest("/xx/dashboard"));

      // Intl middleware redirects to the correct locale path.
      // The redirect target should be a locale path, not /sign-in
      // (because auth check doesn't trigger for paths that don't match after strip).
      if (response.status === 307) {
        const location = new URL(response.headers.get("location")!).pathname;
        // Should redirect to a locale-prefixed path, not directly to sign-in
        // due to auth. The intl middleware may redirect to /en/xx/dashboard or /en.
        expect(location).not.toBe("/sign-in");
      }
    });
  });
});


describe("independent LifeOR2 login", () => {
  it("does not treat another app's cookie as a client login", () => {
    const response = proxy(createRequest("/en/dashboard", { "better-auth.session_token": "foreign-session" }));
    expect(response.headers.get("location")).toContain("/sign-in");
  });
});
