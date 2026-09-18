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
    for (const name of ["reports.finances", "reports.present", "reports.read", "records.edit", "legacy.income", "life.timeline"]) {
      mcp.registerTool(name, {
        description: name,
        annotations: { readOnlyHint: name !== "records.edit" },
        ...(name === "legacy.income" ? { _meta: { "lifeor2/replacedBy": "reports.finances" } } : {}),
        inputSchema: fromJsonSchema({
          type: "object", properties: { datasetId: { type: "string" }, reportId: { type: "string" }, offset: { type: "integer" } },
          required: ["datasetId"], additionalProperties: false,
        }),
      }, async () => {
        const value = name === "reports.read" ? { reportId: "fresh", rows: ["Remaining category"], nextOffset: null }
          : name === "life.timeline" ? { reportId: "empty", reportType: "timeline", items: [], matchedCount: 0, itemsComplete: true, queryComplete: true }
          : name === "reports.finances" ? { reportId: "fresh" }
          : name === "reports.present" ? { answer: "Verified facts", reportIds: ["fresh"] } : { saved: true };
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
    await execute("life.timeline");
    expect(required).toBe(false);
    const unknown = await execute("legacy.income");
    expect(JSON.stringify(unknown.content)).toContain("UNKNOWN_TOOL");
    const found = await tools.find(t => t.name === "find_tools")!.execute("discover", { query: "legacy.income" });
    expect(JSON.stringify(found.content)).not.toContain('"name":"legacy.income"');
    await execute("reports.finances");
    expect(required).toBe(true);
    const page = await tools.find(t => t.name === "read_result")!.execute("page", { resultId: "fresh", path: "/rows", offset: 8 });
    expect(JSON.stringify(page.content)).toContain("Remaining category");
    const presented = await execute("reports.present");
    expect(prepared).toBe("Verified facts");
    expect(JSON.stringify(presented.content)).toContain("fresh");
    expect(JSON.stringify(presented.content)).toContain("snapshot");
    expect(JSON.stringify(presented.content)).not.toContain("Verified facts");
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

test("expense payment accounts require an original user reference even when records suggest one", async () => {
  let writes = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "payment-fixture", version: "1" });
    for (const name of ["life.read", "records.recordExpense"]) {
      const reading = name === "life.read";
      server.registerTool(name, {
        description: name,
        annotations: { readOnlyHint: reading },
        inputSchema: fromJsonSchema({ type: "object", properties: {
          datasetId: { type: "string" },
          ...(reading ? { kind: { type: "string" }, id: { type: "string" } } : { paidFromAccountId: { type: "string" }, expenseAccountId: { type: "string" }, requestKey: { type: "string" } }),
        }, required: reading ? ["datasetId", "kind", "id"] : ["datasetId", "paidFromAccountId", "expenseAccountId", "requestKey"], additionalProperties: false }),
      }, async (args) => {
        if (!reading) writes++;
        const result = reading ? { record: { _id: args.id, name: args.id === "cash" ? "Ellis checking" : "Ellis groceries" } } : { saved: true };
        return { resultType: "complete", content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      });
    }
    return server;
  }, { legacy: "reject", responseMode: "json" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: r => handler.fetch(r) });
  const client = new Client({ name: "fixture", version: "1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { elicitation: { form: {} } },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}`)));
    const store: Store = async <T>() => null as T;
    for (const [question, prior, allowed] of [
      ["Record a $50 grocery expense", [], false],
      ["Record a $50 expense from Ellis checking", [], false],
      ["Record a $50 grocery expense from Ellis checking", [], true],
      ["Record another $50 grocery expense", ["Use Ellis checking for this receipt"], true],
    ] as const) {
      const list = await adapter(client, store, `run-${writes}`, "dataset", new AbortController().signal, () => {}, undefined, undefined, question, [...prior]);
      const call = list.find(t => t.name === "call_tool")!;
      // Verification can reuse an already-read identity rather than trip the read-loop guard.
      for (let i = 0; i < 2; i++) await call.execute(`read-${i}`, { name: "life.read", arguments: { kind: "ledger_account", id: "cash" } });
      const before = writes;
      const result = await call.execute("expense", { name: "records.recordExpense", arguments: { paidFromAccountId: "cash", expenseAccountId: "food" } });
      expect(writes - before).toBe(allowed ? 1 : 0);
      if (!allowed) expect(JSON.stringify(result.content)).toContain("_REQUIRED");
    }
  } finally { await client.close(); await server.stop(true); }
});

test("clarification finishes directly and blocks a later operation in the same tool batch", async () => {
  let calls = 0;
  let final: string | undefined;
  const events: unknown[] = [];
  const client = {
    listTools: async () => ({ tools: [{ name: "records.edit", inputSchema: { type: "object", properties: { datasetId: { type: "string" } }, required: ["datasetId"] } }] }),
    setRequestHandler: () => {},
    callTool: async () => { calls++; return {}; },
  } as unknown as Client;
  const store = (async (_op: string, args: unknown) => { events.push(args); return null; }) as Store;
  const tools = await adapter(client, store, "run", "dataset", new AbortController().signal, () => {}, text => { final = text; });
  await tools.find(t => t.name === "ask_user")!.execute("ask", { question: "Which payment account should I use?" });
  expect(final).toBe("Which payment account should I use?");
  const blocked = await tools.find(t => t.name === "call_tool")!.execute("late", { name: "records.edit", arguments: {} });
  expect(blocked.details).toEqual({ isError: true });
  expect(calls).toBe(0);
  expect(JSON.stringify(events)).toContain('clarification');
});

test("the bounded direct read surface includes current debt and period comparison", async () => {
  const names = [...Array.from({ length: 10 }, (_, i) => `life.read${i}`), "reports.comparePeriods", "life.obligations", "life.extra"];
  const client = {
    listTools: async () => ({ tools: names.map(name => ({
      name,
      annotations: { readOnlyHint: true },
      _meta: { "lifeor2/primary": true },
      inputSchema: { type: "object", properties: { datasetId: { type: "string" } }, required: ["datasetId"] },
    })) }),
    setRequestHandler: () => {},
  } as unknown as Client;
  const exposed = await adapter(client, (async () => null) as Store, "run", "dataset", new AbortController().signal, () => {});
  expect(exposed.some(t => t.name === "reports_comparePeriods")).toBe(true);
  expect(exposed.some(t => t.name === "life_read9")).toBe(true);
  expect(exposed.some(t => t.name === "life_obligations")).toBe(true);
  expect(exposed.some(t => t.name === "life_extra")).toBe(false);
});

test("server-computed clock choices finish verbatim and block a later write", async () => {
  let calls = 0;
  let final: string | undefined;
  const question = "2026-11-01 at 01:30 occurs twice in America/Chicago. First occurrence (UTC−05:00) or second occurrence (UTC−06:00)?";
  const client = {
    listTools: async () => ({ tools: ["records.rescheduleEvent", "records.edit"].map(name => ({ name, inputSchema: { type: "object", properties: { datasetId: { type: "string" } }, required: ["datasetId"] } })) }),
    setRequestHandler: () => {},
    callTool: async () => { calls++; return { structuredContent: { status: "needs_input", kind: "ambiguous_local_time", question, choices: [{ utcOffsetMinutes: -300 }, { utcOffsetMinutes: -360 }] } }; },
  } as unknown as Client;
  const tools = await adapter(client, (async () => null) as Store, "run", "dataset", new AbortController().signal, () => {}, text => { final = text; });
  const call = tools.find(t => t.name === "call_tool")!;
  await call.execute("clock", { name: "records.rescheduleEvent", arguments: {} });
  expect(final).toBe(question);
  expect((await call.execute("late", { name: "records.edit", arguments: {} })).details).toEqual({ isError: true });
  expect(calls).toBe(1);
});

test("a write requires fresh queried reports, not a reread of an old saved snapshot", async () => {
  let query = 0;
  const presented: unknown[] = [];
  const names = ["reports.finances", "reports.read", "reports.present", "records.edit"];
  const client = {
    listTools: async () => ({ tools: names.map(name => ({ name, annotations: {readOnlyHint:name!=="records.edit"}, inputSchema: { type:"object",properties:{datasetId:{type:"string"},reportIds:{type:"array",items:{type:"string"}}},required:["datasetId"] } })) }),
    setRequestHandler: () => {},
    callTool: async (call: {name:string;arguments:Record<string,unknown>}) => {
      if (call.name === "reports.finances") return {structuredContent:{reportId:`report-${++query}`}};
      if (call.name === "reports.read") return {structuredContent:{reportId:"report-1"}};
      if (call.name === "reports.present") { presented.push(call.arguments.reportIds); return {structuredContent:{answer:"Current evidence"}}; }
      return {structuredContent:{saved:true}};
    },
  } as unknown as Client;
  let answer: string | undefined;
  const tools = await adapter(client,(async()=>null) as Store,"run","dataset",new AbortController().signal,()=>{},text=>{answer=text;});
  const call = tools.find(t=>t.name==="call_tool")!;
  const run = (name:string,arguments_:Record<string,unknown>={}) => call.execute(name,{name,arguments:arguments_});
  await run("reports.finances");
  await run("records.edit");
  expect(JSON.stringify((await run("reports.present",{reportIds:["report-1"]})).content)).toContain("STALE_REPORT_AFTER_WRITE");
  await run("reports.read");
  expect((await run("reports.present",{reportIds:["report-1"]})).details).toEqual({isError:true});
  expect(presented).toEqual([]);
  await run("reports.finances");
  await run("reports.present",{reportIds:["report-2"]});
  expect(presented).toEqual([["report-2"]]);
  expect(answer).toBe("Current evidence");
});

test("a hypothetical movement asks for its account instead of inventing an allocation", async () => {
  let projections = 0;
  const client = {
    listTools: async () => ({
      tools: ["life.read", "reports.cashProjection"].map(name => ({
        name, annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            datasetId: { type: "string" }, kind: { type: "string" }, id: { type: "string" },
            additionalMovements: {
              type: "array", items: {
                type: "object", properties: {
                  accountId: { type: "string" }, date: { type: "string" }, amount: { type: "string" },
                },
              },
            },
          },
          required: ["datasetId"],
        },
      })),
    }),
    setRequestHandler:()=>{},
    callTool:async (call:{name:string})=>{
      if(call.name==="life.read")return {structuredContent:{record:{_id:"cash",name:"Household bills checking · 1042"}}};
      projections++;return {structuredContent:{reportId:"scenario"}};
    },
  } as unknown as Client;
  for (const [question,prior,allowed] of [
    ["What if we spent an extra $10000 from household checking?",[],false],
    ["What if we spent an extra $10000 from Household bills checking · 1042?",[],true],
    ["Use it for that hypothetical expense.",["Use Household bills checking · 1042"],true],
  ] as const) {
    let answer:string|undefined;
    const tools=await adapter(client,(async()=>null) as Store,"run","dataset",new AbortController().signal,()=>{},text=>{answer=text;},undefined,question,[...prior]);
    const call=tools.find(t=>t.name==="call_tool")!;
    const before=projections;
    await call.execute("scenario",{name:"reports.cashProjection",arguments:{additionalMovements:[{accountId:"cash",date:"2026-10-10",amount:"-10000"}]}});
    expect(projections-before).toBe(allowed?1:0);
    if(!allowed){
      expect(answer).toBe("Which account should the hypothetical one-off payment or receipt affect?");
      expect((await call.execute("late",{name:"reports.cashProjection",arguments:{}})).details).toEqual({isError:true});
      expect(projections).toBe(before);
    }
  }
});


for (const target of ["scenario", "payment", "category"] as const) {
  test(`an unresolved ${target} account can recover without asking for an already supplied choice`, async () => {
    const completed: string[] = [];
    let answer: string | undefined;
    const client = {
      listTools: async () => ({ tools: ["life.read", "records.recordExpense", "reports.cashProjection"].map(name => ({
        name, annotations: { readOnlyHint: name !== "records.recordExpense" },
        inputSchema: { type: "object", properties: {
          datasetId: { type: "string" }, kind: { type: "string" }, id: { type: "string" },
          paidFromAccountId: { type: "string" }, expenseAccountId: { type: "string" },
          additionalMovements: { type: "array", items: { type: "object" } },
        }, required: ["datasetId"] },
      })) }),
      setRequestHandler: () => {},
      callTool: async (call: { name: string; arguments: Record<string, unknown> }) => {
        if (call.name === "life.read") {
          const id = call.arguments.id;
          if (id === "1042" || id === "groceries") return { isError: true, content: [{ type: "text", text: "Invalid record ID" }] };
          return { structuredContent: { record: { _id: id, name: id === "cash" ? "Household bills checking · 1042" : "Groceries" } } };
        }
        completed.push(call.name);
        return { structuredContent: { saved: true } };
      },
    } as unknown as Client;
    const tools = await adapter(client, (async () => null) as Store, "run", "dataset", new AbortController().signal, () => {}, text => { answer = text; }, undefined,
      "Use Household bills checking · 1042 for this groceries expense or hypothetical movement.");
    const call = tools.find(t => t.name === "call_tool")!;
    const name = target === "scenario" ? "reports.cashProjection" : "records.recordExpense";
    const args = (resolved: boolean) => target === "scenario"
      ? { additionalMovements: [{ accountId: resolved ? "cash" : "1042", date: "2026-10-10", amount: "-10000" }] }
      : { paidFromAccountId: target === "payment" && !resolved ? "1042" : "cash", expenseAccountId: target === "category" && !resolved ? "groceries" : "category" };
    const failed = await call.execute("bad-reference", { name, arguments: args(false) });
    expect(JSON.stringify(failed.content)).toContain("ACCOUNT_REFERENCE_UNRESOLVED");
    expect(answer).toBeUndefined();
    expect(completed).toEqual([]);
    const recovered = await call.execute("resolved-reference", { name, arguments: args(true) });
    expect(recovered.details).not.toEqual({ isError: true });
    expect(completed).toEqual([name]);
  });
}
