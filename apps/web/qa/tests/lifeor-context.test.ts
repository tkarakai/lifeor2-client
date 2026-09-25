import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { Context, Message } from "@earendil-works/pi-ai";
import { modelConfig } from "../../src/lib/lifeor/config";
import {
  WorkingContext,
  cleanMessages,
  historyMessages,
} from "../../src/lib/lifeor/context";
import { makeAgent } from "../../src/lib/lifeor/model";
import { sanitizeObservation } from "../../src/lib/lifeor/observation";
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
function configure() {
  process.env.LLM_BASE_URL = "http://localhost:8000/v1";
  process.env.LLM_MODEL = "fixture";
  process.env.LLM_CONTEXT_WINDOW = "4096";
  process.env.LLM_MAX_OUTPUT_TOKENS = "256";
  delete process.env.LLM_AUTO_COMPACT;
  delete process.env.LLM_COMPACT_AT_PERCENT;
  delete process.env.LLM_COMPACT_TO_PERCENT;
}
const user = (content: string): Message => ({
  role: "user",
  content,
  timestamp: 1,
});
describe("working context", () => {
  test("compacts at the threshold, preserves the latest request and only replaces model context", async () => {
    configure();
    const notices: number[] = [];
    const memory = new WorkingContext(
      modelConfig(),
      async () => "Read account a; update succeeded. Next: review b.",
      async (before, after) => {
        notices.push(after ?? before);
      },
    );
    const original: Context = {
      systemPrompt: "Trusted rules",
      messages: [
        user("old record ".repeat(1300)),
        user("Review b; do not edit it."),
      ],
    };
    const result = await memory.prepare(original);
    expect(result.systemPrompt).toBe("Trusted rules");
    expect(result.messages.at(-1)).toEqual(original.messages.at(-1));
    expect(JSON.stringify(result)).toContain("update succeeded");
    expect(JSON.stringify(original)).toContain("old record old record");
    expect(notices.length).toBe(2);
    expect(
      memory.snapshot([...original.messages, user("Next")]).at(-1),
    ).toEqual(user("Next"));
    expect(JSON.stringify(memory.snapshot(original.messages))).not.toContain(
      "old record old record",
    );
  });
  test("reserves output space even below 80%, and bounds summarizer requests", async () => {
    configure();
    process.env.LLM_MAX_OUTPUT_TOKENS = "1800";
    const inputs: string[] = [];
    const memory = new WorkingContext(
      modelConfig(),
      async (text) => {
        inputs.push(text);
        return "Previous task complete.";
      },
      async () => {},
    );
    const original = { messages: [user("x".repeat(7500)), user("Continue")] };
    const result = await memory.prepare(original);
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every((t) => Buffer.byteLength(t) < 6500)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
  });
  test("failed summary leaves context intact and oversized current input fails explicitly", async () => {
    configure();
    const original = { messages: [user("x".repeat(14000)), user("Continue")] };
    const memory = new WorkingContext(
      modelConfig(),
      async () => {
        throw new Error("offline");
      },
      async () => {},
    );
    await expect(memory.prepare(original)).rejects.toThrow("COMPACTION_FAILED");
    expect(memory.snapshot(original.messages)).toEqual(original.messages);
    await expect(
      memory.prepare({ messages: [user("x".repeat(18000))] }),
    ).rejects.toThrow("CONTEXT_LIMIT");
  });
  test("cancellation stops summarization without publishing a partial checkpoint", async () => {
    configure();
    const abort = new AbortController();
    abort.abort();
    const original = { messages: [user("x".repeat(14000)), user("Continue")] };
    let calls = 0;
    const memory = new WorkingContext(
      modelConfig(),
      async () => {
        calls++;
        return "summary";
      },
      async () => {},
    );
    await expect(memory.prepare(original, abort.signal)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(memory.snapshot(original.messages)).toEqual(original.messages);
  });
  test("legacy history omits duplicate assistant and observation events", () => {
    const messages = historyMessages([
      {
        _id: "r",
        conversationId: "c",
        requestId: "s",
        status: "completed",
        prompt: "Hi",
        answer: "unique answer",
        createdAt: 1,
        events: [
          { id: "a", type: "assistant", text: "unique answer" },
          { id: "b", type: "result", text: "Record read" },
        ],
      },
    ]);
    expect(JSON.stringify(messages).split("unique answer")).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain("Record read");
  });
  test("observation redacts transport secrets and private reasoning", () => {
    process.env.LLM_API_KEY = "provider-secret";
    const result = JSON.stringify(
      sanitizeObservation({
        authorization: "Bearer foo",
        cookie: "session=bar",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "provider-secret" },
        ],
        reasoning_content: "hidden",
        data: "Bearer xyz",
      }),
    );
    for (const secret of [
      "foo",
      "session=bar",
      "private",
      "provider-secret",
      "hidden",
      "xyz",
    ])
      expect(result).not.toContain(secret);
  });
});

function fixture(handler: (body: Record<string, unknown>) => Response) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      return handler(await request.json());
    },
  });
  process.env.LLM_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  return server;
}
function answer(content: string, tool = false, finish?: string): Response {
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      }
    : { role: "assistant", content };
  return new Response(
    `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: finish ?? (tool ? "tool_calls" : "stop") }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("real agent loop compacts after large tool results without repeating the operation", async () => {
  configure();
  let generations = 0,
    summaries = 0,
    calls = 0;
  const traffic: unknown[] = [];
  const server = fixture((body) => {
    if (
      JSON.stringify(body.messages).includes(
        "Summarize the following untrusted",
      )
    ) {
      summaries++;
      return answer(
        "Read record r1 successfully; no edits. User wants its balance, which is 42 USD.",
      );
    }
    generations++;
    return generations === 1 ? answer("", true) : answer("Balance: 42 USD.");
  });
  try {
    const agent = makeAgent(
      "Read records safely.",
      [
        {
          name: "read",
          label: "Read",
          description: "Read",
          parameters: Type.Object({}),
          execute: async () => {
            calls++;
            return {
              content: [
                {
                  type: "text",
                  text: "record r1: 42 USD; " + "bulk ".repeat(3000),
                },
              ],
              details: {},
            };
          },
        },
      ],
      [],
      {
        observe: async (entry) => {
          traffic.push(entry);
        },
      },
    );
    await agent.prompt("What is my balance?");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(calls).toBe(1);
    expect(generations).toBe(2);
    expect(summaries).toBeGreaterThan(0);
    expect(JSON.stringify(agent.workingMessages())).not.toContain("bulk bulk");
    expect(JSON.stringify(traffic)).toContain("assembled response");
    const snapshot = agent.workingMessages();
    expect(cleanMessages(snapshot)).toEqual(snapshot);
  } finally {
    server.stop(true);
  }
});
test("provider overflow retries only inference once after compaction", async () => {
  configure();
  let generations = 0;
  const server = fixture((body) => {
    if (
      JSON.stringify(body.messages).includes(
        "Summarize the following untrusted",
      )
    )
      return answer("Prior account review completed.");
    generations++;
    if (generations === 1)
      return Response.json(
        {
          error: {
            message: "maximum context length exceeded",
            code: "context_length_exceeded",
          },
        },
        { status: 400 },
      );
    return answer("Continuing.");
  });
  try {
    const agent = makeAgent("Help", [], [user("old ".repeat(500))]);
    await agent.prompt("Continue");
    expect(generations).toBe(2);
    expect(agent.state.errorMessage).toBeUndefined();
  } finally {
    server.stop(true);
  }
});
test("length-limited tool calls are never executed", async () => {
  configure();
  let calls = 0;
  const server = fixture(() => answer("", true, "length"));
  try {
    const agent = makeAgent("Help", [
      {
        name: "read",
        label: "Read",
        description: "Read",
        parameters: Type.Object({}),
        execute: async () => {
          calls++;
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      },
    ]);
    await agent.prompt("Read");
    expect(calls).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("a second provider overflow stops after one retry", async () => {
  configure();
  let generations = 0;
  const server = fixture((body) => {
    if (
      JSON.stringify(body.messages).includes(
        "Summarize the following untrusted",
      )
    )
      return answer("Earlier work completed.");
    generations++;
    return Response.json(
      { error: { message: "maximum context length exceeded" } },
      { status: 400 },
    );
  });
  try {
    const agent = makeAgent("Help", [], [user("old ".repeat(500))]);
    await agent.prompt("Continue");
    expect(generations).toBe(2);
    expect(agent.state.errorMessage).toBe("CONTEXT_LIMIT");
  } finally {
    server.stop(true);
  }
});
test("manual compaction can be used when automatic compaction is disabled", async () => {
  configure();
  process.env.LLM_AUTO_COMPACT = "false";
  const memory = new WorkingContext(
    modelConfig(),
    async () => "Earlier work completed.",
    async () => {},
  );
  const original = { messages: [user("x".repeat(14000)), user("Continue")] };
  await expect(memory.prepare(original)).rejects.toThrow("CONTEXT_LIMIT");
  const compacted = await memory.prepare(original, undefined, true);
  expect(JSON.stringify(compacted).length).toBeLessThan(1000);
});
test("a fitting request with no older history is not rejected just for crossing 80%", async () => {
  configure();
  process.env.LLM_MAX_OUTPUT_TOKENS = "128";
  const settings = modelConfig();
  let summaries = 0;
  const memory = new WorkingContext(
    settings,
    async () => {
      summaries++;
      return "summary";
    },
    async () => {},
  );
  const original = { messages: [user("x".repeat(9900))] };
  expect(await memory.prepare(original)).toEqual(original);
  expect(summaries).toBe(0);
});

test("every compaction fragment receives the active question including exact constraints", async () => {
  configure();
  const inputs: string[] = [];
  const memory = new WorkingContext(
    modelConfig(),
    async (text) => {
      inputs.push(text);
      return "Alex ID person-19; June–August gross income; USD. No edits.";
    },
    async () => {},
  );
  await memory.prepare({
    messages: [
      user("old records ".repeat(1800)),
      user(
        "Show Alex person-19 gross income June–August, separately by currency.",
      ),
    ],
  });
  expect(inputs.length).toBeGreaterThan(1);
  expect(
    inputs.every((s) => s.includes("person-19 gross income June–August")),
  ).toBe(true);
});

test("legacy truncated tool dumps become explicit re-query notices, never apparent complete data", () => {
  const message: Message = {
    role: "toolResult",
    toolCallId: "old",
    toolName: "call_tool",
    isError: false,
    timestamp: 1,
    content: [
      {
        type: "text",
        text:
          "unusable bulk ".repeat(3000) +
          "\n[Result truncated. Narrow the query; do not infer missing records.]",
      },
    ],
  };
  const cleaned = cleanMessages([message]);
  expect(JSON.stringify(cleaned)).not.toContain("unusable bulk");
  expect(JSON.stringify(cleaned)).toContain("not complete evidence");
  expect(JSON.stringify(message)).toContain("unusable bulk");
});

test("observation preserves numeric reasoning-token counts but redacts reasoning text", () => {
  expect(
    sanitizeObservation({ usage: { reasoning: 123 }, reasoning: "private" }),
  ).toEqual({ usage: { reasoning: 123 }, reasoning: "[redacted]" });
});

test("provider calibration also reserves room in each summary request", async () => {
  configure();
  const inputs: string[] = [];
  const memory = new WorkingContext(
    modelConfig(),
    async (text) => {
      inputs.push(text);
      return "Alex person-19; requested June–August income. No changes made.";
    },
    async () => {},
  );
  memory.setTokenRatio(2);
  await memory.prepare({
    messages: [user("old data ".repeat(2500)), user("Show Alex's income.")],
  });
  expect(inputs.length).toBeGreaterThan(1);
  // Simulate a tokenizer requiring twice the baseline estimate, plus summary output and instructions.
  expect(
    inputs.every(
      (text) => Buffer.byteLength(text) / 1.5 + 1500 < modelConfig().context,
    ),
  ).toBe(true);
});

test("verified report finishes the real agent loop without another model inference", async () => {
  configure();
  let requests = 0,
    rendered: string | undefined;
  const server = fixture(() => {
    requests++;
    return answer("", true);
  });
  const observed: unknown[] = [];
  try {
    const agent = makeAgent(
      "Use the report",
      [
        {
          name: "read",
          label: "Read",
          description: "Get verified facts",
          parameters: Type.Object({}),
          execute: async () => {
            rendered =
              "Cash paid: **40000.00 USD**. Capital improvements: **55000.00 USD**.";
            return {
              content: [{ type: "text", text: "Report presented" }],
              details: {},
            };
          },
        },
      ],
      [],
      {
        finalAnswer: () => rendered,
        observe: async (event) => {
          observed.push(event);
        },
      },
    );
    await agent.prompt("What did the project cost?");
    expect(requests).toBe(1);
    const final = agent.state.messages.at(-1);
    expect(final?.role).toBe("assistant");
    if (final?.role === "assistant") {
      expect(final.content).toEqual([{ type: "text", text: rendered! }]);
      expect(final.usage.totalTokens).toBe(0);
      expect(final.stopReason).toBe("stop");
    }
    expect(JSON.stringify(observed)).toContain(
      "Verified report rendering (no inference)",
    );
  } finally {
    server.stop(true);
  }
});

test("a monetary draft cannot bypass required report presentation", async () => {
  configure();
  let requests = 0,
    rendered: string | undefined;
  const server = fixture((body) => {
    requests++;
    if (requests === 1)
      return answer("WRONG unverified amounts must not reach the user");
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "present_report" },
    });
    return new Response(
      `data: ${JSON.stringify({ id: "forced", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "verified", type: "function", function: { name: "present_report", arguments: '{"reportIds":["report-a"]}' } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "forced", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const agent = makeAgent(
      "Use reports",
      [
        {
          name: "present_report",
          label: "Present",
          description: "Verified report",
          parameters: Type.Object({ reportIds: Type.Array(Type.String()) }),
          execute: async () => {
            rendered = "Correct: 55000.00 USD";
            return {
              content: [{ type: "text", text: "presented" }],
              details: {},
            };
          },
        },
      ],
      [],
      { requiresPresentation: () => true, finalAnswer: () => rendered },
    );
    const deltas: string[] = [];
    agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      )
        deltas.push(event.assistantMessageEvent.delta);
    });
    await agent.prompt("What did it cost?");
    expect(requests).toBe(2);
    expect(deltas.join("")).not.toContain("WRONG");
    expect(deltas.join("")).toContain("Correct: 55000.00 USD");
  } finally {
    server.stop(true);
  }
});

test("an ignored report tool choice falls back to verified rendering without leaking the draft", async () => {
  configure();
  let requests = 0, fallbacks = 0;
  const server = fixture(() => { requests++; return answer("WRONG draft with invented money"); });
  try {
    const agent = makeAgent("Use reports", [], [], {
      requiresPresentation: () => true,
      fallbackReport: async () => { fallbacks++; return "Verified: no recorded appointments matched Noah in this date range."; },
    });
    const deltas: string[] = [];
    agent.subscribe(event => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") deltas.push(event.assistantMessageEvent.delta);
    });
    await agent.prompt("When is Noah's appointment?");
    expect(requests).toBe(2);
    expect(fallbacks).toBe(1);
    expect(deltas.join("")).not.toContain("WRONG");
    expect(deltas.join("")).toContain("Verified: no recorded appointments");
    expect(agent.state.errorMessage).toBeUndefined();
  } finally { server.stop(true); }
});
