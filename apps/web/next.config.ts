import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { getGitBranch } from "@repo/design-system/build-utils";

const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const gitBranch = getGitBranch();

// CSP is handled by proxy.ts (nonce-based)
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "X-XSS-Protection", value: "0" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@modelcontextprotocol/client",
  ],
  logging: { incomingRequests: { ignore: [/\/api\/lifeor\/oauth\/callback/] } },
  env: {
    ...(gitBranch ? { NEXT_PUBLIC_GIT_BRANCH: gitBranch } : {}),
  },
  transpilePackages: [
    "@repo/design-system",
    "@repo/auth",
    "@repo/backend",
    "@repo/edge-rate-limit",
    "@repo/i18n",
  ],
  headers: async () => [
    { source: "/(.*)", headers: securityHeaders },
    {
      source: "/api/lifeor/oauth/callback",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ],
    },
  ],
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
};

export default withNextIntl(nextConfig);
