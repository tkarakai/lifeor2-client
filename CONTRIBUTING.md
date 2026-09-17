# Contributing

Use a feature branch and a pull request targeting `main` for every change, including documentation and dependency updates. Do not push directly to `main`.

```sh
git fetch origin
git switch -c feat/my-change origin/main
# Make and commit changes.
git push -u origin HEAD
gh pr create --base main
```

Describe the problem, behavior changes, validation, and any deployment steps in the PR. Draft PRs are welcome; CI runs on drafts too. Review outstanding conversations, update the branch if `main` changes, and wait for **LifeOR2 validation** to pass before squash- or rebase-merging. Merge commits are disabled. Auto-merge is available but must be enabled for each PR deliberately. Delete merged feature branches manually when no longer needed.

As in `web-app-starter`, PRs require zero general approvals, with code-owner review enabled in the ruleset. Neither repository currently has a `CODEOWNERS` file, so no ownership-based review requests are generated yet. When adding a reviewer requirement, update both protection files below. PR authors cannot approve their own PRs. Existing approvals are not dismissed on new pushes, and unresolved conversations do not block merges. The ruleset requests Copilot review for new non-draft PRs, without re-review on every push; actual review execution depends on Copilot availability.

## Checks

`.github/workflows/ci-lifeor.yml` runs on every PR to `main`, pushes to `main`, and manual dispatches. Its stable check name is **LifeOR2 validation**. It runs development-script tests, web lint and type checking, web unit and component tests, Convex tests, a production web build, and the LifeOR2 browser journeys. Browser checks use a disposable local Convex backend and require no production credentials. Live OAuth, model inference, and business-data acceptance remain separate release checks in `docs/implementation-status.md`.

The inherited Security workflow is enabled, matching the starter. Its checks are additional to the required LifeOR2 check. The six inherited app/shared CI workflows stay disabled in favor of the client-specific CI flow.

Deployment (`cd-*`) and Renovate workflows remain disabled: this repository has no deployment credentials, configured deployment environments, or `RENOVATE_TOKEN`. Enable them after configuring this client's infrastructure and the dedicated Renovate token described in `docs/dependency-updates.md`. The inherited staging workflow also calls the starter CI workflows and must be adapted to the LifeOR2 check before enabling it. Repository auto-merge availability alone does not start Renovate or deploy anything.

## Main protection

This repository is public. Its settings were aligned with the live `web-app-starter` configuration on 2026-09-17, replacing the starter's six required CI checks with **LifeOR2 validation**. Like the starter, it uses both classic branch protection and an active `rule01` ruleset. The ruleset binds the required check to the GitHub Actions app.

- `.github/repository-settings.json`: squash/rebase merges, auto-merge availability, manual branch deletion, and squash commit defaults.
- `.github/main-protection.json`: classic `main` branch protection.
- `.github/main-ruleset.json`: linear history, PR/code-owner review, Copilot review, check requirements, and administrator bypass for the default branch.

To reapply or inspect the configuration from the repository root:

```sh
gh api --method PUT repos/tkarakai/lifeor2-client/branches/main/protection \
  --input .github/main-protection.json
gh api --method PUT repos/tkarakai/lifeor2-client/rulesets/23604391 \
  --input .github/main-ruleset.json
gh api --method PATCH repos/tkarakai/lifeor2-client \
  --input .github/repository-settings.json
gh api repos/tkarakai/lifeor2-client/branches/main/protection
gh api repos/tkarakai/lifeor2-client/rulesets/23604391
```

For normal contributors, the combined rules require an up-to-date branch, a PR, passing validation, and linear history, and block force pushes and branch deletion. Administrators can bypass these rules, exactly as in the starter; normal work should still follow the PR flow.
