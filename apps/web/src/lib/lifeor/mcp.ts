import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { config, AppError } from "./config";
import { setTimeout as delay } from "node:timers/promises";
import { accessToken } from "./oauth";
import { randomUUID } from "node:crypto";
import type { Dataset, Store, Observe } from "./types";
export const PROTOCOL_VERSION = "2026-07-28";
export async function connectMcp(
  store: Store,
  ownerId: string,
  connection: string,
  observe?: Observe,
) {
  const client = new Client(
    { name: "lifeor2-client", version: "0.1.0" },
    {
      versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
      capabilities: { elicitation: { form: {} } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config().mcp), {
      authProvider: { token: () => accessToken(store, ownerId, connection) },
      fetch: async (input, init) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const exchange = randomUUID();
          if (observe && typeof init?.body === "string")
            await observe({
              exchange,
              channel: "mcp",
              direction: "request",
              label: "MCP request",
              body: JSON.parse(init.body),
            });
          let response = await fetch(input, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(30000),
            ]),
          });
          if (observe) {
            const status = response.status;
            await observe({
              exchange,
              channel: "mcp",
              direction: "response",
              label: `MCP · HTTP ${status}`,
              body: { status },
            });
            if (response.body) {
              let captured = "";
              let truncated = false;
              const decoder = new globalThis.TextDecoder();
              const capture = (text: string) => {
                if (captured.length + text.length > 48000) truncated = true;
                captured = (captured + text).slice(0, 48000);
              };
              response = new Response(
                response.body.pipeThrough(
                  new globalThis.TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) {
                      capture(decoder.decode(chunk, { stream: true }));
                      controller.enqueue(chunk);
                    },
                    async flush() {
                      capture(decoder.decode());
                      let body: unknown;
                      try {
                        body = JSON.parse(captured);
                      } catch {
                        body = captured.includes("data:")
                          ? captured
                              .split("\n")
                              .filter((line) => line.startsWith("data:"))
                              .map((line) => {
                                try {
                                  return JSON.parse(line.slice(5));
                                } catch {
                                  return {
                                    preview: line.slice(5),
                                    incomplete: true,
                                  };
                                }
                              })
                          : { preview: captured };
                      }
                      await observe({
                        exchange,
                        channel: "mcp",
                        direction: "response",
                        label: `MCP · HTTP ${status}`,
                        body: {
                          status,
                          body,
                          ...(truncated ? { truncated: true } : {}),
                        },
                      });
                    },
                  }),
                ),
                { status, headers: response.headers },
              );
            }
          }
          if (response.status === 401) {
            await store("connection.invalidate", { identity: connection });
            throw new AppError("RECONNECT_REQUIRED", 401);
          }
          if (response.status === 403)
            throw new AppError("INSUFFICIENT_SCOPE", 403);
          if (response.status === 429) {
            const retry = response.headers.get("Retry-After") ?? "60";
            const seconds = Number(retry);
            const ms = Number.isFinite(seconds)
              ? seconds * 1000
              : Date.parse(retry) - Date.now();
            // A 429 rejected the operation. Retry at most once, preserving the exact body/key.
            if (
              attempt === 0 &&
              ms >= 0 &&
              ms <= 30000 &&
              typeof init?.body === "string"
            ) {
              await response.body?.cancel();
              await delay(Math.max(1000, ms), undefined, {
                signal: init?.signal ?? undefined,
              });
              continue;
            }
            throw new AppError("RATE_LIMITED", 429);
          }
          return response;
        }
        throw new AppError("RATE_LIMITED", 429);
      },
    }),
  );
  await client.discover({ timeout: 30000 });
  return client;
}
export async function authorizedDatasets(client: Client): Promise<Dataset[]> {
  const result = await client.callTool(
    { name: "datasets.list", arguments: {} },
    { timeout: 30000 },
  );
  if (result.isError) throw new AppError("DATASET_DENIED", 403);
  const raw = result.structuredContent;
  if (!Array.isArray(raw)) throw new AppError("MCP_UNAVAILABLE", 503);
  return raw.map((d) => {
    if (typeof d?._id !== "string" || typeof d?.name !== "string")
      throw new AppError("MCP_UNAVAILABLE", 503);
    return { id: d._id, name: d.name };
  });
}
