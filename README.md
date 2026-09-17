# LifeOR2 Client

An independent, authenticated web interface to LifeOR2 data, powered by Pi and server-configured OpenAI-compatible inference. Local dictation and speech output are planned for phase two.

**Current status: PRD draft.** The repository contains the imported starter and planning documents; LifeOR2 chat features are not implemented yet.

Start with the **[Product Requirements Document](docs/PRD.md)** for scope, user journeys, architecture, visual direction, acceptance criteria, and proposed defaults.

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
