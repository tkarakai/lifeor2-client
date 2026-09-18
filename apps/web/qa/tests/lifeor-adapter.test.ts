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
  let readCalls = 0;
  let commits = 0,
    decision = "cancel";
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "fixture", version: "1" });
      server.registerTool(
        "records.read",
        {
          description: "Read current records",
          annotations: { readOnlyHint: true },
          _meta: { "lifeor2/primary": true },
          inputSchema: fromJsonSchema({
            type: "object",
            properties: { datasetId: { type: "string" } },
            required: ["datasetId"],
            additionalProperties: false,
          }),
        },
        async () => {
          readCalls++;
          const result = { revision: received.length };
          return {
            resultType: "complete",
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        },
      );
      server.registerTool(
        "records.edit",
        {
          description: "Edit current records",
          _meta: { "lifeor2/primary": true },
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
    const direct = tools.find((t) => t.name === "records_read")!;
    expect(direct).toBeDefined();
    expect(JSON.stringify(direct.parameters)).not.toContain("datasetId");
    expect(tools.some((t) => t.name === "records_edit")).toBe(false);
    await expect(
      direct.execute("cross-dataset-read", { datasetId: "other" }),
    ).rejects.toThrow("DATASET_DENIED");
    const args = { name: "records.edit", arguments: { expectedRevision: 3 } };
    const read = { name: "records.read", arguments: {} };
    await call.execute("read-before-1", read);
    await call.execute("read-before-2", read);
    await call.execute("read-loop", read);
    expect(readCalls).toBe(2);
    await call.execute("first", args);
    await call.execute("second", args);
    const verification = await call.execute("verify-after-write", read);
    expect(readCalls).toBe(3);
    expect(JSON.stringify(verification.content)).toContain("revision");
    expect(received[0].datasetId).toBe("dataset-a");
    expect(received[0].requestKey).toBe(received[1].requestKey);
    expect(received[0].expectedRevision).toBe(3);
    const invalid = await call.execute("invalid", {
      name: "records.edit",
      arguments: {},
    });
    expect(JSON.stringify(invalid.content)).toContain("INVALID_ARGUMENTS");
    expect(JSON.stringify(invalid.content)).toContain("expectedRevision");
    expect(invalid.details).toEqual({ isError: true });
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
    const directResult = await direct.execute("direct-verify", {});
    expect(JSON.stringify(directResult.content)).toContain("revision");
    expect(
      events.some(
        (e) => e.type === "operation" && String(e.data).includes("records.read"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "decision")).toBe(true);
    expect(confirmation?.arguments).toContain("dataset-a");
  } finally {
    await client.close();
    await server.stop(true);
  }
});

test("later reports and successful writes invalidate an earlier prepared answer", async () => {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "report-fixture", version: "1" });
    for (const name of ["reports.finances", "reports.present", "records.edit"]) {
      mcp.registerTool(name, {
        description: name,
        annotations: { readOnlyHint: name !== "records.edit" },
        inputSchema: fromJsonSchema({
          type: "object", properties: { datasetId: { type: "string" } },
          required: ["datasetId"], additionalProperties: false,
        }),
      }, async () => {
        const value = name === "reports.finances" ? { reportId: "fresh" }
          : name === "reports.present" ? { answer: "Verified facts" } : { saved: true };
        return { resultType: "complete", structuredContent: value,
          content: [{ type: "text", text: JSON.stringify(value) }] };
      });
    }
    return mcp;
  }, { legacy: "reject", responseMode: "json" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: r => handler.fetch(r) });
  const client = new Client({ name: "report-client", version: "1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
    capabilities: { elicitation: { form: {} } },
  });
  let prepared: string | undefined;
  let required = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}`)));
    const tools = await adapter(client, (async () => null) as Store, "run", "dataset",
      new AbortController().signal, () => {}, value => { prepared = value; }, value => { required = value; });
    const call = tools.find(t => t.name === "call_tool")!;
    const execute = (name: string) => call.execute(name, { name, arguments: {} });
    await execute("reports.finances");
    expect(required).toBe(true);
    await execute("reports.present");
    expect(prepared).toBe("Verified facts");
    await execute("reports.finances");
    expect(prepared).toBeUndefined();
    expect(required).toBe(true);
    await execute("reports.present");
    await execute("records.edit");
    expect(prepared).toBeUndefined();
    expect(required).toBe(false);
  } finally {
    await client.close();
    await server.stop(true);
  }
});

test("MCP wire inspection preserves the response and excludes auth credentials", async () => {
  const originalEnv = { ...process.env };
  const { connectMcp } = await import("../../src/lib/lifeor/mcp");
  const { observer } = await import("../../src/lib/lifeor/observation");
  const { seal } = await import("../../src/lib/lifeor/crypto");
  const captured: unknown[] = [];
  let authenticated = false;
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: "observed-fixture", version: "1" });
      mcp.registerTool(
        "records.read",
        {
          description: "Read fixture",
          inputSchema: fromJsonSchema({ type: "object", properties: {} }),
        },
        async () => ({
          resultType: "complete",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                marker: "wire-fixture-42",
                access_token: "embedded-credential",
              }),
            },
          ],
        }),
      );
      return mcp;
    },
    { legacy: "reject", responseMode: "json" },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      authenticated ||=
        request.headers.get("authorization") === "Bearer fixture-credential";
      return handler.fetch(request);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  process.env.LIFEOR_MCP_URL = `${base}/mcp`;
  process.env.LIFEOR_OAUTH_CLIENT_ID = `${base}/oauth/clients/fixture`;
  process.env.LIFEOR_OAUTH_REDIRECT_URI =
    "http://localhost:3002/api/lifeor/oauth/callback";
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3002";
  process.env.MCP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const tokens = seal(
    {
      access_token: "fixture-credential",
      refresh_token: "refresh-secret",
      expiresAt: Date.now() + 120000,
    },
    "alice",
  );
  const store: Store = async <T>(
    op: string,
    payload?: Record<string, unknown>,
  ) => {
    if (op === "credentials")
      return {
        identity: "grant",
        status: "connected",
        refreshing: false,
        tokens,
      } as T;
    if (op === "run.observe") captured.push(payload?.observation);
    return null as T;
  };
  let client: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    client = await connectMcp(store, "alice", "grant", observer(store, "run"));
    const result = await client.callTool({
      name: "records.read",
      arguments: {},
    });
    expect(JSON.stringify(result)).toContain("wire-fixture-42");
    expect(JSON.stringify(captured)).toContain("wire-fixture-42");
    expect(JSON.stringify(captured)).toContain("tools/call");
    expect(JSON.stringify(captured)).not.toContain("fixture-credential");
    expect(JSON.stringify(captured)).not.toContain("embedded-credential");
    expect(authenticated).toBe(true);
  } finally {
    await client?.close();
    server.stop(true);
    process.env = originalEnv;
  }
});
