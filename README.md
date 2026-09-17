# LifeOR2 Client

An independent, authenticated conversational workspace for LifeOR2, built with Bun, TypeScript, Next.js, Convex, Better Auth and Pi. All business data access goes through LifeOR2's MCP server; inference uses one operator-configured OpenAI-compatible endpoint.

The phase-one text implementation includes dataset-bound chat, durable history, streaming, tool activity, deletion confirmations, cancellation, OAuth connection management, and a responsive light/dark interface. Voice is a later milestone.

- [Product requirements](docs/PRD.md)
- [Setup, LifeOR2 source reference, configuration and operations](docs/lifeor2-integration.md)
- [Implementation evidence and remaining release validation](docs/implementation-status.md)
- [Contributing and pull request workflow](CONTRIBUTING.md)

```sh
bun install --frozen-lockfile
bun run dev:web
```

Development starts a separate client Convex backend and generates private local gateway/encryption keys. Configure the LifeOR2 OAuth registration and inference settings in `apps/web/.env.local`; see [the environment template](apps/web/.env.example). The development model is configurable; the supplied endpoint/model are `http://127.0.0.1:8000/v1` and `gemma-4-12B-it-8bit`. Its initial smoke test requires a valid API key before live validation can finish.

LifeOR2's source is available locally at `/Users/tamas/dev/projects/lifeor2` (normally `../lifeor2`). It is a contract reference, not a source/database dependency. Register this client in LifeOR2's **Workspace → Agent connections**.

## Connect to LifeOR2

The **“Ask your operator to configure the LifeOR2 connection”** message means the client server's connection settings are missing or invalid. For local development, you are the operator: complete the one-time registration below, then authorize your account in the browser.

### One-time client registration

1. Start LifeOR2 separately, normally at `http://localhost:3000`, and start this client with `bun run dev:web`. The **client web app uses `http://localhost:3002`**. Its launcher fails if another server is listening on that port instead of silently changing the OAuth callback. The admin app prefers port **3003**.
2. Sign into **LifeOR2**, open [Workspace → Agent connections](http://localhost:3000/dashboard/agents), and click **Register a client**.
3. Enter `LifeOR2 Client` as the name and this exact callback URL:

   ```text
   http://localhost:3002/api/lifeor/oauth/callback
   ```

4. Copy the resulting **client ID URL** from **Registered clients** into `apps/web/.env.local`. Preserve the file's existing secrets and use the actual ID URL LifeOR2 gives you:

   ```dotenv
   NEXT_PUBLIC_SITE_URL=http://localhost:3002
   LIFEOR_MCP_URL=http://localhost:3000/mcp
   LIFEOR_OAUTH_CLIENT_ID=http://localhost:3000/oauth/clients/<registered-id>
   LIFEOR_OAUTH_REDIRECT_URI=http://localhost:3002/api/lifeor/oauth/callback
   ```

   The client ID is public metadata, not a password. The callback must match exactly, including hostname and port; `localhost` and `127.0.0.1` are different origins. For hosted deployments, substitute the real HTTPS origins and register the corresponding callback.
5. Restart the client web server after editing its environment. If it was already running on port 3003, stop that instance and restart with `bun run dev:web`, then use `http://localhost:3002`. If port 3002 is occupied, identify the listener with `lsof -nP -iTCP:3002 -sTCP:LISTEN` and stop the conflicting server before retrying.

### Connect your account

1. Sign into the **client web app** with a regular user account (see the development credentials below). The admin app manages client users; admin accounts cannot chat.
2. Click **Connect LifeOR2**, choose the permissions you need, and continue to LifeOR2's login and consent screen.
3. Approve access to your chosen LifeOR2 datasets, return to the client, select a dataset, and start a conversation.

Register once per client deployment; each user then authorizes their own LifeOR2 account. The two apps have independent accounts, and matching email addresses do not connect them automatically. OAuth connects your data; chat generation also needs the configured inference server and its valid `LLM_API_KEY` as described above.

The client uses its own `lifeor2-client.*` authentication cookies so logging into LifeOR2 on another localhost port cannot replace the client session. If upgrading from the earlier shared-cookie version, sign into the client again once and start a fresh **Connect LifeOR2** flow. Do not reuse an old OAuth callback URL.

## Development process isolation

The launcher requires Python 3.9+ and the usual `ps`, `pgrep`, and `lsof` utilities. Each checkout records its own service PIDs and process start identities in ignored `.dev-pids` and `.dev-processes.json` files. Start, restart, and stop verify the identity and working directory before signalling a process or its descendants. Unrelated Convex servers, other clones, and unregistered processes are left alone; there is no machine-wide orphan cleanup.

- `bun run dev:stop` stops verified services in this checkout.
- `bun run dev:stop:convex` stops only this checkout's verified Convex process tree.
- `bun run dev:nuke-all` explicitly stops verified services across this Git repository's worktrees, with confirmation (`--yes` for non-interactive use). It preserves databases, dependencies and build caches.
- Existing servers started before this change have no identity record. Stop them from their original terminals once, then restart with the updated launcher. Unknown or stale PIDs are never adopted automatically.

LifeOR2 uses Convex ports **3240/3241**; this client currently uses **3210/3211**, with a separate database. Keep those deployments independent. A different deployment's process name does not indicate a conflict. Run the isolation regression tests with `bun run test:dev-scripts`; they use disposable processes and temporary checkouts.

## First admin login

### Local development

Start both the client and administration app from the repository root:

```sh
bun run dev --app=web,admin
```

Open `/sign-in` at the **Admin URL printed by the launcher** (normally `http://localhost:3003/sign-in`; occupied admin ports are reassigned). Local development seeds this account:

| Field | Value |
| --- | --- |
| Email | `admin@admin.com` |
| Password | `admin@admin.comadmin@admin.comadmin@admin.com` |

If the first startup skipped seeding while configuring the local backend, run this once after startup:

```sh
cd packages/backend
bunx convex run devSeed:seed
```

The seed is idempotent and restricted to explicitly enabled, loopback development environments. These credentials are not created in production.

Open **Onboarding Queue** (`/manage/onboarding`) to invite regular users or additional admins. Admin accounts use the administration app; chatting requires a regular client account. Development also seeds `user@user.com` with password `user@user.comuser@user.comuser@user.com` for signing in to the **Web URL**.

### Fresh production deployment

There is no default production admin password. First deploy the apps and configure the **client's Convex deployment**, including authentication settings, `SITE_URL` (client URL first), `ADMIN_SITE_URL`, and working invitation email delivery (`RESEND_API_KEY` and `EMAIL_FROM`); see [setup](docs/lifeor2-integration.md). Then, from this repository:

```sh
cd packages/backend
bunx convex run --prod bootstrap:initialize '{"email":"you@example.com"}'
bunx convex run --prod bootstrap:status '{}'
```

Use your own email and ensure the selected production deployment belongs to this client. You can also run these functions in that deployment's Convex dashboard.

Claim the emailed invitation and choose a password, then open the **admin app's `/sign-in`** and complete any prompted security setup. The initial invitation opens the client app; an access-denied page there after signup does not prevent signing in to the admin app.

Initialization only works before an admin exists. If the first invitation expires or the email was mistyped before it was claimed, run `bootstrap:rescue` with `currentEmail` and `newEmail` in the Convex dashboard; use the same email for both to resend. Check `bootstrap:status` for recovery guidance.

## Repository history

This repository preserves the Git history of [tkarakai/web-app-starter](https://github.com/tkarakai/web-app-starter), imported at `e52e8922c5b1865551e00ab6902b9415c128f0c3`. The [starter documentation](README.starter.md), administration app and other app sources remain available. No production deployment has been provisioned; live model/LifeOR2 acceptance and hosted operational checks remain as documented above.
