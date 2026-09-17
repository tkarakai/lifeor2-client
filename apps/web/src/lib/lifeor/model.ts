import {
  Agent,
  type AgentTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { AppError, modelConfig } from "./config";
export function makeAgent(
  systemPrompt: string,
  tools: AgentTool[],
  messages: AgentMessage[] = [],
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
      supportsUsageInStreaming: false,
    },
  };
  let rounds = 0;
  return new Agent({
    initialState: { systemPrompt, model, tools, messages },
    toolExecution: "sequential",
    streamFn: (_model, context, options) => {
      // Conservative byte budget, including all schemas and results. No automatic context truncation.
      if (
        Buffer.byteLength(JSON.stringify(context)) + c.output * 4 >
        c.context * 3
      )
        throw new AppError("CONTEXT_LIMIT");
      if (++rounds > c.rounds) throw new AppError("TOOL_LIMIT");
      return streamSimple(model, context, {
        ...options,
        apiKey: c.apiKey,
        maxTokens: c.output,
        maxRetryDelayMs: 0,
        maxRetries: 0,
        timeoutMs: c.timeout,
      });
    },
  });
}
