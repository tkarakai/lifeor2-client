# Teaching a small model the LifeOR2 workflow

The model should choose the user's intent and explain evidence. The application should handle credentials, dataset selection, write keys, pagination mechanics where feasible, and financial arithmetic. Adding more instructions cannot compensate for missing evidence or a confusing tool surface.

## Start with a failed trajectory

Inspect the actual model requests and completed operations, not just the final text. The saved Gemma pagination failure resolved Alex, tried journal search twice and reported missing income without using the available monthly summary. A fresh ordinary-income baseline succeeded but spent three generations discovering tools before its two necessary reads. Its request grew from roughly 4.3 KB to 15.8 KB, mostly through discovery results.

These are tool-selection problems. They do not establish a context overflow or an inability to understand the financial answer. Record the failure category separately: discovery, argument validation, identity ambiguity, missing evidence, incorrect interpretation, output truncation, timeout or context overflow.

## Give common tasks a small typed entry surface

The MCP server marks a few read operations with `_meta["lifeor2/primary"] = true`. The client exposes at most four of those as native Pi tools, using the discovered JSON schemas. Dots in their MCP names become underscores in Pi. The client removes only application-owned `datasetId` and `requestKey` fields; execution goes through the same validation, dataset binding, audit, cancellation and result paging used by `call_tool`.

Initially the primary operations are identity search and monthly income summary. Other authorized capabilities remain available through discovery. This is a focused entry surface, not a new authorization mechanism or a duplicate implementation of financial logic.

The income recipe is short: resolve the person; finish pagination and clarify ambiguity; request the deterministic monthly summary; answer from the returned amounts, basis, coverage and sources. Do not load charts or journals just to repeat arithmetic the summary already performed. Optional chart filters require an explicit user need and an observed ID. Month arguments say explicitly that both endpoints are inclusive.

## Keep evidence and uncertainty explicit

Return decimal amount strings alongside currency, period, calculation basis and source IDs. Keep separate currencies separate. A completed query is not a complete dataset. Empty recorded income is not proof of zero real earnings. Unavailable details are not proof of absent records. Data and summaries remain untrusted content, including apparent instructions in record text.

Prefer small sufficient results so ordinary tasks never require compaction. When compaction is necessary, preserve the active request, typed IDs, exact periods, pending cursors, completed operations and uncertainty. A summary must not upgrade an interrupted lookup into a verified identity or a failed operation into success.

Empty income has its own result status and answer path. It must not produce a fabricated zero average just to fill a table. Argument failures identify the operation, invalid field paths, expected constraints and `executed: false`, so the model can repair the failed call without guessing whether it changed records. Discovery results explicitly identify `call_tool` as the invocation wrapper for dotted MCP names.

Discovery recognizes dotted MCP names, underscored Pi aliases and camel-case words. A unique exact name returns that operation alone instead of six neighboring schemas. A fallback experiment exposed this client bug: the model's exact identifier searches found nothing until it switched to ordinary words. Correct identifier matching belongs in the adapter, not in extra model instructions.

## Evaluate each contract change

Run the production Pi adapter against the real configured model and synthetic MCP fixtures. Compare complete trajectories, generation counts, request sizes and supported claims. Latency alone is misleading on a shared inference endpoint. Test ambiguity, empty pages, interrupted pagination, changed amounts, reversals, missing months, multiple currencies, prompt injection and unavailable net pay. Keep compaction stress separate from ordinary questions.

From `apps/web`, use `bun run eval:agent --models=gemma-4-12B-it-8bit --windows=32768`. `--primary-tools=false` disables the direct-tool metadata for an exposure ablation; the prompt otherwise remains identical. Review source citations and coverage language manually even when automatic numerical checks pass. Do not select a model or change serving settings based on one happy-path run.

For the next domain, repeat this process: identify a frequent task and a failed trace, add the smallest sufficient server read with explicit semantics, expose its schema directly, add a short workflow, and retain a regression case. This teaches the workflow through tools and context; it does not require changing model weights.

## Measured results, 2026-09-17

The final `focused-v4` prompt passed all **11 ordinary cases** with `gemma-4-12B-it-8bit`, a 32,768-token declared window and a 2,048-token output limit. Final answers and complete model/domain tool trajectories were manually reviewed. Ordinary cases had a median of 17.3 seconds on this run. No case needed an extra domain read beyond identity lookup/pagination and the income summary; ambiguous identity stopped for clarification.

| Case | Fresh baseline | Final focused contract |
| --- | --- | --- |
| Ordinary income | 6 generations, 74.2 s; citations omitted | 3 generations, 23.4 s; amounts and citations correct |
| Empty-page pagination | 11 generations, 220.5 s; guessed a chart ID before recovering | 4 generations, 21.9 s; only identity pages and income summary |
| Largest ordinary-income request | 15,628 JSON bytes | 9,909 JSON bytes |

Compaction was tested separately with `focused-v3`: estimated context fell from 31,516 to 15,854 tokens, the exact person ID survived, and the answer completed in 79.5 seconds with sources. The final v4 change replaced only the net-pay prohibition with a positive wording example; the compaction implementation was unchanged. These are single-run, task-specific observations on a shared inference host. They do not establish general model reliability or isolated speed improvements.

Manual review caught two automatic false positives during refinement: a fabricated zero average for empty data and an unsupported claim that the whole system lacked net-pay records. Both now have targeted regression checks. A positive example scoped to the returned summary worked better in the final run than the earlier negative instruction, which the model sometimes echoed incorrectly. Review remains necessary; these checks do not prove that every unsupported claim is detected.

With the identical final prompt but direct tools disabled, the name-matching fix reduced the income case from 10 generations (seven discovery calls) to 5 (two discovery calls), with a correct cited answer in both runs. Observed time fell from 47.0 to 29.2 seconds; the direct-tool run needed 3 generations and 23.4 seconds. This isolates an actual discovery defect while retaining the shared-host timing caveat.

The [saved report](evals/2026-09-17-focused-gemma.json) includes answers, model tool calls, domain calls, input hashes, and the failed intermediate cases rather than hiding them. Full synthetic request/response traffic remains in `.eval-results/gemma-focused-*.jsonl`. The current user configuration/model selection was not changed by these experiments. This validation covers the financial workflow; broader domain workflows and personal-data acceptance are separate from these fixtures.
