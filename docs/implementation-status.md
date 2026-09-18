# Implementation and release checks

Phase-one text functionality is implemented in `apps/web` and the separate client Convex backend. Voice remains the PRD's later milestone. Deployment and live business-data acceptance are not implied by the implementation.

## Implemented

- Retained Better Auth, invitation-only defaults, bootstrap, recovery and account administration. Added loopback-only dev-account/mock-email safeguards.
- Private Convex persistence for grants, OAuth attempts, conversations, runs, messages, tool outcomes and decisions, with explicit ownership checks.
- OAuth discovery, PKCE/state/session/issuer/resource binding, encrypted credentials, serialized rotation and disconnect.
- Dataset-bound conversations, rename/delete, reload recovery, deduplicated sends, run locks, interruption and cancellation.
- Pi agent-core embedding, server-configured OpenAI-compatible inference, grant-specific MCP catalog search and schema-validating execution.
- Persisted write keys, server revision checks, actual MCP v2 form elicitation, single-use user decisions, and bounded failures.
- Responsive workspace, mobile history drawer, light/dark themes, safe Markdown, activity detail, draft preservation and explicit error/recovery states.
- Automatic and manual context compaction with persisted working checkpoints, output headroom, chunked summaries, and one inference-only overflow retry; no turn-count cap.
- Context usage meter and owner-scoped model/compaction/MCP traffic inspection, with redaction, bounded previews, paged history, and batched deletion.
- Normalized/paged tool results, bounded financial read tools in the companion server patch, task-aware summaries, calibrated usage and a real-inference evaluation suite with manual answer/decision review.
- Reproducible local setup, hosted/same-machine guidance, source-contract references, backup/restore and operational constraints.

Validation run on 2026-09-18: 123 Bun unit/integration tests, 193 Convex tests,
22 component tests, four Chromium product journeys, and seven development-script
tests pass. Real local inference passed the MCP round-trip smoke and a synthetic
history compaction/checkpoint-continuation smoke. Workspace
TypeScript checks and the production web build pass. Web lint has zero errors
and ten pre-existing unused-variable warnings in inherited tests. The companion server suite has 205 passing tests and 14 Python lifecycle/export tests. Required CI passed at client `9190d7b` and server `f17e59a`. See [agent evaluation](agent-evaluation.md) for the earlier four-model comparison, and [focused life queries](life-query-acceptance.md) for the subsequent real-model and volume acceptance.

`.github/workflows/ci-lifeor.yml` runs product checks on pull requests and pushes
to `main`, with manual dispatch also available, without production credentials.
It does not deploy the application. See `CONTRIBUTING.md` for merge requirements.

## Acceptance evidence

| PRD criteria | Automated coverage / remaining live check |
| --- | --- |
| AUTH-1 / AUTH-2 | Browser API authentication and Origin checks; private gateway denial; cross-owner history, run and decision checks; retained enrollment tests. |
| CONN-1 | Token encryption/tampering/owner binding, serialized refresh, lost response and crash handling tested. Actual registered-client browser consent/renewal/revocation still requires the operator's LifeOR2 registration. |
| DATA-1 | Actual configured Qwen inference through the production adapter/MCP passed isolated create/edit postconditions: calendar correction, balanced expense, rent revision, identity correction and preserved note append. Bank/card expense reversals were independently checked on a 308,000-journal fixture. Cross-client UI convergence remains a release check. |
| DATA-2 | Exact write-key reuse, dataset rejection, malformed arguments and revision-field preservation tested. Real server conflict and request replay behavior must be checked in a disposable dataset. |
| DATA-3 | Official MCP `input_required` → form elicitation → cancel/accept round trips tested. Persistence rejects changed IDs, other owners, repeats and expired confirmations; browser test covers the confirmation UI. |
| CHAT-1 / CHAT-2 | Persistence tests cover restart interruption, completed outcomes, grant replacement, deduplication and competing starts. Browser fixtures cover conversation context and draft recovery. |
| LLM-1 | Packages are pinned; Pi and MCP v2 load/run under Bun 1.3.9. Four local models were compared with real inference and synthetic MCP fixtures on 2026-09-17. The selected local profile is Qwen3.8-27B-8bit, 32,768 context / 2,048 output tokens, with oMLX thinking disabled. See the evaluation report for results, shared-host latency limitations and remaining model errors; this is not a general intelligence benchmark. |
| LLM-2 | Validated endpoint/limit configuration, bounded run duration/rounds/output, compaction between generations, overflow recovery, per-user/global concurrency, cancellation and no cloud fallback. |
| UX-1 | Chromium desktop and 360px mobile checks, keyboard dialogs, light/dark screenshots and axe checks. A connected-user read journey, context meter and traffic inspector were also checked on desktop and mobile. Additional browser engines and write journeys remain release checks. |
| OPS-1 | Both deployment profiles, private credentials, local bootstrap, retention, restore and upgrade procedures documented. Actual hosted deployment/backup restore is not performed. |

## Before release

1. Register the actual callback in LifeOR2 and complete consent with a real client session.
2. Set the local model API key privately and run `smoke:model`; record inference server version, model revision/quantization, host hardware, and measured latency.
3. In a disposable LifeOR2 dataset, read, create, edit with a stale revision, retry an identical write, cancel then confirm permanent deletion, and observe another LifeOR2 UI update.
4. Exercise expired/revoked grants, denied scopes, removed datasets, interrupted refresh and server restart while a write is in flight. Confirm that no write or confirmation is automatically replayed.
5. Run browser checks against the real connected system, including multiple devices, expired client sessions, Safari and Firefox.
6. Validate the production HTTPS/tunnel setup and a backup restore. Configure the documented backup expiry in the actual provider. Enable inherited deployment workflows only when their infrastructure is configured.

Current scope boundaries: one app instance; up to 200 conversations, with no turn-count cap and automatic context compaction; dataset-scoped operations only; new grants require new conversations. The new workspace copy is English; existing localized authentication/account screens are retained. Voice, multi-instance coordination and unscoped dataset creation are not shipped here.
