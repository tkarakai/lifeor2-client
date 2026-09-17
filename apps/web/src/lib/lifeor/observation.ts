import { randomUUID } from "node:crypto";
import type { Observe, Store } from "./types";

const sensitive =
  /^(authorization|cookie|set-cookie|x-lifeor-key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|sealed|tokens|reasoning_content|reasoning|thinking|signature)$/i;
/** Transport credentials and hidden reasoning never enter the observation store. */
export function sanitizeObservation(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter(
        (v) =>
          !(
            v &&
            typeof v === "object" &&
            ["thinking", "reasoning"].includes(v.type)
          ),
      )
      .map(sanitizeObservation);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        sensitive.test(k) ? "[redacted]" : sanitizeObservation(v),
      ]),
    );
  if (typeof value === "string") {
    // MCP often embeds JSON inside a text content block.
    if (["[", "{"].includes(value.trimStart()[0])) {
      try {
        return JSON.stringify(sanitizeObservation(JSON.parse(value)));
      } catch {
        /* Plain text or a bounded preview. */
      }
    }
    let text = value.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
    text = text.replace(
      /("(?:access_token|refresh_token|api_key|client_secret|password|authorization)"\s*:\s*")[^"\n]*/gi,
      "$1[redacted]",
    );
    for (const secret of [
      process.env.LLM_API_KEY,
      process.env.LIFEOR_STORE_SECRET,
      process.env.MCP_TOKEN_ENCRYPTION_KEY,
    ])
      if (secret) text = text.replaceAll(secret, "[redacted]");
    return text;
  }
  return value;
}
export function observer(store: Store, runId: string): Observe {
  return async (entry) => {
    const raw =
      JSON.stringify(sanitizeObservation(entry.body), null, 2) ?? "null";
    const bytes = Buffer.from(raw);
    const preview = new globalThis.TextDecoder().decode(
      bytes.subarray(0, 48000),
      { stream: true },
    );
    // Separate rows, loaded only on demand. Never enlarge the agent's history.
    await store("run.observe", {
      id: runId,
      observation: {
        ...entry,
        id: randomUUID(),
        at: Date.now(),
        body: preview,
        truncated: bytes.length > 48000,
      },
    });
  };
}
