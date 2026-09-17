/** Real inference + real MCP v2 transport, with isolated read-only fixture data. */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import { Type } from "typebox";
import { makeAgent } from "../src/lib/lifeor/model";
import { modelConfig } from "../src/lib/lifeor/config";
const marker = `check-${crypto.randomUUID().slice(0, 8)}`;
const handler = createMcpHandler(
  () => {
    const server = new McpServer({ name: "lifeor-smoke", version: "1.0.0" });
    server.registerTool(
      "records_read",
      {
        description: "Read the current read-only verification record.",
        inputSchema: fromJsonSchema({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        annotations: { readOnlyHint: true },
      },
      async () => ({
        resultType: "complete",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reference: marker,
              amount: 173,
              currency: "USD",
            }),
          },
        ],
      }),
    );
    return server;
  },
  { legacy: "reject", responseMode: "json" },
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => handler.fetch(request),
});
const client = new Client(
  { name: "lifeor-client-smoke", version: "0.1.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
let deltas = 0,
  calls = 0,
  answer = "";
const start = Date.now();
try {
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}`),
    ),
  );
  const agent = makeAgent(
    "Call records_read to obtain the verification record. Then reply with its reference, amount and currency exactly. Do not invent data.",
    [
      {
        name: "records_read",
        label: "Read verification record",
        description: "Read the verification record",
        parameters: Type.Object({}),
        execute: async () => {
          calls++;
          const result = await client.callTool({
            name: "records_read",
            arguments: {},
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: {},
          };
        },
      },
    ],
  );
  agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      deltas++;
      answer += event.assistantMessageEvent.delta;
    }
  });
  const timeout = setTimeout(() => agent.abort(), 120000);
  try {
    await agent.prompt(
      "Please read the verification record and report its reference, amount and currency.",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (
    !calls ||
    !deltas ||
    !answer.includes(marker) ||
    !answer.includes("173") ||
    agent.state.errorMessage
  )
    throw new Error(
      `Round trip failed: calls=${calls}, deltas=${deltas}, error=${agent.state.errorMessage ?? "none"}, answer=${answer}`,
    );
  const c = modelConfig();
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        runtime: Bun.version,
        pi: "0.85.1",
        mcpSdk: "2.0.0",
        protocol: "2026-07-28",
        model: c.model,
        endpoint: c.baseUrl,
        calls,
        deltas,
        elapsedMs: Date.now() - start,
        answer,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await server.stop(true);
}
