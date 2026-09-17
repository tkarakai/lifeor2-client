import { isLocalDevelopment } from "./developmentOnly";
import { httpAction } from "./_generated/server";

export const getDevTotpCode = httpAction(async () => {
  const devEnabled = process.env.DEV_SEED_ENABLED;

  if (devEnabled !== "true" || !isLocalDevelopment()) {
    return new Response(JSON.stringify({ error: "Not available" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      message:
        "Use the TOTP code from your authenticator app or server console",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
});
