import "server-only";
import { AppError } from "./config";
import type { Store } from "./types";
export function storeFor(request: Request, finalizeOwner?: string): Store {
  const cookie = request.headers.get("cookie") ?? "";
  return async <T>(op: string, payload: Record<string, unknown> = {}) => {
    const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
      key = process.env.LIFEOR_STORE_SECRET;
    if (!site || !key || key.length < 32)
      throw new AppError("CONFIGURATION_REQUIRED", 503);
    const response = await fetch(`${site}/lifeor/store`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lifeor-key": key,
        cookie,
      },
      body: JSON.stringify({ op, payload, finalizeOwner }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401) throw new AppError("SESSION_EXPIRED", 401);
    const value = await response.json();
    if (!response.ok)
      throw new AppError(value.error ?? "STORAGE_UNAVAILABLE", response.status);
    return value as T;
  };
}
export type Identity = { ownerId: string; sessionId: string };
