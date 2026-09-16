"use client";

import type { PropsWithChildren } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { AuthClient } from "@convex-dev/better-auth/react";
import { authClient } from "./client";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({
  children,
  initialToken,
}: PropsWithChildren<{ initialToken?: string | null }>) {
  return (
    <ConvexBetterAuthProvider
      client={convex}
      // `AuthClient` is declared as
      //   ReturnType<typeof createAuthClient<BetterAuthClientPlugin & { plugins }>>
      // and that instantiation collapses `useSession().data` to `never`, so no
      // client built with real plugin inference can satisfy it — ours included.
      // The shape is correct at runtime (the auth E2E suite exercises session,
      // 2FA and passkey flows through this provider); only the declaration is
      // too narrow. Revisit when the adapter's types are widened.
      authClient={authClient as unknown as AuthClient}
      initialToken={initialToken}
    >
      {children}
    </ConvexBetterAuthProvider>
  );
}
