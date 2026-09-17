// Cookies are shared across ports on localhost. Keep the client's credentials
// distinct from LifeOR2's independent Better Auth deployment.
export const AUTH_COOKIE_PREFIX = "lifeor2-client";
export const SESSION_COOKIE_NAME = `${AUTH_COOKIE_PREFIX}.session_token`;

export function isClientSessionCookie(name: string): boolean {
  const plainName = name.replace(/^__Secure-/, "");
  return ["session_token", "session_data", "convex_jwt"].some((suffix) => {
    const base = `${AUTH_COOKIE_PREFIX}.${suffix}`;
    return plainName === base || plainName.startsWith(`${base}.`);
  });
}
