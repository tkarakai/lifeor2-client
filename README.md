# LifeOR2 Client

An independent, authenticated web interface to LifeOR2 data, powered by Pi and server-configured OpenAI-compatible inference. Local dictation and speech output are planned for phase two.

**Current status: PRD draft.** The repository contains the imported starter and planning documents; LifeOR2 chat features are not implemented yet.

Start with the **[Product Requirements Document](docs/PRD.md)** for scope, user journeys, architecture, visual direction, acceptance criteria, and proposed defaults.

## Development process isolation

The launcher requires Python 3.9+ and the usual `ps`, `pgrep`, and `lsof` utilities. Each checkout records its own service PIDs and process start identities in ignored `.dev-pids` and `.dev-processes.json` files. Start, restart, and stop verify the identity and working directory before signalling a process or its descendants. Unrelated Convex servers, other clones, and unregistered processes are left alone; there is no machine-wide orphan cleanup.

- `bun run dev:stop` stops verified services in this checkout.
- `bun run dev:stop:convex` stops only this checkout's verified Convex process tree.
- `bun run dev:nuke-all` explicitly stops verified services across this Git repository's worktrees, with confirmation (`--yes` for non-interactive use). It preserves databases, dependencies and build caches.
- Existing servers started before this change have no identity record. Stop them from their original terminals once, then restart with the updated launcher. Unknown or stale PIDs are never adopted automatically.

LifeOR2 uses Convex ports **3240/3241**; this client currently uses **3210/3211**, with a separate database. Keep those deployments independent. A different deployment's process name does not indicate a conflict. Run the isolation regression tests with `bun run test:dev-scripts`; they use disposable processes and temporary checkouts.

## Foundation

Based on [tkarakai/web-app-starter](https://github.com/tkarakai/web-app-starter) at commit `e52e8922c5b1865551e00ab6902b9415c128f0c3`, preserving its Git history. The stack includes Bun, TypeScript, Next.js, Convex, Better Auth, and shared UI components. The original setup documentation is retained in [README.starter.md](README.starter.md).

The client has its own accounts and persistence. It accesses LifeOR2 business data exclusively through the LifeOR2 MCP server. Inference is configured by the operator and is expected to run on local model infrastructure.

## Repository state

- `origin`: the independent private `tkarakai/lifeor2-client` repository.
- `upstream`: the original starter repository.
- The starter's apps, scripts, and workflows are retained as a foundation; they do not yet represent an implemented LifeOR2 client.
- GitHub Actions are disabled during this initial import. Tailor CI and deployment workflows to this project before enabling them; inherited automation is not configured for this repository.
- No deployment, model service, auth service, or application instance has been provisioned by this planning step.

## Next milestone

Review the PRD, then validate Pi under Bun against the chosen local inference endpoint and LifeOR2 MCP server before implementing the text chat experience.
