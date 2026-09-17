/**
 * Shared edge rate-limiting utilities for Next.js proxy middleware.
 *
 * This package provides:
 * - In-memory fixed window rate limiter (Edge Runtime compatible)
 * - Common proxy helpers: IP extraction, session cookie check,
 *   rate-limit 429 response, rate-limit response headers
 * - Safe env var parsing
 *
 * Limitations of the in-memory rate limiter:
 * - Per-instance only (each serverless instance has its own counter)
 * - Not persistent across deployments
 * - First line of defense — primary rate limiting is handled by
 *   Better Auth (Layer 1) and Convex function rate limits (Layer 2)
 */

import { type NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Rate limiter core
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 60_000;

function cleanup(now: number, maxSize: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL && store.size < maxSize) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) {
      store.delete(key);
    }
  }
}

export interface EdgeRateLimitConfig {
  /** Time window in seconds. */
  windowSeconds: number;
  /** Maximum requests per window. */
  maxRequests: number;
  /** Maximum number of tracked IPs. When exceeded, new IPs are blocked (fail-closed). */
  maxMapSize: number;
}

export interface EdgeRateLimitResult {
  allowed: boolean;
  /** Remaining requests in current window. */
  remaining: number;
  /** Unix timestamp (ms) when the window resets. */
  resetAt: number;
}

export function checkEdgeRateLimit(
  ip: string,
  config: EdgeRateLimitConfig,
): EdgeRateLimitResult {
  const now = Date.now();
  cleanup(now, config.maxMapSize);

  const entry = store.get(ip);

  if (!entry || now >= entry.resetAt) {
    // Fail-closed: if the map is at capacity with no room for a new IP, block.
    if (!entry && store.size >= config.maxMapSize) {
      return { allowed: false, remaining: 0, resetAt: now + config.windowSeconds * 1000 };
    }

    const resetAt = now + config.windowSeconds * 1000;
    store.set(ip, { count: 1, resetAt });
    return { allowed: true, remaining: config.maxRequests - 1, resetAt };
  }

  entry.count += 1;

  if (entry.count > config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetAt: entry.resetAt,
  };
}

/** Reset all entries. Exposed for testing. */
export function _resetStore(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// Shared proxy helpers
// ---------------------------------------------------------------------------

/** Parse an env var as a positive integer, falling back to a safe default. */
export function positiveInt(envVar: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envVar ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

/** Extract the client IP from trusted proxy headers, with x-real-ip fallback. */
export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Quick cookie-presence check (Edge-compatible, no backend call).
 * Match the app's configured cookie prefix, with the HTTPS variant as well.
 */
export function hasSessionCookie(request: NextRequest, prefix = "better-auth"): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name === `${prefix}.session_token` || c.name === `__Secure-${prefix}.session_token`);
}

/** Build a 429 "Too Many Requests" response with standard rate-limit headers. */
export function rateLimitResponse(
  config: EdgeRateLimitConfig,
  result: EdgeRateLimitResult,
): NextResponse {
  const retryAfterSeconds = Math.ceil(
    (result.resetAt - Date.now()) / 1000,
  );
  return new NextResponse("Too Many Requests", {
    status: 429,
    headers: {
      "Retry-After": String(Math.max(retryAfterSeconds, 1)),
      "X-RateLimit-Limit": String(config.maxRequests),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(result.resetAt),
    },
  });
}

/** Set standard rate-limit headers on a successful response. */
export function setRateLimitHeaders(
  response: NextResponse,
  config: EdgeRateLimitConfig,
  result: EdgeRateLimitResult,
): void {
  response.headers.set("X-RateLimit-Limit", String(config.maxRequests));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set("X-RateLimit-Reset", String(result.resetAt));
}
