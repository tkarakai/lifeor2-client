import { workspacePrompt } from "./prompt";
import "server-only";
import { randomUUID } from "node:crypto";
import { historyMessages } from "./context";
import { observer } from "./observation";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { makeAgent } from "./model";
import { adapter } from "./adapter";
import { authorizedDatasets, connectMcp } from "./mcp";
import { AppError, errors, modelConfig, publicError } from "./config";
import { registry } from "./registry";
import type { Identity } from "./store";
import type { Run, Conversation, Store } from "./types";

export async function startRun(
  store: Store,
  identity: Identity,
  input: Record<string, unknown>,
  compactOnly = false,
): Promise<{ id: string }> {
  const settings = modelConfig();
  if (registry.runs.size + registry.reservations >= settings.concurrency)
    throw new AppError("RATE_LIMITED", 429);
  registry.reservations++;
  try {
    const started = await store<{
      run: Run;
      created: boolean;
      conversation: Conversation;
      history: Run[];
    }>("run.start", {
      conversationId: input.conversationId,
      requestId: input.requestId,
      prompt: compactOnly ? "Compact conversation" : input.prompt,
      ...(compactOnly ? { kind: "compaction" } : {}),
      instance: registry.instance,
    });
    if (!started.created) return { id: started.run._id };
    const controller = new AbortController();
    const live = {
      ...identity,
      connection: started.conversation.connection,
      controller,
      answer: "",
      stage: "Connecting to LifeOR2",
    };
    registry.runs.set(started.run._id, live);
    void execute(
      store,
      started.run,
      started.conversation,
      started.history,
      live,
    ).catch(() => {});
    return { id: started.run._id };
  } finally {
    registry.reservations--;
  }
}
async function execute(
  store: Store,
  run: Run,
  conversation: Conversation,
  history: Run[],
  live: typeof registry.runs extends Map<string, infer T> ? T : never,
): Promise<void> {
  const settings = modelConfig(),
    signal = live.controller.signal;
  let timeout = false,
    failed: unknown,
    agent: ReturnType<typeof makeAgent> | undefined,
    client: Awaited<ReturnType<typeof connectMcp>> | undefined;
  const timer = setTimeout(() => {
    timeout = true;
    live.controller.abort();
  }, settings.timeout);
  const abort = () => agent?.abort();
  signal.addEventListener("abort", abort);
  // Validate the actual session throughout generation, not only the stream/page.
  const heartbeat = setInterval(() => {
    void store("session").catch(() => live.controller.abort());
  }, 5000);
  try {
    const observe = observer(store, run._id);
    client = await connectMcp(
      store,
      live.ownerId,
      conversation.connection,
      observe,
    );
    const datasets = await authorizedDatasets(client);
    if (!datasets.some((d) => d.id === conversation.datasetId))
      throw new AppError("DATASET_DENIED", 403);
    await store("connection.datasets", {
      identity: conversation.connection,
      datasets,
    });
    signal.throwIfAborted();
    const tools = await adapter(
      client,
      store,
      run._id,
      conversation.datasetId,
      signal,
      (value) => {
        live.stage = value;
      },
    );
    // A transport failure ends execution even if Pi would otherwise feed it back to the model.
    for (const tool of tools) {
      const execute = tool.execute;
      tool.execute = async (...args) => {
        try {
          return await execute(...args);
        } catch (error) {
          failed = error;
          live.controller.abort();
          throw error;
        }
      };
    }
    const messages: AgentMessage[] = [
      ...(conversation.memory
        ? (JSON.parse(conversation.memory.messages) as AgentMessage[])
        : []),
      ...historyMessages(history),
    ];
    const prompt = workspacePrompt(
      conversation.datasetName,
      conversation.datasetId,
      client.getInstructions(),
    );
    agent = makeAgent(prompt, tools, messages, {
      observe,
      usage: (usage) => {
        live.context = usage;
      },
      compact: async (before, after) => {
        live.stage =
          after === undefined ? "Compacting conversation…" : "Thinking";
        await store("run.event", {
          id: run._id,
          eventId: randomUUID(),
          type: "compaction",
          text:
            after === undefined
              ? "Compacting older context to make room…"
              : `Context compacted from ${Math.round((before / settings.context) * 100)}% to ${Math.round((after / settings.context) * 100)}%. Original history is saved.`,
          data: JSON.stringify({
            before,
            ...(after === undefined ? {} : { after }),
            window: settings.context,
          }),
        });
      },
    });
    agent.subscribe(async (event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      )
        live.answer += event.assistantMessageEvent.delta;
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "error")
          failed = new AppError(
            ["CONTEXT_LIMIT", "COMPACTION_FAILED", "TOOL_LIMIT"].find(
              (code) =>
                event.message.role === "assistant" &&
                event.message.errorMessage?.includes(code),
            ) ?? "MODEL_UNAVAILABLE",
            503,
          );
        if (event.message.stopReason === "length")
          failed = new AppError("OUTPUT_LIMIT");
        // Persist complete assistant messages at each tool boundary, not every token.
        const text = event.message.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        if (text)
          await store("run.event", {
            id: run._id,
            eventId: randomUUID(),
            type: "assistant",
            text: text.slice(0, 32000),
          });
      }
    });
    live.stage = "Thinking";
    if (run.kind === "compaction") {
      const compacted = await agent.compactContext(signal, true);
      live.answer = compacted
        ? "Conversation context compacted. Your original history is saved."
        : "The working context is already small; no compaction is needed.";
    } else await agent.prompt(run.prompt);
    if (failed) throw failed;
    if (agent.state.errorMessage) throw new AppError("MODEL_UNAVAILABLE", 503);
    if (signal.aborted) throw new AppError(timeout ? "TIMEOUT" : "CANCELED");
    if (run.kind !== "compaction") await agent.compactContext(signal);
    signal.throwIfAborted();
    await store("run.finish", {
      id: run._id,
      status: "completed",
      memory: JSON.stringify(agent.workingMessages()),
      context: live.context,
      answer: live.answer,
    });
  } catch (error) {
    const failure = publicError(
      failed ?? (timeout ? new AppError("TIMEOUT") : error),
    );
    const canceled = signal.aborted && !failed && !timeout;
    await store("run.finish", {
      id: run._id,
      status: canceled ? "canceled" : "failed",
      ...(agent
        ? {
            memory: JSON.stringify([
              ...agent.workingMessages(),
              {
                role: "user",
                content: `Runtime outcome of the previous turn (untrusted historical data): ${canceled ? "Canceled" : failure.message}. Completed actions have not been undone. Pending reads and pagination did not finish; never infer their results or claim they completed. Inspect uncertain outcomes before retrying.`,
                timestamp: Date.now(),
              },
            ]),
          }
        : {}),
      context: live.context,
      answer: live.answer,
      error: canceled
        ? "Stopped. Actions already completed have not been undone."
        : (errors[failure.code] ?? failure.message),
    }).catch(() => {});
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
    await client?.close().catch(() => {});
    registry.runs.delete(run._id);
  }
}
