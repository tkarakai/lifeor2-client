# Focused life queries

The client now bootstraps compact workspace context and exposes the server's small set of primary domain reads. Whole-word, intent-aware discovery supplies other read/write schemas on demand. Large results retain bounded previews and scoped report handles. The default local model, context window and output budget are unchanged.

Financial, project, forecast and timeline answers use the server's verified report renderer. The client buffers a free-form final draft after a report is retrieved and requires `present_report` instead. The exact server text ends the response without another inference step; inspection records zero inference usage for this rendering. Successful mutations invalidate a previously prepared answer. Qualitative questions still use model prose.

The server implementation and independent arithmetic fixtures live in the sibling LifeOR2 repository under `docs/decisions/life-query-contract.md` and `scripts/evaluation/`. `apps/web/scripts/eval-life-queries.ts` exercises the actual adapter, MCP transport and configured local model against the isolated local endpoint. It records tool operations, latency, token observations, errors and answers in ignored `.eval-results/` files. No private transcripts or connection credentials belong in Git.

Acceptance is in progress. Completion and keyword checks are only smoke checks: each answer must be reviewed for scope, dates, meaning, coverage and unwanted writes, and write claims must match committed records. A finite suite is evidence for its cases, not proof that all possible natural-language questions are supported.
