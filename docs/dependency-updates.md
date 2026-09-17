# Dependency updates

Renovate owns dependency update PRs. Dependabot provides vulnerability alerts and the dependency graph; GitHub's dependency-review action checks dependency changes in PRs. This keeps one bot responsible for changing manifests and `bun.lock`.

## Responsibilities

| Function | Owner |
| --- | --- |
| Routine library and tool upgrades | Renovate |
| GitHub Actions SHA pinning and updates | Renovate |
| Related-package grouping and compatibility constraints | Renovate |
| Scheduled lockfile maintenance | Renovate |
| Vulnerability detection and alerts in GitHub | Dependabot |
| Security-fix PRs responding to GitHub alerts or OSV findings | Renovate |
| Dependency review on incoming PRs | GitHub Security workflow |

Dependabot alerts and the dependency graph are enabled. Dependabot **security-update PRs remain disabled**, and there is no `dependabot.yml` for version updates. Do not enable a second updater for the same dependencies. Enabling alerts alone does not open update PRs.

## Update policy

The policy is in [`renovate.json`](../renovate.json):

- Routine releases wait at least 10 days (`minimumReleaseAge` with strict internal checks).
- Patch, minor, pin, and digest updates can squash-auto-merge after the required **LifeOR2 validation** check passes and the branch is up to date.
- Non-major development dependencies are grouped to reduce PR volume.
- Better Auth, its plugins, and the Convex auth adapter are grouped and always require manual merging. Preserve the current passkey compatibility constraint until the adapter supports the newer auth version.
- Major updates require manual merging.
- Weekly lockfile refreshes require manual merging. They regenerate transitive resolutions and do not provide the same release-age filtering as individual upgrades.
- Security-fix PRs bypass the routine release cooldown, receive a `security` label, and require manual merging. Renovate reads GitHub alerts and also consults OSV; detection and fix availability vary by ecosystem.
- GitHub Actions references are pinned to commit SHAs and kept current.

The dependency dashboard shows pending updates, open PRs, and configuration problems. Routine PRs are capped at five concurrently; security updates follow Renovate's separate vulnerability handling.

Auto-merge is enabled for the repository, but is activated per PR by Renovate according to these rules. It does not automatically merge unrelated feature PRs. Deployment workflows remain disabled, so merging an update does not deploy the application.

## Runner and activation

We use the same Actions-based Renovate setup as `web-app-starter`, on GitHub-hosted runners. There is no separate server and no hosted Renovate App installation. The workflow is [`.github/workflows/renovate.yml`](../.github/workflows/renovate.yml), scheduled for Monday and Thursday at 06:00 UTC, with manual dispatch available. Schedules can be delayed, and GitHub may disable scheduled workflows after prolonged repository inactivity.

Current activation status: the workflow is disabled pending a repository-scoped `RENOVATE_TOKEN`. Configuration changes are part of PR #1 and must reach `main` before the scheduled bot uses them. Validation of the configuration is not evidence that live updates have run.

GitHub cannot reveal or copy the existing `web-app-starter` Actions secret. Create a separate fine-grained token restricted to `tkarakai/lifeor2-client` with these repository permissions:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Workflows | Read and write |
| Commit statuses | Read and write |
| Dependabot alerts | Read-only |
| Metadata | Read-only (automatic) |

Store it under **Settings → Secrets and variables → Actions** as `RENOVATE_TOKEN`. Set a finite expiry and record the renewal date privately. Do not put it in source files, PRs, logs, or chat. A dedicated GitHub App installation token is also supported if an app is provisioned later.

Do not substitute the workflow's default `GITHUB_TOKEN`: PRs created with it do not trigger the normal PR validation workflows. Commit-status write access is needed for Renovate's release-age checks.

After the secret exists and PR #1 has been merged through the normal PR flow:

```sh
gh workflow enable renovate.yml --repo tkarakai/lifeor2-client
gh workflow run renovate.yml --repo tkarakai/lifeor2-client --ref main -f logLevel=info
gh run list --repo tkarakai/lifeor2-client --workflow renovate.yml --limit 5
```

Watch the dispatched run to completion and inspect its logs, the Dependency Dashboard, and any update PRs. Confirm `LifeOR2 validation` starts on bot PRs and manifests plus `bun.lock` stay consistent. A successful workflow exit alone does not prove every dependency was processed. If no updates are eligible, record that result instead of treating the absence of PRs as a failure. Update the activation status above after verification.

## Validation and maintenance

Before merging config changes, run the Renovate validator and workflow linter:

```sh
bunx --package renovate@44.96.4 renovate-config-validator renovate.json
actionlint .github/workflows/renovate.yml
```

To rotate the credential, replace the repository secret and dispatch a verification run. If updates stop, check token expiry/permissions, workflow state, and the Renovate logs. Keep required CI checks enabled; administrator bypass exists to match the starter, but is not part of the normal update flow.
