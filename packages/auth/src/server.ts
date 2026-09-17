import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";
import { AUTH_COOKIE_PREFIX } from "./cookies";

// Next.js server helpers that proxy auth requests to the Convex deployment.
export const {
  handler,
  preloadAuthQuery,
  isAuthenticated,
  getToken,
  fetchAuthQuery,
  fetchAuthMutation,
  fetchAuthAction,
} = convexBetterAuthNextJs({
  cookiePrefix: AUTH_COOKIE_PREFIX,
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
});
