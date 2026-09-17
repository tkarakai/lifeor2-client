/** Development access must fail closed on every non-loopback deployment. */
export function isLocalDevelopment(): boolean {
  const origins = (process.env.SITE_URL ?? "")
    .split(",")
    .map((value) => value.trim());
  return (
    origins.length > 0 &&
    origins.every((origin) => {
      try {
        const url = new URL(origin);
        return (
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        );
      } catch {
        return false;
      }
    })
  );
}
export function assertMockEmailAllowed(): void {
  if (!isLocalDevelopment()) throw new Error("EMAIL_DELIVERY_NOT_CONFIGURED");
}
