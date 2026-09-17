import { expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  acceptedContent,
} from "@modelcontextprotocol/server";
import type { Run, Store } from "../../src/lib/lifeor/types";
const { adapter } = await import("../../src/lib/lifeor/adapter");

test("real MCP v2 adapter persists stable write keys and waits for an explicit confirmation", async () => {
  const received: Record<string, unknown>[] = [];
  let commits = 0,
    decision = "cancel";
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "fixture", version: "1" });
      server.registerTool(
        "records.edit",
        {
          description: "Edit current records",
          inputSchema: fromJsonSchema({
            type: "object",
            properties: {
              datasetId: { type: "string" },
              requestKey: { type: "string" },
              expectedRevision: { type: "number" },
            },
            required: ["datasetId", "requestKey", "expectedRevision"],
            additionalProperties: false,
          }),
        },
        async (args) => {
          received.push(args);
          return {
            resultType: "complete",
            content: [{ type: "text", text: "saved" }],
            structuredContent: { saved: true },
          };
        },
      );
      server.registerTool(
        "trash.delete",
        {
          description: "Permanently delete a named record",
          inputSchema: fromJsonSchema({
            type: "object",
            properties: {
              datasetId: { type: "string" },
              requestKey: { type: "string" },
            },
            required: ["datasetId", "requestKey"],
            additionalProperties: false,
          }),
        },
        async (_args, ctx) => {
          const answer = acceptedContent(
            ctx.mcpReq.inputResponses,
            "delete-exact",
          );
          if (ctx.mcpReq.inputResponses && !answer)
            return {
              resultType: "complete",
              isError: true,
              content: [{ type: "text", text: "canceled" }],
            };
          if (answer?.confirmation !== "DELETE")
            return inputRequired({
              inputRequests: {
                "delete-exact": inputRequired.elicit({
                  message: "Permanently delete fixture?",
                  requestedSchema: {
                    type: "object",
                    properties: { confirmation: { type: "string" } },
                    required: ["confirmation"],
                  },
                }),
              },
            });
          commits++;
          return {
            resultType: "complete",
            content: [{ type: "text", text: "deleted" }],
          };
        },
      );
      return server;
    },
    { legacy: "reject", responseMode: "json" },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) => handler.fetch(r),
  });
  const client = new Client(
    { name: "fixture-client", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: { elicitation: { form: {} } },
    },
  );
  const events: Record<string, unknown>[] = [];
  let confirmation: Run["confirmation"];
  const store: Store = async <T>(
    op: string,
    p: Record<string, unknown> = {},
  ) => {
    if (op === "run.event") events.push(p);
    if (op === "run.confirm") {
      expect(commits).toBe(0);
      confirmation = {
        id: String(p.confirmationId),
        message: String(p.message),
        schema: String(p.schema),
        arguments: String(p.arguments),
        operation: String(p.operation),
        expiresAt: Date.now() + 1000,
      };
    }
    if (op === "run.get")
      return {
        confirmation: {
          ...confirmation,
          decision: JSON.stringify({
            action: decision,
            content: { confirmation: "DELETE" },
          }),
        },
      } as T;
    return null as T;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}`),
      ),
    );
    const tools = await adapter(
        client,
        store,
        "run-a",
        "dataset-a",
        new AbortController().signal,
        () => {},
      ),
      call = tools.find((t) => t.name === "call_tool")!;
    const args = { name: "records.edit", arguments: { expectedRevision: 3 } };
    await call.execute("first", args);
    await call.execute("second", args);
    expect(received[0].datasetId).toBe("dataset-a");
    expect(received[0].requestKey).toBe(received[1].requestKey);
    expect(received[0].expectedRevision).toBe(3);
    await call.execute("invalid", { name: "records.edit", arguments: {} });
    expect(received.length).toBe(2);
    await expect(
      call.execute("cross-dataset", {
        name: "records.edit",
        arguments: { datasetId: "other", expectedRevision: 3 },
      }),
    ).rejects.toThrow("DATASET_DENIED");
    await call.execute("delete-cancel", {
      name: "trash.delete",
      arguments: {},
    });
    expect(commits).toBe(0);
    decision = "accept";
    await call.execute("delete-confirm", {
      name: "trash.delete",
      arguments: {},
    });
    expect(commits).toBe(1);
    expect(events.some((e) => e.type === "decision")).toBe(true);
    expect(confirmation?.arguments).toContain("dataset-a");
  } finally {
    await client.close();
    await server.stop(true);
  }
});
