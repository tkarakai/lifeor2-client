export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function endpoint(value: string | undefined, name: string): URL {
  if (!value) throw new AppError(`CONFIGURATION_REQUIRED`, 503);
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(`Invalid ${name}: use HTTPS or loopback HTTP`);
  return url;
}
export function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function config() {
  const mcp = endpoint(process.env.LIFEOR_MCP_URL, "LIFEOR_MCP_URL");
  const redirect = endpoint(
    process.env.LIFEOR_OAUTH_REDIRECT_URI,
    "LIFEOR_OAUTH_REDIRECT_URI",
  );
  const site = endpoint(
    process.env.NEXT_PUBLIC_SITE_URL,
    "NEXT_PUBLIC_SITE_URL",
  );
  if (
    redirect.origin !== site.origin ||
    redirect.pathname !== "/api/lifeor/oauth/callback"
  )
    throw new Error("Invalid OAuth callback");
  const clientId = endpoint(
    process.env.LIFEOR_OAUTH_CLIENT_ID,
    "LIFEOR_OAUTH_CLIENT_ID",
  ).href;
  if (new URL(clientId).origin !== mcp.origin)
    throw new Error("Invalid OAuth client issuer");
  return {
    mcp: mcp.href,
    issuer: mcp.origin,
    redirect: redirect.href,
    clientId,
    site: site.origin,
  };
}
export function modelConfig() {
  const baseUrl = endpoint(
    process.env.LLM_BASE_URL,
    "LLM_BASE_URL",
  ).href.replace(/\/$/, "");
  const model = process.env.LLM_MODEL;
  if (!model) throw new AppError("MODEL_UNAVAILABLE", 503);
  const context = integer("LLM_CONTEXT_WINDOW", 32768, 2048, 1048576);
  const output = integer("LLM_MAX_OUTPUT_TOKENS", 2048, 128, 32768);
  if (output >= context)
    throw new Error("Output limit must be below context window");
  const compactAt = integer("LLM_COMPACT_AT_PERCENT", 80, 30, 95);
  const compactTo = integer("LLM_COMPACT_TO_PERCENT", 55, 10, 80);
  if (compactTo >= compactAt)
    throw new Error("Compaction target must be below its trigger");
  return {
    baseUrl,
    model,
    context,
    output,
    compactAt,
    compactTo,
    autoCompact: process.env.LLM_AUTO_COMPACT !== "false",
    apiKey: process.env.LLM_API_KEY || "local",
    concurrency: integer("LLM_MAX_CONCURRENT_RUNS", 2, 1, 32),
    rounds: integer("AGENT_MAX_TOOL_ROUNDS", 12, 1, 50),
    timeout: integer("AGENT_TIMEOUT_MS", 300000, 1000, 600000),
  };
}
export function sameOrigin(request: Request): void {
  const expected = endpoint(
    process.env.NEXT_PUBLIC_SITE_URL,
    "NEXT_PUBLIC_SITE_URL",
  ).origin;
  if (
    request.headers.get("origin") !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError("ORIGIN_DENIED", 403);
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("INVALID_INPUT");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 40000) {
      await reader.cancel();
      throw new AppError("INPUT_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw new AppError("INVALID_INPUT");
  }
}
export const errors: Record<string, string> = {
  CONFIGURATION_REQUIRED:
    "LifeOR2 connection settings are not configured. Ask your operator to finish setup.",
  MODEL_UNAVAILABLE:
    "The model service is unavailable. Your draft has been kept. Try again when the service is ready.",
  RECONNECT_REQUIRED:
    "Your LifeOR2 connection needs authorization. Reconnect to continue in a new conversation.",
  OAUTH_INVALID:
    "This authorization attempt expired or could not be verified. Please connect again.",
  ACCESS_DENIED:
    "LifeOR2 authorization was canceled. You can connect again whenever you’re ready.",
  INSUFFICIENT_SCOPE:
    "This connection does not have the required permission. Review connection permissions.",
  DATASET_DENIED:
    "This dataset is no longer authorized. Select an available dataset for a new conversation.",
  RUN_ACTIVE:
    "A conversation is already running. Wait for it to finish or stop it first.",
  RATE_LIMITED: "Too many requests. Please wait a minute and try again.",
  CONTEXT_LIMIT:
    "The current request is too large for the model, even after compaction. Try a smaller request or a narrower records query. Your history and completed actions are saved.",
  COMPACTION_FAILED:
    "Conversation compaction could not finish. Your history and completed actions are saved. Try again when the model is available.",
  TOOL_LIMIT:
    "The agent reached its operation limit. Review the completed actions before continuing.",
  TIMEOUT:
    "The run timed out. Completed actions remain saved; review them before trying again.",
  CONFIRMATION_EXPIRED:
    "This confirmation has expired or was already answered. Request a new operation.",
  SESSION_EXPIRED: "Your session has expired. Sign in again to continue.",
  MCP_UNAVAILABLE:
    "LifeOR2 could not be reached. An action may have committed; inspect its outcome before requesting it again.",
  REPORT_PRESENTATION_REQUIRED:
    "The report was retrieved, but its verified answer could not be presented. Try asking for that report again.",
  OUTPUT_LIMIT:
    "The model reached its output limit. The response may be incomplete.",
  STORAGE_UNAVAILABLE:
    "History could not be saved. Please try again once the connection is restored.",
  NOT_FOUND: "This conversation or run is no longer available.",
};
export function publicError(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  const code = error instanceof AppError ? error.code : "MCP_UNAVAILABLE";
  return {
    code,
    message:
      errors[code] ?? "The request could not be completed. Please try again.",
    status: error instanceof AppError ? error.status : 503,
  };
}
