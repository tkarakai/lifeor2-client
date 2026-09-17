/** Real inference compaction over synthetic history; no business tools or data. */
import { makeAgent } from "../src/lib/lifeor/model";
import { modelConfig } from "../src/lib/lifeor/config";
const settings = modelConfig();
if (!settings.autoCompact)
  throw new Error("Enable LLM_AUTO_COMPACT for this smoke test.");
const marker = `context-${crypto.randomUUID().slice(0, 8)}`;
let compactions = 0;
const filler = "An obsolete search returned no matching records. ".repeat(
  Math.ceil((settings.context * 3 * 0.85) / 48),
);
const system =
  "You are testing context retention with synthetic records. Report only values present in the supplied history. Do not invent data.";
const agent = makeAgent(
  system,
  [],
  [
    { role: "user", content: filler, timestamp: 1 },
    {
      role: "user",
      content: `The important synthetic verification record is reference ${marker}, amount 173 USD. This must be preserved for the next step.`,
      timestamp: 2,
    },
  ],
  {
    compact: async (_before, after) => {
      if (after !== undefined) compactions++;
    },
  },
);
const timer = setTimeout(() => agent.abort(), 120000);
try {
  await agent.prompt(
    "Report the important verification record's reference, amount and currency from earlier history.",
  );
} finally {
  clearTimeout(timer);
}
const snapshot = agent.workingMessages();
if (
  agent.state.errorMessage ||
  !compactions ||
  !JSON.stringify(snapshot).includes(marker)
)
  throw new Error(
    `Compaction smoke failed: ${agent.state.errorMessage ?? "missing record or compaction"}`,
  );
const resumed = makeAgent(system, [], snapshot);
const resumeTimer = setTimeout(() => resumed.abort(), 120000);
try {
  await resumed.prompt(
    "Repeat the verification record's reference, amount and currency.",
  );
} finally {
  clearTimeout(resumeTimer);
}
const last = resumed.state.messages.at(-1);
const answer =
  last?.role === "assistant"
    ? last.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
    : "";
if (
  resumed.state.errorMessage ||
  !answer.includes(marker) ||
  !answer.includes("173") ||
  !answer.includes("USD")
)
  throw new Error(
    "Checkpoint continuation did not retain the synthetic verification record.",
  );
console.log(
  JSON.stringify(
    {
      result: "PASS",
      compactions,
      retainedRecord: true,
      resumedFromCheckpoint: true,
      model: settings.model,
    },
    null,
    2,
  ),
);
