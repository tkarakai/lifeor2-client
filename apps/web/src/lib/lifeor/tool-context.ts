import { randomUUID } from "node:crypto";

type CatalogTool = {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
};
const synonyms: Record<string, string[]> = {
  income: ["salary", "earnings", "earns", "payroll"],
  search: ["find", "lookup"],
  entity: [
    "entities",
    "people",
    "person",
    "family",
    "household",
    "members",
    "contacts",
  ],
  relationships: ["relationship", "roles", "owns", "ownership", "belongs"],
  arrangements: [
    "arrangement",
    "agreements",
    "agreement",
    "contract",
    "project",
  ],
  finances: [
    "financial",
    "finance",
    "money",
    "transactions",
    "spending",
    "spent",
    "expense",
    "expenses",
    "balance",
    "balances",
    "cost",
    "costs",
    "income",
  ],
  timeline: [
    "upcoming",
    "coming",
    "due",
    "overdue",
    "calendar",
    "commitments",
    "bills",
    "payments",
  ],
  history: ["changes", "changed", "revisions", "previous"],
  notes: ["documents", "document", "markdown", "notes"],
};
const stopwords = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "what",
  "whats",
  "s",
  "my",
  "our",
  "this",
  "that",
  "for",
  "of",
  "in",
  "on",
  "to",
  "and",
  "up",
  "me",
  "it",
  "with",
]);
const wordsOf = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\W_]+/)
    .filter((w) => w && !stopwords.has(w));
export function rankTools<T extends CatalogTool>(
  tools: T[],
  query: string,
): T[] {
  const compact = (name: string) =>
    name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const exact = tools.filter((t) => compact(t.name) === compact(query));
  if (exact.length === 1) return exact;
  const words = wordsOf(query);
  const expanded = [
    ...new Set(
      words.flatMap((w) => [
        w,
        ...Object.entries(synonyms)
          .filter(([key, aliases]) => key === w || aliases.includes(w))
          .map(([key]) => key),
      ]),
    ),
  ];
  const writing =
    /\b(create|edit|update|delete|reverse|post|write|remove|archive|restore|save|record|add|append|change|cancel|reschedule|rename|amend|attach)\b/i.test(
      query,
    );
  // Whole words prevent e.g. "up" matching update. Ordinary questions never
  // discover writes; exact operation-name lookup remains available for callers.
  const candidates = tools.filter(
    (t) => writing || t.annotations?.readOnlyHint !== false,
  );
  const normalizeWords = (text: string) =>
    wordsOf(text).flatMap((w) => [
      w,
      ...Object.entries(synonyms)
        .filter(([, aliases]) => aliases.includes(w))
        .map(([key]) => key),
    ]);
  const corpus = candidates.map((t) => ({
    t,
    name: new Set(normalizeWords(t.name)),
    body: new Set(normalizeWords(t.description ?? "")),
  }));
  const frequency = new Map(
    expanded.map((w) => [
      w,
      corpus.filter((d) => d.name.has(w) || d.body.has(w)).length,
    ]),
  );
  return corpus
    .map((d) => ({
      t: d.t,
      score: expanded.reduce((n, w) => {
        const idf = Math.log(1 + corpus.length / (1 + (frequency.get(w) ?? 0)));
        return n + idf * (d.name.has(w) ? 8 : d.body.has(w) ? 1 : 0);
      }, 0),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, 4)
    .map((x) => x.t);
}
export function normalizeResult(result: {
  structuredContent?: unknown;
  content?: unknown;
  isError?: boolean;
}): unknown {
  let value = result.structuredContent;
  if (value === undefined) {
    value = result.content ?? null;
    if (
      Array.isArray(result.content) &&
      result.content.length === 1 &&
      result.content[0]?.type === "text"
    ) {
      const text = result.content[0].text;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
  }
  // Pi marks successful execute() returns as non-errors, so retain MCP failure status in model-visible data.
  return result.isError ? { isError: true, result: value } : value;
}
/** Run-scoped snapshots keep large results out of context without losing access to omitted rows. */
export class ResultPages {
  private values = new Map<string, unknown>();
  private bytes = 0;
  save(value: unknown): string {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) <= 12000) return text;
    const id = randomUUID();
    const size = Buffer.byteLength(text);
    if (size > 8_000_000 || this.bytes + size > 16_000_000)
      return JSON.stringify({
        tooLarge: true,
        bytes: size,
        hint: "Use a narrower server query. No partial result is supplied.",
      });
    this.values.set(id, value);
    this.bytes += size;
    return this.read(id);
  }
  has(id: string) { return this.values.has(id); }
  reportId(id: string): string | undefined {
    const value = this.values.get(id);
    return value && typeof value === "object" && "reportId" in value && typeof value.reportId === "string"
      ? value.reportId : undefined;
  }
  read(id: string, path = "", offset = 0): string {
    if (!this.values.has(id))
      return JSON.stringify({
        error:
          "Result snapshot expired or unknown. Snapshots are available only during this run.",
      });
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error("offset must be a nonnegative integer");
    if (path && !path.startsWith("/"))
      throw new Error("path must be a JSON pointer beginning with / ");
    let value = this.values.get(id);
    for (const key of path
      ? path
          .split("/")
          .slice(1)
          .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
      : []) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
        throw new Error("Unknown JSON pointer path");
      value = (value as Record<string, unknown>)[key];
    }
    if (Buffer.byteLength(JSON.stringify(value)) <= 11000)
      return JSON.stringify({
        resultId: id,
        path,
        data: value,
        complete: true,
      });
    if (Array.isArray(value)) {
      const records: unknown[] = [];
      let next = offset;
      while (next < value.length && records.length < 20) {
        const item = value[next];
        if (Buffer.byteLength(JSON.stringify([...records, item])) > 10000)
          break;
        records.push(item);
        next++;
      }
      if (next === offset && next < value.length)
        return JSON.stringify({
          resultId: id,
          path,
          total: value.length,
          inspectPath: `${path}/${offset}`,
          hint: "This record is large. Inspect its fields using read_result and inspectPath.",
        });
      return JSON.stringify({
        resultId: id,
        path,
        records,
        total: value.length,
        nextOffset: next < value.length ? next : null,
        complete: next >= value.length,
        hint: "Use read_result with resultId, path and nextOffset as offset. This is a partial snapshot, not the full dataset.",
      });
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      const fields: {
        key: string;
        path: string;
        type: string;
        length?: number;
      }[] = [];
      let next = offset;
      while (next < entries.length && fields.length < 20) {
        const [key, val] = entries[next];
        const field = {
          key,
          path: path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"),
          type: Array.isArray(val) ? "array" : typeof val,
          ...(Array.isArray(val) ? { length: val.length } : {}),
        };
        if (Buffer.byteLength(JSON.stringify([...fields, field])) > 10000)
          break;
        fields.push(field);
        next++;
      }
      // Keep the report handle and coverage visible even when detail fields
      // need paging; otherwise the model must discover the handle by trial.
      const metadata: Record<string, unknown> = {};
      for (const [key, val] of entries) {
        if (
          [
            "commit",
            "documentId",
            "availability",
            "revision",
            "reportId",
            "reportType",
            "snapshotAt",
            "metric",
            "from",
            "through",
            "queryComplete",
            "datasetCompleteness",
            "status",
          ].includes(key) &&
          (val === null ||
            ["string", "number", "boolean"].includes(typeof val)) &&
          JSON.stringify(val).length < 250
        )
          metadata[key] = val;
      }
      return JSON.stringify({
        resultId: id,
        path,
        metadata,
        fields,
        totalFields: entries.length,
        nextOffset: next < entries.length ? next : null,
        complete: next >= entries.length,
        ...(next === offset && next < entries.length
          ? {
              tooLarge: true,
              hint: "A field name is too large to inspect. Request a narrower server result.",
            }
          : {
              hint: "Inspect field paths with read_result. Follow nextOffset as offset to list remaining fields.",
            }),
      });
    }
    return JSON.stringify({
      resultId: id,
      path,
      tooLarge: true,
      hint: "This scalar is too large. Request a narrower server result; no incomplete value is supplied.",
    });
  }
}
