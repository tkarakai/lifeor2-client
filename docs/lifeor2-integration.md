# LifeOR2 integration and operations

This is the phase-one text client. It uses **Pi agent-core 0.85.1**, **pi-ai 0.85.1**, and **MCP TypeScript client 2.0.0**, pinned in `apps/web/package.json` and `bun.lock`. Pi agent-core supplies the agent loop directly; the coding-agent CLI, filesystem tools, skill discovery, extensions, credential discovery, and provider catalogs are not loaded. Only the configured Chat Completions endpoint is used. No telemetry exporter or update checker is initialized.

## Integration reference

The application being connected to is the sibling repository:

```text
/Users/tamas/dev/projects/lifeor2
```

For another checkout, use `../lifeor2` relative to this repository. This is a development reference, **not** a deployment dependency. The client does not import its business implementation or access its Convex database.

Read these files there when changing the integration:

- `docs/decisions/mcp-agent-interface.md`: contract, registration, permissions, deployment.
- `lib/mcp/server.ts`: tools, dataset results, guidance, and permanent-deletion elicitation.
- `lib/mcp/http.ts`: canonical origin, resource audience, error and request handling.
- `lib/mcp/catalog.json`: generated domain schemas. Do not copy these into this client; discover each user's authorized catalog at runtime.
- `convex/agents.ts`: grant behavior and atomic write request keys, for contract verification only.

Verified against that working tree on 2026-09-16: protocol `2026-07-28`, SDK v2, stateless Streamable HTTP, `datasets.list` returning dataset documents with `_id` and `name`, single-use authorization codes, rotating refresh tokens, and form elicitation for deletion. The client explicitly pins protocol negotiation; it does not assume the legacy initialize handshake. Recheck the deployed LifeOR2 version before release.

## Local setup

1. Install Bun (tested with 1.3.9), then run `bun install --frozen-lockfile`.
2. Copy `apps/web/.env.example` to `apps/web/.env.local` if it does not already exist. Preserve any existing secrets.
3. Run `bun run dev:web`. The starter starts a **separate client Convex deployment**, generates local authentication configuration, and runs the web app. The LifeOR2 client bootstrap creates a local encryption key and a shared private gateway key, preserving existing values. It sends the gateway key to the client Convex deployment through stdin. It refuses non-loopback Convex URLs.
4. The client web app uses `http://localhost:3002`. The launcher stops with an error if another server is listening there, keeping the OAuth callback stable. Set `LIFEOR_OAUTH_REDIRECT_URI=http://localhost:3002/api/lifeor/oauth/callback`. The admin app prefers port 3003; use its printed URL. See the [README connection walkthrough](../README.md#connect-to-lifeor2).
5. Start LifeOR2 separately, following that repository's setup instructions. Its usual local origin is `http://localhost:3000`, with MCP at `/mcp`.
6. In LifeOR2, open **Workspace → Agent connections** (`/dashboard/agents`). Register this client with its exact callback URL. Copy the metadata-document client ID into `LIFEOR_OAUTH_CLIENT_ID`. A client ID is public metadata, not a password. Register every local/hosted callback you intend to use; do not use wildcard callbacks.
7. Configure inference on the client server. The supplied development endpoint is `http://127.0.0.1:8000/v1`, model `Qwen3.8-27B-8bit`, with `LLM_THINKING=false` for the evaluated oMLX profile. Put a required provider key in `LLM_API_KEY` in the untracked app environment file. Do not put it in chat, a `NEXT_PUBLIC_*` variable, shell command arguments, or screenshots. Restart the Next.js process after changing secrets.
8. Sign into the **client**, choose **Connect LifeOR2**, complete LifeOR2's login/consent, load authorized datasets, and start a conversation. These accounts are independent; email addresses are never used to link them.

Development seed users are gated by `DEV_SEED_ENABLED=true` **and every client app origin being loopback HTTP**. Mock email has the same origin restriction. Remote deployments without real email fail closed. A fresh startup can skip seeding until its canonical origins have been configured; rerun the internal `devSeed:seed` from `packages/backend` after local startup if needed. Never use development credentials in a production database.

The original starter reference remains in [README.starter.md](../README.starter.md). Landing, demo and Storybook source is retained, but they are not required product services.

## Configuration ownership

| Process | Variables |
| --- | --- |
| Next.js/Bun | `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, `NEXT_PUBLIC_SITE_URL` and inherited auth UI configuration |
| Next.js/Bun only | `LIFEOR_MCP_URL`, `LIFEOR_OAUTH_CLIENT_ID`, `LIFEOR_OAUTH_REDIRECT_URI`, `MCP_TOKEN_ENCRYPTION_KEY`, all `LLM_*` / `AGENT_*` values |
| Next.js and **client** Convex | The same `LIFEOR_STORE_SECRET` (at least 32 random characters) |
| Client Convex | `BETTER_AUTH_SECRET`, `SITE_URL`, `ADMIN_SITE_URL`, `LANDING_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, enrollment/security policies |

Generate a 32-byte base64 encryption key and an independent random gateway secret using a secret manager or cryptographic random generator. The encryption key never goes to Convex. Set Convex secrets interactively, for example `bunx convex env set LIFEOR_STORE_SECRET` from `packages/backend`, supplying the value through stdin; do not paste secrets as CLI arguments.

`LLM_CONTEXT_WINDOW` defaults to 32768; output to 2048 tokens; deployment concurrency to 2; turn duration to 300000 ms; model rounds to 12. Adjust these to the actual model/server capacity. A missing provider key uses the placeholder `local`, solely for compatible servers that require a nonempty SDK key; it does not bypass provider authentication. Configure the endpoint’s real key before expecting chat generation to work. `LLM_THINKING` is optional: `true`/`false` sends `chat_template_kwargs.enable_thinking`; leaving it unset inherits the provider profile. Omit it for servers that do not support that extension.

### Context management and traffic inspection

`LLM_AUTO_COMPACT=true`, `LLM_COMPACT_AT_PERCENT=80`, and `LLM_COMPACT_TO_PERCENT=55` control compaction. The target must be below the trigger. These are server-owned settings, like `LLM_CONTEXT_WINDOW` and `LLM_MAX_OUTPUT_TOKENS`; changing the declared context window does not change inference-server capacity. Restart the web process after configuration changes.

Before every model generation (including tool follow-ups), the runtime checks the entire request, including instructions and schemas. It compacts at the configured threshold or earlier to reserve maximum output plus a 5% safety margin (minimum 256 tokens). It also checks after the final generation. A bounded working-checkpoint budget can trigger compaction earlier for very large context configurations. Counts use a UTF-8 byte estimate calibrated upward from observed provider input counts, not the model's tokenizer; the UI labels estimates with `~`. Provider-reported usage is requested by default and retained after completion when no compaction changes the context. Set `LLM_STREAM_USAGE=false` for servers that reject streamed usage. Calibration is model-specific and lasts for the app process; a cold process has only the fallback estimate. The meter excludes unsent drafts.

Compaction uses the configured model and endpoint, with no tools, to summarize older content in bounded chunks. It preserves the current user request verbatim, trusted system instructions, and intact retained tool-call/result pairs. Summaries preserve goals, constraints, IDs, completed actions, uncertain outcomes, and remaining work; they are untrusted historical data, never confirmation or authorization. The working checkpoint is saved atomically with run completion, including failure outcomes, and reused on subsequent turns. Old assistant event text is not duplicated into model history. Summaries are lossy; original conversation and operation history remains available. After a crash, uncheckpointed runs are reconstructed from saved outcomes without replaying operations.

An explicit provider context-overflow rejection before any generated content triggers at most one compaction/retry of inference within the same run. Tool operations and their write keys are not restarted. A single oversized current request, unsuccessful summary, or second overflow fails with an actionable message. Output truncation is reported separately; incomplete tool calls are never executed and text continuation is not automatic. Compaction shares the run's cancellation signal, timeout, concurrency limit, and authenticated owner. “Compact now” performs a summary-only turn; it makes no business-data writes and skips work when context is already small.

The composer shows context use and a compacting status. Each turn includes compaction notices and an on-demand traffic inspector, filterable by model, compaction, and MCP. It stores model request bodies, assembled model responses (not raw token frames), and MCP request/response bodies with exchange IDs. Transport headers, OAuth exchanges, credentials, and private reasoning are excluded/redacted. Payloads can contain the user's conversation and business records and remain owner-scoped. Inspection is bounded to the first 128 entries per run, with 48000-byte previews explicitly marked; older runs have no captured traffic. Traffic is stored separately from model history and fetched only when the inspector is open.

Schema additions are optional context fields, an optional compaction run kind, a request lookup index, and the `lifeorMemory` / `lifeorTraffic` tables. Deploy client Convex schema/functions with the web change; existing conversations require no migration. Deleting a conversation immediately revokes access and removes its working memory; saved runs and traffic are purged in bounded background batches. These tables are included in client database backups.

Endpoints are operator-owned and accept HTTPS or loopback HTTP. For a protected private-network HTTP service, terminate HTTPS at a trusted proxy or use an SSH tunnel bound to loopback. Redirects are rejected; browser input never chooses a provider or MCP destination.

## Authentication and persistence

Enrollment remains invitation-only by default (`onboardingType=inviteOnly`). Keep that setting for the initial deployment. For a fresh production **client** Convex deployment:

1. Configure canonical HTTPS origins, Better Auth secrets, and real email (`RESEND_API_KEY`, `EMAIL_FROM`).
2. Run internal `bootstrap:initialize {"email":"you@example.com"}` from the Convex dashboard or operator CLI. Use `bootstrap:status` and `bootstrap:rescue` for an expired or incorrect first invitation.
3. Claim the invitation and use the retained admin application to invite users. The starter separates admin and regular app accounts; invite a regular client account for chat. The regular account separately authorizes LifeOR2.

Client authentication uses the `lifeor2-client` cookie prefix, shared by its web/admin apps and distinct from LifeOR2. Cookie scope does not include ports, so this separation is required for localhost OAuth. After upgrading from the default cookie prefix, sign into the client again and begin a fresh connection attempt. Clearing a stale client session never deletes LifeOR2 cookies.

Every `/api/lifeor/*` operation validates a fresh Better Auth session through the client Convex HTTP gateway. Verified email is required for inference access. Cookie mutations require the canonical Origin; streams, history and confirmation access independently check ownership. The gateway has no CORS exposure and additionally requires the private shared key. Credential operations are internal Convex mutations, not public queries/subscriptions. An owner ID from a browser is never forwarded as authority.

The only exception to expired-session rejection is **server-key-authorized finalization of an already owned run**: recording its result/error must still succeed after logout. It cannot start a turn, read credentials, or approve a confirmation. Runtime sessions are checked every five seconds, and every tool request resolves its connection through the authenticated gateway. Sign-out cancels active work but retains the grant. Explicit disconnect revokes the grant before clearing credentials. If revocation cannot be reached, the UI reports failure and retains the credential so disconnect can be retried.

Client tables: `lifeorConnections`, `lifeorOAuth`, `lifeorConversations`, `lifeorRuns`, `lifeorMemory`, `lifeorTraffic`. This is an additive schema change; existing starter records do not need migration. Regenerate the Convex API using `convex dev`/codegen; never hand-edit generated files.

Tokens and PKCE material use AES-256-GCM with the owner identity as authenticated additional data. Refresh is serialized per owner within the single process and guarded by a persisted refresh marker. A crash or lost refresh response requires renewed authorization; the old refresh credential is never replayed. A new grant gets a new connection identity. Existing conversations remain readable but cannot continue with the replacement grant; explicitly start a new conversation in a currently authorized dataset.

## Runtime and safety boundaries

- One active turn per client user (therefore also one per conversation), ten starts per minute, plus the configured global cap. Client control mutations also use the starter's durable mutation quota.
- Send IDs are persisted and checked atomically with the run. The same ID and prompt return the existing run; a changed prompt with that ID fails. Reloading or reopening a stream never sends a prompt.
- History is capped at 200 conversations, with no turn-count limit. The UI loads 30 turns at a time. Model context is compacted automatically; original user messages, answers, and operation records remain in history. Model-facing results contain one normalized data representation. Large results use bounded valid JSON pages via `read_result`, backed by run-scoped snapshots (8 MB per result, 16 MB per run); snapshots expire at run completion. Larger responses require a narrower server query. Persisted audit/traffic previews remain bounded separately.
- Active work lives in one long-running app process. A new process marks prior unfinished work interrupted when history is next read. Orphaned same-process runs are marked interrupted after a short grace period. Completed assistant messages, operations, results and decisions are saved at meaningful boundaries; token text streams without token-level database writes.
- `find_tools` searches the grant-specific catalog with topic synonyms and read preference, returning up to six exact schemas, descriptions and annotations. Repeated discoveries and reads receive explicit no-progress guidance. `read_result` pages saved results without repeating an operation. `call_tool` validates arguments with AJV and supplies the trusted dataset and stable write key. No shell, filesystem, host skills, cloud fallback, arbitrary MCP server, or background task tools exist.
- Only dataset-scoped tools are exposed. Changing the global LifeOR2 UI dataset and creating/preparing a new dataset outside the selected context are deliberately excluded; use LifeOR2 for those operations, then refresh datasets and start a conversation. The optional dataset-management scope permits authorized operations within the selected dataset (such as sample month population).
- Write keys derive from the run, tool and canonical arguments, and are saved **before** dispatch. Identical calls in a run reuse the key. Revision/commit fields are preserved and validated against server schemas. A transport failure stops the turn with an uncertain-outcome record; no automatic write replay occurs after a restart.
- HTTP 429 is retried at most once when its `Retry-After` is at most 30 seconds and the request body can be replayed identically. Other network/write failures are not retried. OAuth refresh is never retried.
- Form elicitation is tied to the exact active operation, arguments, run, owner and expiring confirmation ID. Only the authenticated UI endpoint records a response. The model cannot call that endpoint. Each decision is single-use, persisted, and passed to the official SDK's multi-round-trip machinery. URL-mode elicitation is declined.
- Markdown renders without executable HTML or external images. Unverified links are displayed as text. Internal reasoning is not streamed or saved. Tool records are explicitly treated as untrusted content.

## Hosting profiles

**Same machine:** run LifeOR2, client web, client Convex, and inference on distinct ports. Loopback HTTP is supported for development. The two applications keep separate Convex deployments, authentication secrets and users. Production still needs appropriate secure origins and recovery email.

**Separate hosts:** put the client behind HTTPS and forward streaming responses without buffering. Keep one long-running Bun/Next.js process (not serverless functions with short request lifetimes). The server reaches LifeOR2 and inference through authenticated HTTPS or protected loopback tunnels. For example, an operator can forward a remote inference port with `ssh -N -L 127.0.0.1:8000:127.0.0.1:8000 model-host` and configure the client endpoint to that local listener. A hosted server's `localhost` never means the user's laptop.

Build with `bun run --cwd apps/web build`. Run the built app from `apps/web` using `bun --bun next start --port 3002` (or the operator's chosen port). Set runtime secrets in the service manager; production builds require the public auth/Convex variables. Preserve the exact registered callback, canonical origin, secure cookies, and proxy host. Do not log Authorization headers, cookies, token bodies, or OAuth callback query strings. Next's callback request logger is suppressed; configure the reverse proxy/access logs likewise. Development CI output prints only public app settings.

Multiple agent instances are unsupported: they would require distributed ownership, refresh locking, quota reservations and cancellation routing. Do not enable autoscaling or rolling overlap for this initial implementation.

## Backup, deletion and upgrades

Back up the **client** Convex deployment and the encryption key separately with restricted access. Include authentication state and all four LifeOR2 client tables. A database backup without its original encryption key cannot recover grants. After a restore, force saved grants to reconnect instead of replaying potentially rotated tokens, and mark unfinished runs interrupted; never retry stored write operations automatically. Preserve history and stable operation keys for audit/recovery.

Recommended initial policy: nightly encrypted backups, 30-day rolling expiry, with history retained in the live client until the user deletes it. An operator must actually configure this expiry with the backup provider; this repository does not automatically delete external backups. Conversation deletion removes live run/message/activity records, not LifeOR2 business records. A deleted conversation can remain in backups until they expire. Disconnecting leaves saved history intact.

For upgrades: stop accepting new turns, let current work finish or stop it, back up storage/key, deploy additive schema/functions, build and restart one app instance, verify auth/OAuth/model checks. Encryption-key rotation requires a deliberate decrypt/re-encrypt migration with both keys available; replacing the environment value alone breaks saved grants. Discard and reauthorize grants if an old key is lost or compromised.

## Validation

```sh
bun run --cwd apps/web test
bun run --cwd packages/backend test:convex
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web test:e2e -- qa/e2e/lifeor-workspace.spec.ts --workers=1
bun run --cwd apps/web build
# Reads apps/web/.env.local; uses real configured inference and an isolated
# read-only MCP v2 fixture, never production business data:
bun run --cwd apps/web smoke:model
# Real inference compaction and continuation using synthetic history only:
bun run --cwd apps/web smoke:context
```

The smoke command requires an actual streamed response, a Pi tool call over MCP v2, and a grounded follow-up containing a randomly generated record reference and values. It fails if any step is absent. It is a provider/SDK test, not proof of live LifeOR2 writes. Use a disposable authorized LifeOR2 dataset for the release checks in [implementation-status.md](implementation-status.md).

## Financial analysis and model evaluation

Install the companion LifeOR2 `agentQueries` read APIs and regenerate its MCP catalog. They provide bounded entity/journal searches and attributable monthly gross-income totals with source IDs, currency separation and coverage warnings. Existing grants with `data:read` can use them. See [evaluation and accounting semantics](agent-evaluation.md) for limits, test cases and measured model selection. The client still discovers schemas from the server; it does not embed business schemas or access the business database directly.
