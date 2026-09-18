import { expect, test } from "bun:test";
import {
  normalizeResult,
  rankTools,
  ResultPages,
} from "../../src/lib/lifeor/tool-context";
test("structured MCP data is supplied once without transport wrappers", () => {
  const data = [{ id: "a", minorUnits: 123 }];
  expect(
    normalizeResult({
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    }),
  ).toEqual(data);
  expect(
    normalizeResult({
      content: [{ type: "text", text: JSON.stringify(data) }],
    }),
  ).toEqual(data);
});
test("large result pages remain valid JSON and recover all records without repeating an operation", () => {
  const pages = new ResultPages();
  const data = Array.from({ length: 100 }, (_, i) => ({
    id: i,
    text: "detail ".repeat(100),
  }));
  let page = JSON.parse(pages.save(data));
  const recovered = [...page.records];
  while (page.nextOffset !== null) {
    page = JSON.parse(pages.read(page.resultId, "", page.nextOffset));
    recovered.push(...page.records);
  }
  expect(recovered).toEqual(data);
});
test("large nested objects expose JSON pointers without misleading partial strings", () => {
  const pages = new ResultPages();
  const p = JSON.parse(
    pages.save({ "a/b": { exact: 19, text: "x".repeat(15000) } }),
  );
  expect(p.fields[0].path).toBe("/a~1b");
  expect(JSON.parse(pages.read(p.resultId, "/a~1b/exact")).data).toBe(19);
  expect(JSON.parse(pages.read(p.resultId, "/a~1b/text")).tooLarge).toBe(true);
});
test("earnings and people discovery prioritize relevant read operations", () => {
  const tools = [
    {
      name: "finance.createJournal",
      description: "Create income",
      annotations: { readOnlyHint: false },
    },
    {
      name: "agentQueries.incomeSummary",
      description: "Monthly income totals",
      annotations: { readOnlyHint: true },
    },
    {
      name: "entities.search",
      description: "Find entities",
      annotations: { readOnlyHint: true },
    },
  ];
  expect(rankTools(tools, "earnings")[0].name).toBe(
    "agentQueries.incomeSummary",
  );
  expect(rankTools(tools, "family members")[0].name).toBe("entities.search");
  for (const query of [
    "agentQueries.incomeSummary",
    "agentQueries_incomeSummary",
    "agent_queries_income_summary",
  ]) {
    expect(rankTools(tools, query).map((t) => t.name)).toEqual([
      "agentQueries.incomeSummary",
    ]);
  }
});

test("normalization retains MCP failure status in model-visible data", () => {
  expect(
    normalizeResult({ isError: true, structuredContent: "Access denied" }),
  ).toEqual({ isError: true, result: "Access denied" });
});

test("wide object field indexes are bounded and pageable", () => {
  const pages = new ResultPages();
  const value = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [`field${i}`, "x".repeat(20)]),
  );
  let text = pages.save(value),
    page = JSON.parse(text);
  const fields = [...page.fields];
  while (page.nextOffset !== null) {
    expect(Buffer.byteLength(text)).toBeLessThan(12000);
    text = pages.read(page.resultId, "", page.nextOffset);
    page = JSON.parse(text);
    fields.push(...page.fields);
  }
  expect(fields.map((f: { key: string }) => f.key)).toEqual(Object.keys(value));
});
