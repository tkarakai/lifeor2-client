import { test, expect } from "@playwright/test";
import { createDisposableUser } from "./helpers/fixtures";

test("LifeOR2 cookies cannot replace the client session at the OAuth callback", async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createDisposableUser();
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin: baseURL! },
    data: { email: user.email, password: user.password },
  });
  expect(login.ok()).toBe(true);
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === "lifeor2-client.session_token")).toBe(true);
  expect(cookies.some((c) => c.name === "better-auth.session_token")).toBe(false);
  const initial = await (await page.request.get("/api/auth/get-session")).json();
  expect(initial.user.email).toBe(user.email);

  // Same browser-cookie scope as logging into LifeOR2 on port 3000.
  await context.addCookies([
    { name: "better-auth.session_token", value: "independent-lifeor-session", url: "http://localhost:3000", httpOnly: true },
    { name: "better-auth.convex_jwt", value: "independent-lifeor-jwt", url: "http://localhost:3000", httpOnly: true },
  ]);
  const state = await page.request.get("/api/lifeor/state");
  expect(state.status()).toBe(200);
  const configured = (await state.json()).configured;
  const after = await (await page.request.get("/api/auth/get-session")).json();
  expect(after.session.id).toBe(initial.session.id);

  // Invalid state must reach OAuth validation, not fail client authentication.
  // No real authorization code or LifeOR2 account is needed for this regression.
  const callback = await page.request.get(
    "/api/lifeor/oauth/callback?iss=http%3A%2F%2Flocalhost%3A3000&state=invalid-fixture-state&error=access_denied",
    { maxRedirects: 0 },
  );
  if (configured) {
    expect(callback.status()).toBe(303);
    expect(callback.headers().location).toContain("connection=OAUTH_INVALID");
  } else {
    // CI does not need a live registered LifeOR2 OAuth client.
    expect(callback.status()).toBe(503);
    expect((await callback.json()).code).toBe("CONFIGURATION_REQUIRED");
  }

  await page.goto("/hu/dashboard");
  await expect(page.getByRole("heading", { name: "Your life, in context." })).toBeVisible();
  await page.request.get("/api/auth/clear-session", { maxRedirects: 0 });
  const remaining = await context.cookies();
  expect(remaining.some((c) => c.name === "lifeor2-client.session_token")).toBe(false);
  expect(remaining.find((c) => c.name === "better-auth.session_token")?.value).toBe("independent-lifeor-session");
  expect(remaining.find((c) => c.name === "better-auth.convex_jwt")?.value).toBe("independent-lifeor-jwt");
  const protectedPage = await page.request.get("/hu/dashboard", { maxRedirects: 0 });
  expect(protectedPage.headers().location).toContain("/sign-in");
});
