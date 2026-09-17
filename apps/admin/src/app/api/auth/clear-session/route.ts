import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isClientSessionCookie } from "@repo/auth/cookies";

/** Clear this client's stale session, without signing out other localhost apps. */
export async function GET(request: Request): Promise<NextResponse> {
  const jar = await cookies();
  const url = new URL("/sign-in", request.url);
  url.searchParams.set("session_cleared", "1");
  const response = NextResponse.redirect(url);
  for (const cookie of jar.getAll()) {
    if (isClientSessionCookie(cookie.name)) {
      response.cookies.delete({ name: cookie.name, path: "/" });
    }
  }
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  return response;
}
