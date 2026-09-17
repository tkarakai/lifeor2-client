import { AUTH_COOKIE_PREFIX } from "@repo/auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { defaultLocale, locales } from "@repo/i18n";
import {
  checkEdgeRateLimit,
  positiveInt,
  getClientIp,
  hasSessionCookie,
  rateLimitResponse,
  setRateLimitHeaders,
  type EdgeRateLimitConfig,
} from "@repo/edge-rate-limit";

const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
});

const RATE_LIMIT_CONFIG: EdgeRateLimitConfig = {
  windowSeconds: positiveInt(process.env.EDGE_RATE_LIMIT_WINDOW, 60),
  maxRequests: positiveInt(process.env.EDGE_RATE_LIMIT_MAX, 200),
  maxMapSize: positiveInt(process.env.EDGE_RATE_LIMIT_MAP_MAX_SIZE, 10000),
};

/** Routes that require authentication (matched against the locale-stripped path). */
const PROTECTED_PREFIXES = ["/dashboard"];

/**
 * Auth routes that authenticated users should skip (redirected to dashboard).
 * Note: /verify-email is intentionally excluded — authenticated but unverified
 * users must be able to reach it without being bounced back to /dashboard.
 */
const AUTH_ROUTES = ["/sign-in", "/sign-up", "/forgot-password", "/reset-password"];

/**
 * Extract the pathname without the locale prefix so auth rules
 * work the same regardless of which locale is active.
 */
function stripLocalePrefix(pathname: string): string {
  for (const locale of locales) {
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) {
      return pathname.slice(`/${locale}`.length) || "/";
    }
  }
  return pathname;
}

/**
 * Detect the locale from the URL path (first segment).
 * Falls back to `defaultLocale` when the segment isn't a known locale.
 */
function getLocaleFromPath(pathname: string): string {
  const match = pathname.match(/^\/([^/]+)/);
  if (match && (locales as readonly string[]).includes(match[1])) {
    return match[1];
  }
  return defaultLocale;
}

/**
 * Get the user's preferred locale from the NEXT_LOCALE cookie.
 * Falls back to null if not set.
 */
function getLocaleFromCookie(request: NextRequest): string | null {
  const locale = request.cookies.get("NEXT_LOCALE")?.value;
  if (locale && (locales as readonly string[]).includes(locale)) {
    return locale;
  }
  return null;
}

export function proxy(request: NextRequest) {
  // --- Rate limiting (first check) ---
  const clientIp = getClientIp(request);
  const rl = checkEdgeRateLimit(clientIp, RATE_LIMIT_CONFIG);

  if (!rl.allowed) {
    return rateLimitResponse(RATE_LIMIT_CONFIG, rl);
  }

  // --- Auth redirects ---
  const { pathname } = request.nextUrl;

  // Skip locale handling for API routes
  if (pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  // --- Auth redirects (checked before intl to avoid unnecessary rewrites) ---
  const strippedPath = stripLocalePrefix(pathname);
  const hasSession = hasSessionCookie(request, AUTH_COOKIE_PREFIX);
  const locale = getLocaleFromPath(pathname);

  // Unauthenticated users hitting a protected route → sign-in
  // Respect the NEXT_LOCALE cookie (user's preferred locale from before logout)
  if (
    PROTECTED_PREFIXES.some((prefix) => strippedPath.startsWith(prefix)) &&
    !hasSession
  ) {
    const preferredLocale = getLocaleFromCookie(request) || locale;
    return NextResponse.redirect(new URL(`/${preferredLocale}/sign-in`, request.url));
  }

  // Authenticated users hitting auth pages → dashboard
  // UNLESS they're coming from a session clear (prevents redirect loop when session is stale)
  const isSessionCleared = request.nextUrl.searchParams.has("session_cleared");
  if (AUTH_ROUTES.includes(strippedPath) && hasSession && !isSessionCleared) {
    return NextResponse.redirect(new URL(`/${locale}/dashboard`, request.url));
  }

  // --- CSP headers ---
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === "development";

  // In dev, Convex runs locally on dynamic ports (e.g. http://127.0.0.1:3210).
  // Derive both http and ws origins so the CSP allows API calls and WebSocket sync.
  // Also include the Convex site URL (HTTP actions) which runs on a separate port.
  const devConvexOrigins = isDev
    ? (() => {
        const origins: string[] = [];
        try {
          const url = new URL(process.env.NEXT_PUBLIC_CONVEX_URL ?? "");
          origins.push(url.origin, `ws://${url.host}`);
        } catch {
          // Invalid URL — skip
        }
        try {
          const siteUrl = new URL(process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "");
          if (!origins.includes(siteUrl.origin)) {
            origins.push(siteUrl.origin);
          }
        } catch {
          // Invalid URL — skip
        }
        return origins.length > 0 ? ` ${origins.join(" ")}` : "";
      })()
    : "";

  // When adding third-party services, add their origins to the relevant directives:
  //   Analytics (PostHog/Plausible): script-src, connect-src
  //   Error monitoring (Sentry):     script-src, connect-src
  //   Payment (Stripe/Square):       script-src, connect-src, frame-src
  //   External images/avatars:       img-src
  //   External fonts:                font-src, style-src
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' https://*.convex.cloud wss://*.convex.cloud${devConvexOrigins}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  // Forward custom headers via request so Server Components can read them
  // via headers(). next-intl's middleware copies request.headers and passes
  // them through NextResponse.next/rewrite({ request: { headers } }).
  request.headers.set("x-nonce", nonce);
  request.headers.set("x-pathname", strippedPath);

  // --- Locale handling (detection, rewrite, cookie) ---
  const intlResponse = intlMiddleware(request);

  // Set CSP on the response (sent to the browser)
  intlResponse.headers.set("Content-Security-Policy", csp);

  // Rate limit headers on successful responses
  setRateLimitHeaders(intlResponse, RATE_LIMIT_CONFIG, rl);

  return intlResponse;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon\\.ico|icon\\.svg|apple-touch-icon\\.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
