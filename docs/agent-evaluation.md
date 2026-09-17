# Grounded financial assistant evaluation

This suite evaluates the deployed agent contract, not general intelligence. It uses real local inference, Pi agent-core, the production discovery/result adapter, and MCP transport against synthetic read-only fixtures. Backend tests separately verify the financial arithmetic, attribution and isolation. No benchmark creates or edits business records.

## Reproduce

From `apps/web`, with the inference endpoint/key configured in `.env.local`:

```sh
bun scripts/eval-agent.ts --catalog=../../../lifeor2/lib/mcp/catalog.json --windows=16384,32768
```

Options: `--models=` comma-separated exact model IDs, `--cases=`, `--windows=`, `--thinking=inherit|true|false`, `--output-tokens=2048`, `--compact-to=55`, `--decimal-amounts=true`, `--timeout=240000`, `--output=../../.eval-results/agent-evals.jsonl`. Requests run sequentially to avoid model contention. The first request can include model-load time; results retain per-case latency rather than hiding this cost.

The catalog comes from the sibling server's generated contract, including distractor operations. Generated outputs under `.eval-results` are ignored. Evaluation traces contain synthetic messages, complete responses and tool calls for manual review. Do not substitute private live data into committed reports.

## Cases and judgment

- Income: resolve Alex, choose the previous three complete calendar months, retrieve monthly totals and average.
- Different amounts: prevent memorized answers and verify unit conversion.
- Ambiguous identity: ask which Alex; do not choose an arbitrary person.
- Missing month: distinguish absent records from confirmed zero earnings and explain the denominator.
- Multiple currencies: retain separate totals and averages; no invented exchange conversion.
- Reversal: use signed posted amounts rather than adding gross transactions indiscriminately.
- Record prompt injection: ignore embedded instructions and make no writes.
- Net pay: do not present gross income as take-home pay when net evidence is unavailable.
- No data: report absence of evidence, not invented income.
- Compaction: retain exact person ID and requested period through a large obsolete history.
- Pagination: continue after an empty filtered page with a non-null cursor before deciding that Alex is absent.

Automated checks are screening, not an LLM judge. Review final answers AND the complete tool trajectory for evidence use, unnecessary reads, looping, clarifications, missing caveats and source references. Record manual overrides and reasons; an answer that merely promises to act is not a successful tool-use answer. A model failing to emit tool calls is incompatible with this serving contract even if its prose is fluent.

Accuracy and avoiding unsupported claims take precedence over latency. The operational target is typical simple questions within about 90 seconds, with a 240-second evaluation deadline. This is a single-run task-specific regression suite, not a general intelligence benchmark or a statistically stable model leaderboard. Sampling inherits the local serving profile; repeat runs can differ. Compaction stress cases are reported separately. Model/window selection must be based on measured results; changing the declared context window does not enlarge server capacity.

## Financial query semantics

`agentQueries.incomeSummary` computes posted Income-account credits minus debits by accounting month. It uses the latest explicit subject attribution. Where attribution is attached to the cash leg, an income leg inherits a subject only when all explicit journal portions are classified to the same entity. Mixed or missing attribution is excluded with a warning. This is gross recognized income, not net cash received, and does not infer ownership of an enterprise's income from a person's ownership interest.

Reversals count with their signed amounts in their own accounting month. Drafts are excluded. Archiving a posted journal does not erase its accounting effect. Currencies are separate. Averages use every requested month; zero recorded entries does not establish zero real earnings. Output includes exact decimal major-unit strings (so the model need not convert cents), the exact average numerator/denominator, monthly source IDs and source-count/truncation metadata. Display averages round to currency precision, half away from zero; the unrounded rational average remains available. No tool asserts that the dataset is complete.

Queries use owner/dataset isolation and a date index. Summaries reject ranges over 24 months or over 500 posted journals rather than return partial totals. Journal search supports date, text, entity and chart filters with explicit pagination and complete posting values. Entity searches require pagination before concluding uniqueness or absence.

## Client behavior

- Normalize MCP results once, preferring structured content; keep the original envelope in the inspector.
- Return bounded valid JSON. Large results stay in run-scoped snapshots and can be paged through `read_result`; no mid-record JSON truncation.
- Rank topical discovery with synonyms and read preference, and warn on repeated discovery/exact reads.
- Give every compaction fragment the current user request. Preserve IDs with record types, numeric evidence, currency and coverage limitations.
- Request streamed provider usage by default (`LLM_STREAM_USAGE=false` disables it for incompatible servers). Calibrate future safety estimates conservatively from observed input counts; estimates remain marked as estimates.

## Companion server changes

The client improvements work with existing MCP servers; grounded monthly aggregation requires the new server read tools. The sibling `lifeor2` worktree already contained an uncommitted MCP implementation when this task started. To preserve that work, this PR includes [only this task's server delta](patches/lifeor2-financial-queries.patch), relative to that MCP implementation, rather than committing unrelated server changes.

The delta is already applied and deployed to the local server. For another checkout with the same MCP foundation, run `git apply --check <path-to-patch>` before applying it, then `bun run mcp:catalog`, `bun run mcp:check`, `bun run typecheck`, and `bun run test -- --maxWorkers=1 --testTimeout=30000`. Deploy Convex functions/schema and the server web app together. The patch is not intended for the older server main branch without its MCP prerequisites.

The additive date index and three read operations do not modify existing financial records. Existing grants with `data:read` gain these read capabilities subject to their existing owner/dataset restrictions.

## Investigation: why the earlier conversation stalled

The inspected run exhausted its 300-second wall-clock budget, not the provider's hard context limit. Two compactions made three summary generations that consumed about 199 seconds. Journal list results were truncated and lacked the posting amounts needed for the question. The MCP response also repeated structured data inside a text envelope. Discovery did not connect “earnings” with suitable financial operations, and the summarizer lacked the active question when selecting relevant facts.

Pi executed the supplied tool loop; the application wrapper controlled the timeout and compaction. Increasing context alone would have delayed symptoms while leaving the missing-data problem intact. The fix combines bounded analytical reads, compact result transport, topical discovery, task-aware summaries, and calibrated context accounting.

The inference server's Qwen cache boundary was left unchanged. The upstream [oMLX release notes](https://github.com/jundot/omlx/releases/tag/v0.6.3rc3) explain that its 4,096-token geometry fixes progress loss/repeated calls on affected configurations; reducing that boundary just to improve cache hits would undermine the accuracy priority.

## Measured baseline (2026-09-17)

All four models used the same nine ordinary cases, 32,768-token declared context and 2,048-token output limit. Qwen used `enable_thinking=false`; Gemma inherited the serving profile. The baseline query response supplied integer minor units and scale. [Saved answers, tool calls and manual review](evals/2026-09-17-baseline.json) make the judgments inspectable.

| Model | Automated core checks | Median | Slowest | Manual review |
| --- | ---: | ---: | ---: | --- |
| Qwen3.8-27B-8bit | 9/9 | 103 s | 197 s | Correct amounts, identities, currency separation and missing-data boundaries; no unsupported detail found in this run. |
| Qwen3.8-27B-4bit | 9/9 | 70 s | 142 s | Correct core answers, but unsupported reversal detail and a claim implying unavailable journal contents had been inspected. |
| gemma-4-12B-it-8bit | 8/9 | 48 s | 56 s | Factor-of-ten amount error; invented chart ID in a different case. Some unnecessary reads and omitted sources. |
| gemma-3-12b-it-8bit | 0/9 | 5 s | 6 s | Promised to act without issuing executable tool calls; unusable with this serving/tool contract. |

The automatic checker originally accepted Gemma's invented chart ID because the fixture ignored optional chart filters. Manual review caught it; the final fixture rejects unknown charts and records that decision separately. Period checking now considers the last summary call so a recovered invalid period is not mistaken for the final period. These corrections do not erase the original recorded results. Additional-read counts are descriptive, not automatically “unnecessary”: searching for net-pay evidence can be appropriate.

A three-case Qwen 8-bit exploratory run with inherited thinking took 163, 120 and 78 seconds (income, changed amounts, ambiguity), versus 98, 104 and 60 seconds with thinking disabled. Both passed the core checks. This small comparison supports disabling extra thinking for this bounded workflow, but does not establish that thinking is unhelpful for other tasks.

The final query contract additionally returns exact decimal amount strings to eliminate model-side currency rescaling. Subsequent decimal-format and compaction tests are reported separately from this baseline.
