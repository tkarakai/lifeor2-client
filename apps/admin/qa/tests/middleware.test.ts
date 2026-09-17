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

describe("proxy", () => {
  describe("protected routes (unauthenticated)", () => {
    it("redirects /dashboard to /sign-in when no session cookie", () => {
      const response = proxy(createRequest("/dashboard"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
    });

    it("redirects /configure/security to /sign-in when no session cookie", () => {
      const response = proxy(createRequest("/configure/security"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
    });

    it("redirects /settings to /sign-in when no session cookie", () => {
      const response = proxy(createRequest("/settings"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
    });
  });

  describe("protected routes (authenticated)", () => {
    it("allows /dashboard with dev session cookie", () => {
      const response = proxy(
        createRequest("/dashboard", { "lifeor2-client.session_token": "token-123" })
      );

      expect(response.status).toBe(200);
    });

    it("allows /dashboard with production session cookie (__Secure- prefix)", () => {
      const response = proxy(
        createRequest("/dashboard", {
          "__Secure-lifeor2-client.session_token": "token-123",
        })
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

  describe("auth routes (unauthenticated)", () => {
    it("allows /sign-in when no session cookie", () => {
      const response = proxy(createRequest("/sign-in"));

      expect(response.status).toBe(200);
    });
  });

  describe("auth routes (authenticated)", () => {
    it("redirects /sign-in to /dashboard when session cookie exists", () => {
      const response = proxy(
        createRequest("/sign-in", { "lifeor2-client.session_token": "token-123" })
      );

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/dashboard");
    });

    it("allows /sign-in with session_cleared param even when session cookie exists", () => {
      const response = proxy(
        createRequest("/sign-in?session_cleared=1", {
          "lifeor2-client.session_token": "token-123",
        })
      );

      // Should NOT redirect to dashboard when session_cleared param is present
      expect(response.status).toBe(200);
    });

    it("allows /sign-in with session_cleared param and __Secure- cookie", () => {
      const response = proxy(
        createRequest("/sign-in?session_cleared=1", {
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

      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
      expect(response.headers.get("X-RateLimit-Reset")).toBeDefined();
    });

    it("returns 429 when rate limit is exceeded", () => {
      const ip = "rate-limit-test-ip";

      // Send 100 requests (the admin app's default limit)
      for (let i = 0; i < 100; i++) {
        proxy(createRequest("/", {}, { "x-forwarded-for": ip }));
      }

      // 101st request should be blocked
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

      expect(remaining1).toBe(99);
      expect(remaining2).toBe(98);
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

      for (let i = 0; i < 100; i++) {
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
      const response = proxy(createRequest("/sign-in"));
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
    it("/api routes pass through without auth check", () => {
      const response = proxy(createRequest("/api/auth/something"));

      expect(response.status).toBe(200);
    });

    it("deeply nested protected routes redirect when unauthenticated", () => {
      const response = proxy(createRequest("/configure/security/profile"));

      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
    });
  });
});


describe("independent LifeOR2 login", () => {
  it("does not treat another app's cookie as a client login", () => {
    const response = proxy(createRequest("/dashboard", { "better-auth.session_token": "foreign-session" }));
    expect(response.headers.get("location")).toContain("/sign-in");
  });
});
