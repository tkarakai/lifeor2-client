# LifeOR2 Client — Product Requirements

Status: Phase-one text implementation available; live integration and release validation pending. See [implementation status](implementation-status.md) and [setup/operations](lifeor2-integration.md).

Date: 2026-09-16

Repository: [tkarakai/lifeor2-client](https://github.com/tkarakai/lifeor2-client)

Foundation: [tkarakai/web-app-starter](https://github.com/tkarakai/web-app-starter), commit `e52e8922c5b1865551e00ab6902b9415c128f0c3`.

## 1. Product intent

Build an independent, authenticated web application for working with LifeOR2 data through conversation. Users sign into this client, connect their LifeOR2 account, select an authorized dataset, and ask an agent to read or manage their records. Pi supplies the agent runtime; the LifeOR2 MCP server remains the authority for business data, permissions, validation, and changes.

The product should feel like a professional workspace: calm, precise, responsive, and easy to understand. Users should always know which dataset they are working in, whether an operation succeeded, and when their input is required.

Phase one delivers text chat. Phase two adds dictation and spoken responses using locally hosted models. Both phases remain web applications.

## 2. Confirmed decisions and proposed defaults

| Area | Decision | Status |
| --- | --- | --- |
| Project | Separate repository and sibling directory named `lifeor2-client` | Confirmed |
| Foundation | Use `tkarakai/web-app-starter` | Confirmed |
| Language/tooling | TypeScript and Bun | Confirmed |
| Client access | Own authentication to protect inference resources | Confirmed |
| Data access | Independent OAuth connection to the LifeOR2 MCP server | Confirmed |
| Agent | Pi embedded on the client application's server | Confirmed direction |
| Inference | Server-configured OpenAI-compatible API, expected to be local (e.g. llama.cpp or Ollama) | Confirmed |
| Voice | Local model services in phase two, with deployment instructions at that time | Confirmed |
| Hosting | Client may run beside LifeOR2 or on a separate internet host | Confirmed |
| Visual direction | Professional, clean, restrained interface | Confirmed |
| Enrollment | Invitation-only initially; preserve starter account administration | Proposed default |
| MCP connections | One configured LifeOR2 server per deployment, one active grant per client user | Proposed default |
| Inference selection | One operator-configured model initially; no end-user provider/key settings | Proposed default |
| History | Persist per client user and synchronize across that user's devices | Proposed default |
| Repository visibility | Private initially | Setup default |

Proposed defaults make the first implementation concrete and can change during review. An exact inference model, hardware profile, and voice stack are not selected by this PRD.

## 3. Users and core journeys

The initial audience is the owner and a small set of invited users. Each user has an independent client account and separately authorizes their own LifeOR2 connection. Client and LifeOR2 accounts need not share an email address; never link them implicitly by email.

1. **First use:** Sign in to the client → connect LifeOR2 → complete LifeOR2 login and consent → select an authorized dataset → start chatting.
2. **Ask a question:** Ask about records or finances → see concise progress → receive an answer grounded in tool results, with relevant record references.
3. **Make a change:** Describe the desired change → clarify ambiguous targets → execute through MCP → see what changed and any partial failures.
4. **Confirm permanent deletion:** Review the exact target and effect in a confirmation card → explicitly confirm or cancel → receive the actual server result.
5. **Return later:** Sign into the same client account on another device → reopen owned conversations → reconnect LifeOR2 if consent has expired or been revoked.
6. **Recover:** If inference, authorization, or MCP fails, retain the draft and completed work, explain the problem, and offer a relevant recovery action.

## 4. Phase-one requirements

### 4.1 Client authentication and resource access

- Reuse the starter's Better Auth and Convex integration, account recovery, session handling, and administration where applicable. Inventory working starter behavior before changing it; inherited plans are not proof that every feature is implemented.
- Require a validated client session for inference, chat streams, history, cancellation, confirmations, MCP connection management, and future voice endpoints. Protect API operations independently of page redirects.
- Enforce ownership in the backend for conversations, messages, runs, connections, and confirmation responses. A client-supplied user ID or resource ID is never authority.
- Default to invitation-only enrollment so public registration cannot bypass the intended inference access restriction. Provide a documented first-admin bootstrap and user-invitation path.
- Preserve appropriate origin/CSRF protection for cookie-authenticated mutations, secure production cookies, logout, and session invalidation.
- Apply per-user request and concurrent-run limits plus a deployment-wide inference concurrency cap. Queue or reject excess work with a clear message; bound turn duration, tool rounds, input size, and output tokens.
- Client sign-out removes browser access but does not automatically revoke the user's saved LifeOR2 grant. Provide an explicit disconnect action that revokes the grant and removes stored tokens.
- Development seed accounts and mock email must never silently become production access paths.

### 4.2 LifeOR2 connection

- Provide a clear connection screen showing the configured server, connection status, authorized permissions, and authorized datasets.
- Initiate OAuth from an authenticated client session. Bind the authorization attempt to that user and session; validate PKCE, state, expected issuer, exact callback URI, and resource audience.
- Register local and hosted callback URLs with LifeOR2. Keep OAuth exchange, refresh, revocation, and token storage on the backend. Never place credentials in model context, browser storage, chat messages, or logs.
- Request `data:read` and `data:write` initially. Offer explicit opt-in for `finance:write`, `data:delete`, and `datasets:manage`; describe these in everyday language. Changing permissions may require renewed consent.
- Encrypt recoverable MCP tokens at rest with a server-held key, and exclude them from public Convex functions and subscriptions. Token hashes alone are insufficient because this client must present tokens to LifeOR2.
- Serialize refresh per connection and atomically replace both tokens. Do not replay a refresh whose response was lost; request fresh authorization. The existing server treats refresh-token reuse as connection compromise and revokes that connection.
- Treat authentication expiry, consent denial, revocation, insufficient scope, unavailable datasets, and network failures as distinct states with appropriate recovery paths.
- Never share credential state or grant-filtered tool catalogs between users. Disconnecting or replacing a connection must invalidate its active runtime and cached tools.

### 4.3 Conversations and dataset context

- Create, list, rename, reopen, and delete conversations. Persist messages, tool outcomes, interrupted-run status, and user decisions under the client account.
- Bind each conversation to a connection identity and one explicit dataset. Keep the dataset visible in the chat header. Changing dataset starts a new conversation to prevent accidental reuse of another dataset's context.
- Do not silently attach an old conversation to a newly authorized LifeOR2 account or dataset. Require an explicit, validated choice when reconnecting; disable continuation when the original target is no longer authorized.
- Allow one active agent turn per conversation. Protect against duplicate sends and competing browser tabs. Refreshing the page must not execute the last prompt again.
- Recover completed messages after page reload. A server restart marks unfinished runs interrupted; it must not automatically replay writes or confirmations.
- Historical messages may contain data previously authorized through LifeOR2. Explain that disconnecting stops further access but does not erase saved conversations. Allow users to delete those conversations; document backup retention separately.

### 4.4 Pi runtime and local inference

- Embed Pi through its SDK with an application-specific system prompt, isolated session state, and an explicit tool allowlist. Disable default coding/filesystem/shell tools and automatic discovery of host skills, extensions, and instruction files.
- Implement an MCP-to-Pi tool adapter. Preserve schemas, descriptions, server guidance, structured results, error semantics, cancellation where supported, and user-input requests.
- Use operator-controlled configuration for inference base URL, model ID, optional API key, context limit, output limit, timeouts, and concurrency. These settings are server-side and cannot be overridden by chat text or browser requests.
- Start with the OpenAI-compatible Chat Completions interface through Pi's provider support. Pin and verify the chosen Pi package version and its Bun runtime compatibility during the first integration milestone.
- Validate actual streaming and tool calling against the selected model and server. An endpoint accepting chat messages is insufficient: it must complete a tool call, receive its result, and produce a grounded response.
- Handle malformed tool arguments, unsupported tool schemas, truncated output, context overflow, and unavailable models without reporting unexecuted changes as successful.
- Keep tool context manageable for local models. Discover the grant's catalog, then expose a relevant subset or a documented tool-discovery mechanism. Measure against the full catalog; do not assume all 110 tools fit or work reliably in every model's context.
- Do not fall back to a cloud inference provider automatically. Configuration failures remain visible. Disable optional outbound runtime telemetry/update checks where supported for the documented local deployment profile.
- Keep the model grounded in tool results. Treat stored records and Markdown as untrusted content, not instructions. Derive connection, user ownership, and allowed dataset boundaries from trusted application state.

### 4.5 Safe data operations and human input

- All business reads and writes go through MCP. Do not read the LifeOR2 database directly, copy its backend implementation, or bypass its validation.
- Use the existing server's MCP protocol `2026-07-28` and TypeScript client SDK v2 contract initially. Pin compatible versions and verify negotiation rather than assuming a generic MCP extension works.
- Read current revisions before edits. Preserve `expectedRevision` and Markdown `expectedCommit`; surface conflicts and reread before proposing an updated change.
- Generate and persist write request keys in the adapter. Reuse a key only for the same logical operation with identical dataset and arguments. A network retry must not generate a new write identity.
- Render MCP elicitation as a user-facing confirmation bound to the exact operation and arguments. The model cannot confirm on the user's behalf. Expired or changed requests require a new confirmation.
- Ordinary requested edits may execute without repeated permission dialogs. Permanent deletion requires the server's explicit confirmation. Clarify ambiguous identities, amounts, currencies, dates, or consequential intent before writing.
- Show completed actions and partial failures accurately. A multi-tool request is not a single atomic transaction. Stopping a run cannot undo writes that have already committed.
- Respect server rate limits and `Retry-After`; use bounded retries. Do not claim realtime MCP subscriptions, background tasks, or transaction rollback that the current server does not provide.

### 4.6 Chat experience and visual design

- **Layout:** restrained conversation sidebar, spacious central conversation column, compact header with dataset and connection state, and a persistent composer. On mobile, move history into a drawer.
- **Visual system:** neutral surfaces, one muted accent, legible typography, consistent spacing, subtle dividers, and limited elevation. Reuse accessible starter primitives while replacing demo styling and content.
- **Message rendering:** readable paragraphs, lists, safe Markdown, tables, and copy actions. Sanitize model/tool content; no executable HTML. Use record links only when a verified destination can be constructed.
- **Activity:** display concise stages such as “Reading records” and “Updating arrangement.” Put individual tool details in a collapsible area. Do not expose raw credentials, internal reasoning, or infrastructure settings in chat.
- **Composer:** multiline entry, send, stop, keyboard behavior with composition/IME support, disabled/busy states, and draft preservation on recoverable failure. Reserve space for phase-two recording without showing nonfunctional controls.
- **Confirmation card:** plain-language action, named target, dataset, meaningful consequences, and explicit confirm/cancel buttons. Support keyboard focus and screen readers.
- **States:** designed loading, empty, disconnected, denied, reconnect-required, model-unavailable, conflict, rate-limited, canceled, and interrupted views. Never leave an indefinite spinner after failure.
- **Accessibility:** target WCAG 2.2 AA, visible focus, contrast, reduced motion, labeled controls, and usable layouts at 360 px mobile width and desktop. Streaming announcements must not overwhelm screen readers.
- **Theme:** light and dark using starter theme primitives; maintain the same hierarchy and contrast in both. No decorative dashboard metrics, excessive gradients, or animated backgrounds.

## 5. Architecture and deployment

```text
Browser
  ├── Client login and account session
  ├── Conversation UI and authenticated response stream
  └── Explicit confirmation responses
            │
Client application server — TypeScript / Bun / Next.js
  ├── Session validation, ownership, quotas
  ├── Pi runtime and per-conversation execution
  ├── MCP adapter and OAuth credential lifecycle ──→ LifeOR2 /mcp
  └── Server-configured inference client ─────────→ Local model service
            │
Separate client Convex deployment
  └── Client accounts, conversations, run state, encrypted grants
```

Reuse `apps/web`, the starter's shared auth/backend/UI packages, and the minimal admin surface needed for enrollment. Landing, demo, and Storybook apps are not required product deployments. Preserve their source initially; decide pruning during implementation. The client uses its own Convex deployment and never shares LifeOR2 auth tables or database credentials.

The initial target is a single long-running application instance with authenticated HTTP streaming (SSE or a streamed fetch response). Run the Pi agent in the server process if the Bun/Next.js compatibility spike passes. A private Bun agent service is the fallback if runtime isolation is required; it must preserve the same session and ownership boundary. Do not put a long-running Pi process inside a Convex function.

Persist final messages and meaningful run transitions; stream token deltas without writing every token to the database. Maintain a stable run ID so browser reconnection can retrieve durable state without starting another run. Session expiry or explicit logout cancels further work where possible; completed writes remain recorded.

Support two deployment profiles:

1. **Same machine:** client, LifeOR2, local model, and optionally local client Convex run on separate documented ports. Loopback HTTP is supported for development.
2. **Separate hosts:** browser reaches the client via HTTPS; the client server reaches LifeOR2 and inference through explicitly configured, authenticated HTTPS or a protected private network. A cloud client cannot reach a laptop's `localhost`; document a private-network/tunnel arrangement when needed.

The browser does not connect directly to inference or receive MCP/provider credentials. Configure provider and MCP destinations as operator-owned endpoints, not arbitrary user-entered URLs. Production setup must establish its own canonical URLs, callback registration, secrets, account enrollment, and email delivery/recovery configuration.

Document durable storage, encryption-key backup, restore, and deployment upgrades. Scaling to multiple agent instances is deferred; it would require coordinated run ownership, refresh serialization, and cancellation routing.

### Proposed configuration contract

These settings are implemented for phase one. See the integration guide for process ownership, the private gateway secret, and validated bounds.

| Setting | Purpose |
| --- | --- |
| `LIFEOR_MCP_URL` | Canonical MCP resource URL |
| `LIFEOR_OAUTH_CLIENT_ID` | Registered LifeOR2 client metadata URL |
| `LIFEOR_OAUTH_REDIRECT_URI` | Exact client callback URL |
| `LLM_BASE_URL` | Inference API base, including its configured API prefix |
| `LLM_MODEL` | Model identifier served by the provider |
| `LLM_API_KEY` | Optional server-only credential; adapter handles providers requiring a placeholder |
| `LLM_CONTEXT_WINDOW` / `LLM_MAX_OUTPUT_TOKENS` | Validated model context and output limits |
| `LLM_MAX_CONCURRENT_RUNS` / `AGENT_MAX_TOOL_ROUNDS` / `AGENT_TIMEOUT_MS` | Resource limits |
| `MCP_TOKEN_ENCRYPTION_KEY` | Server-only key for recoverable grant storage |

## 6. Phase two: local voice

Voice is a separate milestone after reliable text and tool execution. No full duplex, wake word, continuous listening, voice cloning, or autonomous voice-triggered writes.

- **Dictation:** press to record → stop → local transcription → editable composer text → explicit send. Display recording duration, permission errors, processing, retry, and cancel states.
- **Speech output:** explicit “Read aloud” on assistant replies, stop playback, and an optional user preference for automatic reading after a completed answer. Speak user-facing answers, not tool logs or hidden reasoning.
- **Services:** separate server-configured speech-to-text and text-to-speech adapters pointing to local models. Do not assume the inference server also supports audio or that every service uses the same API contract.
- **Privacy:** send audio only to configured services; do not persist recordings by default. Specify cleanup for temporary input/output audio, size/duration limits, and retention before shipping.
- **Authentication:** apply the same client session, ownership, and resource limits to recording upload, transcription, synthesis, and audio download.
- **Browser support:** require microphone consent and HTTPS for remote use, allow supported loopback development, and verify current Safari, Chrome, and Firefox recording/playback formats. Provide text fallback when permission or playback fails.
- **Local setup guide at that milestone:** include tested model/runtime versions, licenses, supported languages, RAM/VRAM and CPU/GPU requirements, installation and model download commands, service ports, configuration examples, container/network notes, sample transcription and synthesis checks, latency expectations, and troubleshooting. Select models against actual target hardware then.

## 7. Phase-one acceptance criteria

| ID | Observable result |
| --- | --- |
| AUTH-1 | Anonymous, expired, and invalid sessions cannot call inference, inspect history, submit confirmations, or use another user's connection—even through direct API calls. |
| AUTH-2 | Two independent users cannot read, stream, cancel, or change each other's conversations/runs; invitation-only enrollment and production bootstrap are verified. |
| MCP-1 | Real browser authorization succeeds for a registered local callback and a separate-host deployment; cancellation and invalid state/issuer are rejected cleanly. |
| MCP-2 | Refresh, revocation, expiry, simultaneous refresh attempts, and a lost refresh response recover without replaying a rotated refresh token. |
| DATA-1 | Through a real authorized MCP connection, the agent reads records, creates a record, edits it with revision checks, and reports actual results. Existing LifeOR2 UI reflects those changes. |
| DATA-2 | A retried write creates only one operation; stale revisions show a conflict; unauthorized datasets and scopes are rejected. |
| DATA-3 | Permanent deletion pauses for actual user confirmation. Cancel, changed arguments, another user's response, and stale confirmation cannot approve it. |
| CHAT-1 | Conversations survive reload and server restart, remain available to the same client account across devices, and do not silently rebind to a different LifeOR2 account. |
| CHAT-2 | Duplicate sends and reconnects do not duplicate execution; interruption and partial writes are visible; stop does not imply rollback. |
| LLM-1 | A documented, pinned Pi/model/server combination completes streamed text and a multi-step MCP tool round trip through the configured OpenAI-compatible endpoint. |
| LLM-2 | Quotas, malformed tool calls, context limits, and unavailable inference have bounded failure behavior; there is no automatic cloud fallback. |
| UX-1 | Desktop and mobile journeys cover login, connection, chat, confirmation, reconnect, and failure with keyboard access and no critical accessibility defects. |
| OPS-1 | Setup instructions reproduce both deployment profiles; secrets are absent from browser bundles, chat/model context, and routine logs; backup/restore and production seed safeguards are documented. |

Use focused adapter/auth tests, integration tests with controlled failure injection, and browser tests for the user journeys. Perform a real model/server smoke test in addition to mocks. Record hardware and model versions when measuring latency; do not promise a tokens-per-second target before selecting hardware. The UI should acknowledge submission immediately and keep cancellation available independently of generation speed.

## 8. Delivery sequence

1. **PRD and repository — completed foundation.** Import the starter, preserve provenance, document requirements and review choices. No client feature implementation or deployment.
2. **Foundation and integration proof.** Establish client branding/auth/enrollment, isolated persistence, and a Pi + Bun + local endpoint spike that calls a read-only MCP tool. Pin versions and resolve server-process hosting.
3. **Text MVP.** Implement connection lifecycle, dataset-bound chat, streaming, durable history, writes, confirmations, cancellation, limits, and polished responsive states.
4. **Release validation.** Run acceptance checks, verify both deployment profiles, tailor CI, and write operational documentation.
5. **Local voice.** Select speech models against hardware, implement and validate recording/playback flows, and supply the dedicated setup guide.

## 9. Non-goals and remaining choices

Phase one excludes a native app, public anonymous chat, multi-provider selection UI, arbitrary MCP servers, background autonomous agents, scheduling, multi-agent coordination, RAG/vector search, uploads, a duplicate LifeOR2 dashboard, and automatic undo across tool operations.

Resolve during review or the integration proof:

- Confirm invitation-only enrollment and whether the existing admin app is the preferred administration surface.
- Choose the first inference server/model and available hardware; test streaming, tool reliability, schema support, and context capacity before claiming compatibility.
- Choose local versus hosted client Convex for the first deployment; locally hosted inference alone does not make every application component local.
- Confirm conversation retention and backup policy; default to retained history until user deletion, with a documented backup expiry.
- Define any desired confirmations beyond the server-required permanent deletion and clarification of ambiguous requests.
- Select voice languages, models, and hardware in phase two; avoid committing to a specific audio stack prematurely.

## 10. Source material

- [Starter repository](https://github.com/tkarakai/web-app-starter/tree/e52e8922c5b1865551e00ab6902b9415c128f0c3) and this repository's inherited [starter README](../README.starter.md).
- [Pi](https://pi.dev/) and [embedding SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md). Pi requires an MCP integration adapter; pin the verified package/API at implementation time.
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) and [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). Compatibility depends on the endpoint, model, and configuration.
- LifeOR2's local `docs/decisions/mcp-agent-interface.md`, `lib/mcp/server.ts`, and `lib/mcp/http.ts`, inspected on 2026-09-16. The observed server work is not yet committed; the protocol, 110-tool catalog, token rotation, permission, and retry requirements above describe that working tree. Reverify against the deployed server before implementation acceptance.
- [Browser microphone requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
