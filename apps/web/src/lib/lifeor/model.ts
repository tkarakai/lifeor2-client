import {
  Agent,
  type AgentTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
  Model,
  Context,
  Message,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { randomUUID } from "node:crypto";
import { AppError, modelConfig } from "./config";
import { WorkingContext, SUMMARY_PROMPT, contextUsage } from "./context";
import type { ContextUsage, Observe } from "./types";

const observedTokenRatios = new Map<string, number>();

export type ModelHooks = {
  observe?: Observe;
  usage?: (usage: ContextUsage) => void;
  compact?: (before: number, after?: number) => Promise<void>;
};
export function isContextOverflow(error: string): boolean {
  return /context[_ ](?:length[_ ]exceeded|window|limit)|maximum context length|prompt (?:is )?too long|exceeds? (?:the )?(?:available |maximum )?(?:context|token)|too many (?:input )?tokens/i.test(
    error,
  );
}
export function makeAgent(
  systemPrompt: string,
  tools: AgentTool[],
  messages: AgentMessage[] = [],
  hooks: ModelHooks = {},
) {
  const c = modelConfig();
  const model: Model<"openai-completions"> = {
    id: c.model,
    name: c.model,
    api: "openai-completions",
    provider: "lifeor-local",
    baseUrl: c.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: c.context,
    maxTokens: c.output,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: process.env.LLM_STREAM_USAGE !== "false",
    },
  };
  const observe = hooks.observe ?? (async () => {});
  function generate(
    context: Context,
    options: SimpleStreamOptions,
    channel: "model" | "compaction",
  ) {
    const exchange = randomUUID();
    return {
      exchange,
      stream: streamSimple(model, context, {
        ...options,
        apiKey: c.apiKey,
        maxRetryDelayMs: 0,
        maxRetries: 0,
        timeoutMs: c.timeout,
        onPayload: async (payload) => {
          const effectivePayload =
            typeof payload === "object" &&
            payload !== null &&
            ["true", "false"].includes(process.env.LLM_THINKING ?? "")
              ? {
                  ...payload,
                  chat_template_kwargs: {
                    enable_thinking: process.env.LLM_THINKING === "true",
                  },
                }
              : payload;
          await observe({
            exchange,
            channel,
            direction: "request",
            label: `${c.model} · ${channel === "compaction" ? "summarize" : "generate"}`,
            body: effectivePayload,
          });
          return effectivePayload;
        },
        onResponse: async (response) => {
          await observe({
            exchange,
            channel,
            direction: "response",
            label: `HTTP ${response.status}`,
            body: { status: response.status },
          });
        },
      }),
    };
  }
  const memory = new WorkingContext(
    c,
    async (text, signal) => {
      const summaryTokens = Math.min(1024, Math.floor(c.context * 0.1));
      const { stream, exchange } = generate(
        {
          systemPrompt: `${SUMMARY_PROMPT} Use at most ${Math.floor(summaryTokens / 2)} words and stay within ${summaryTokens} tokens.`,
          messages: [{ role: "user", content: text, timestamp: Date.now() }],
        },
        { signal, maxTokens: Math.min(1024, Math.floor(c.context * 0.1)) },
        "compaction",
      );
      const result = await stream.result();
      await observe({
        exchange,
        channel: "compaction",
        direction: "response",
        label: "Summary · assembled response",
        body: result,
      });
      if (result.stopReason !== "stop") throw new AppError("COMPACTION_FAILED");
      return result.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    },
    hooks.compact ?? (async () => {}),
  );
  let rounds = 0;
  let lastReportedUsage: ContextUsage | undefined;
  const calibrationKey = `${c.baseUrl}/${c.model}`;
  let tokenRatio = observedTokenRatios.get(calibrationKey) ?? 1;
  function estimatedUsage(context: Context): ContextUsage {
    const usage = contextUsage(context, c);
    const tokens = Math.ceil(usage.tokens * tokenRatio);
    return {
      ...usage,
      tokens,
      percent: Math.round((tokens / c.context) * 100),
    };
  }
  const agent = new Agent({
    initialState: { systemPrompt, model, tools, messages },
    toolExecution: "sequential",
    streamFn: (_model, original, options) => {
      const output = new AssistantMessageEventStream();
      void (async () => {
        try {
          if (++rounds > c.rounds) throw new AppError("TOOL_LIMIT");
          hooks.usage?.(
            estimatedUsage({
              ...original,
              messages: memory.project(original.messages),
            }),
          );
          memory.setTokenRatio(tokenRatio);
          let context = await memory.prepare(original, options?.signal);
          for (let attempt = 0; attempt < 2; attempt++) {
            hooks.usage?.(estimatedUsage(context));
            const { stream, exchange } = generate(
              context,
              { ...options, maxTokens: c.output },
              "model",
            );
            let emittedContent = false;
            let retry = false;
            for await (const event of stream) {
              if (event.type === "error") {
                await observe({
                  exchange,
                  channel: "model",
                  direction: "response",
                  label: "Generation error",
                  body: event.error,
                });
                if (
                  !attempt &&
                  !emittedContent &&
                  isContextOverflow(event.error.errorMessage ?? "") &&
                  c.autoCompact
                ) {
                  context = await memory.prepare(
                    original,
                    options?.signal,
                    true,
                  );
                  retry = true;
                  break;
                }
                if (isContextOverflow(event.error.errorMessage ?? ""))
                  event.error.errorMessage = "CONTEXT_LIMIT";
              }
              if (event.type.endsWith("_delta")) emittedContent = true;
              if (event.type === "done") {
                await observe({
                  exchange,
                  channel: "model",
                  direction: "response",
                  label: "Generation · assembled response",
                  body: event.message,
                });
                // A length-limited tool call must never be dispatched.
                if (event.message.stopReason === "length")
                  event.message.content = event.message.content.filter(
                    (p) => p.type !== "toolCall",
                  );
                const usage = contextUsage(
                  {
                    ...context,
                    messages: [...context.messages, event.message],
                  },
                  c,
                );
                const inputTokens =
                  event.message.usage.input +
                  event.message.usage.cacheRead +
                  event.message.usage.cacheWrite;
                if (inputTokens > 0) {
                  tokenRatio = Math.max(
                    tokenRatio,
                    (inputTokens / contextUsage(context, c).tokens) * 1.1,
                  );
                  observedTokenRatios.set(calibrationKey, tokenRatio);
                }
                const reported =
                  event.message.usage.input +
                  event.message.usage.cacheRead +
                  event.message.usage.cacheWrite +
                  event.message.usage.output;
                lastReportedUsage =
                  reported > 0
                    ? {
                        ...usage,
                        tokens: reported,
                        percent: Math.round((reported / c.context) * 100),
                        estimated: false,
                      }
                    : undefined;
                hooks.usage?.(
                  lastReportedUsage ??
                    estimatedUsage({
                      ...context,
                      messages: [...context.messages, event.message],
                    }),
                );
              }
              output.push(event);
            }
            if (!retry) {
              output.end();
              return;
            }
          }
        } catch (error) {
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: options?.signal?.aborted
              ? ("aborted" as const)
              : ("error" as const),
            errorMessage:
              error instanceof AppError ? error.code : "MODEL_UNAVAILABLE",
            timestamp: Date.now(),
          };
          output.push({
            type: "error",
            reason: message.stopReason,
            error: message,
          });
          output.end(message);
        }
      })();
      return output;
    },
  });
  return Object.assign(agent, {
    workingMessages: () => memory.snapshot(agent.state.messages as Message[]),
    compactContext: async (signal?: AbortSignal, manual = false) => {
      const original = {
        systemPrompt,
        tools,
        messages: agent.state.messages as Message[],
      };
      memory.setTokenRatio(tokenRatio);
      const before = estimatedUsage({
        ...original,
        messages: memory.project(original.messages),
      });
      if (manual && before.percent < 30) {
        hooks.usage?.(before);
        return false;
      }
      const context = await memory.prepare(original, signal, manual);
      const after = estimatedUsage(context);
      hooks.usage?.(
        after.tokens === before.tokens && lastReportedUsage
          ? lastReportedUsage
          : after,
      );
      return after.tokens < before.tokens;
    },
  });
}
