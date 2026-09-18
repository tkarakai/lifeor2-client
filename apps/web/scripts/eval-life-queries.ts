/** Actual configured model + production adapter + production MCP + isolated Convex. */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { adapter, loadWorkspaceContext } from "../src/lib/lifeor/adapter";
import { makeAgent } from "../src/lib/lifeor/model";
import { workspacePrompt } from "../src/lib/lifeor/prompt";
import { sanitizeObservation } from "../src/lib/lifeor/observation";
import { modelConfig } from "../src/lib/lifeor/config";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Store } from "../src/lib/lifeor/types";
const option = (key: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ??
  fallback;
const creds = JSON.parse(
  await readFile(
    option(
      "credentials",
      "../../../lifeor2/.convex/query-evaluation/credentials.json",
    ),
    "utf8",
  ),
);
const endpoint = option("endpoint", "http://localhost:3300/mcp");
if (!/^http:\/\/(localhost|127\.0\.0\.1):3300\/mcp$/.test(endpoint))
  throw new Error(
    "Evaluation is restricted to the disposable local MCP endpoint",
  );
const cases: {
  id: string;
  question: string;
  required?: string[];
  forbidden?: string[];
  mode?: "read" | "write";
  expected?: string;
  phase?: string;
  conversation?: string;
}[] = JSON.parse(
  await readFile(
    option("cases", "../../../lifeor2/scripts/evaluation/cases.json"),
    "utf8",
  ),
);
const output = option("output", "../../.eval-results/life-queries.jsonl");
await mkdir(output.slice(0, output.lastIndexOf("/")), { recursive: true });
const conversations = new Map<string, AgentMessage[]>();
const userPrompts = new Map<string, string[]>();
for (const c of cases.filter((c) =>
  option("only", cases.map((c) => c.id).join(","))
    .split(",")
    .includes(c.id),
)) {
  const calls: Record<string, unknown>[] = [],
    traffic: unknown[] = [],
    start = Date.now(),
    abort = new AbortController();
  let renderedAnswer: string | undefined;
  let requiresPresentation = false;
    let fallbackReportIds: string[] = [];
  let answer = "",
    error: string | undefined,
    compactions = 0;
  const client = new Client(
    { name: "life-query-evaluation", version: "1" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        authProvider: { token: async () => creds.token },
      }),
    );
    const store = (async (operation: string, a: Record<string, unknown>) => {
      if (operation === "run.event") {
        if (a.type === "operation")
          console.log(
            JSON.stringify({
              progress: c.id,
              operation: JSON.parse(String(a.data)).tool,
              elapsedMs: Date.now() - start,
            }),
          );
        calls.push({
          ...a,
          data: a.data ? JSON.parse(String(a.data)) : undefined,
        });
        return null;
      }
      if (operation === "run.get")
        return {
          state: "running",
          decision: JSON.stringify({ action: "decline" }),
        };
      return null;
    }) as Store;
    const tools = await adapter(
      client,
      store,
      "eval-" + c.id,
      creds.datasetId,
      abort.signal,
      () => {},
      (answer) => {
        renderedAnswer = answer;
      },
      (required, ids) => {
        requiresPresentation = required;
        if (ids) fallbackReportIds = ids;
      },
      c.question,
      c.conversation ? (userPrompts.get(c.conversation) ?? []) : [],
    );
    if (c.conversation) userPrompts.set(c.conversation, [...(userPrompts.get(c.conversation) ?? []), c.question]);
    const agent = makeAgent(
      workspacePrompt(
        option("dataset-name", "test-data1 evaluation"),
        creds.datasetId,
        client.getInstructions(),
        undefined,
        await loadWorkspaceContext(tools),
      ),
      tools,
      c.conversation ? (conversations.get(c.conversation) ?? []) : [],
      {
        finalAnswer: () => renderedAnswer,
        requiresPresentation: () => requiresPresentation,
      fallbackReport: async () => {
        if (!fallbackReportIds.length || fallbackReportIds.length > 4) return undefined;
        const present = tools.find(t => t.name === "present_report");
        if (!present) return undefined;
        await present.execute("presentation-fallback", { reportIds: fallbackReportIds, view: "full" });
        return renderedAnswer;
      },
        observe: async (e) => {
          traffic.push({
            ...e,
            body: sanitizeObservation(e.body),
            at: Date.now(),
          });
        },
        compact: async (_, after) => {
          if (after !== undefined) compactions++;
        },
      },
    );
    timer = setTimeout(
      () => {
        abort.abort();
        agent.abort();
      },
      Number(option("timeout", "300000")),
    );
    await agent.prompt(c.question);
    error = agent.state.errorMessage;
    if (c.conversation)
      conversations.set(c.conversation, structuredClone(agent.state.messages));
    const last = agent.state.messages.at(-1);
    if (last?.role === "assistant") {
      answer = last.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (last.stopReason === "length") error = "OUTPUT_LIMIT";
    }
  } catch (e) {
    error = String(e);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close();
  }
  const normalized = answer.toLowerCase().replace(/[,]/g, "");
  const catalog = JSON.parse(
    await readFile(
      option("catalog", "../../../lifeor2/lib/mcp/catalog.json"),
      "utf8",
    ),
  ) as { name: string; kind: string }[];
  const writeNames = new Set(
    catalog.filter((t) => t.kind === "mutation").map((t) => t.name),
  );
  const operations = calls
    .filter((c) => c.type === "operation")
    .map((c) => (c.data as { tool?: string })?.tool ?? "");
  const writes = operations.filter(
    (n) =>
      writeNames.has(n) ||
      /^(datasets\.(create|select|prepareSample|populateSampleMonth)|details\.(save|delete|append)|trash\.)/.test(
        n,
      ),
  );
  const usage = traffic.flatMap((e) => {
    const item = e as {
      direction?: string;
      body?: {
        usage?: { input?: number; cacheRead?: number; output?: number };
      };
    };
    return item.direction === "response" && item.body?.usage
      ? [item.body.usage]
      : [];
  });
  const checks = {
    noUnexpectedWrites: c.mode === "write" || writes.length === 0,
    completed: !!answer && !error,
    required: (c.required ?? []).every((s) =>
      normalized.includes(s.toLowerCase()),
    ),
    forbidden: (c.forbidden ?? []).every(
      (s) => !normalized.includes(s.toLowerCase()),
    ),
  };
  const config = modelConfig();
  const result = {
    id: c.id,
    question: c.question,
    expected: c.expected,
    phase: c.phase,
    conversation: c.conversation,
    model: config.model,
    context: config.context,
    outputLimit: config.output,
    thinking: process.env.LLM_THINKING,
    operations,
    writes,
    rendered: renderedAnswer !== undefined,
    peakInputTokens: Math.max(
      0,
      ...usage.map((u) => (u.input ?? 0) + (u.cacheRead ?? 0)),
    ),
    outputTokens: usage.reduce((n, u) => n + (u.output ?? 0), 0),
    inferenceGenerations: usage.filter(
      (u) => (u.input ?? 0) + (u.cacheRead ?? 0) > 0,
    ).length,
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    answer,
    error,
    checks,
    compactions,
    calls,
    traffic,
  };
  await appendFile(output, JSON.stringify(result) + "\n");
  console.log(
    JSON.stringify({
      id: c.id,
      elapsedMs: result.elapsedMs,
      checks,
      error,
      answer,
    }),
  );
}
