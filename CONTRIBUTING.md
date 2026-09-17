# Contributing

Use a feature branch and a pull request targeting `main` for every change, including documentation and dependency updates. Do not push directly to `main`.

```sh
git fetch origin
git switch -c feat/my-change origin/main
# Make and commit changes.
git push -u origin HEAD
gh pr create --base main
```

Describe the problem, behavior changes, validation, and any deployment steps in the PR. Draft PRs are welcome; CI runs on drafts too. Resolve review conversations, update the branch if `main` changes, and wait for **LifeOR2 validation** to pass before squash-merging. Delete the feature branch after merging; GitHub is configured to do this automatically.

This is currently a solo-maintainer workflow, so the protection configuration requires a PR but zero independent approvals. When another maintainer joins, raise `required_approving_review_count` to one in `.github/main-protection.json` and reapply it. PR authors cannot approve their own PRs.

## Checks

`.github/workflows/ci-lifeor.yml` runs on every PR to `main`, pushes to `main`, and manual dispatches. Its stable check name is **LifeOR2 validation**. It runs development-script tests, web lint and type checking, web unit and component tests, Convex tests, a production web build, and the LifeOR2 browser journeys. Browser checks use a disposable local Convex backend and require no production credentials. Live OAuth, model inference, and business-data acceptance remain separate release checks in `docs/implementation-status.md`.

Inherited `ci-*`, `cd-*`, security, and Renovate workflows are disabled in this repository's GitHub Actions settings, except `ci-lifeor.yml`. They remain in the tree as reference. Enable them individually only after adapting and validating their infrastructure; enabling repository Actions alone must not be treated as deployment setup.

## Main protection

This repository is public. GitHub branch protection on `main` was enabled on 2026-09-17, using `.github/main-protection.json`.

To reapply or inspect the configuration from the repository root:

```sh
gh api --method PUT repos/tkarakai/lifeor2-client/branches/main/protection \
  --input .github/main-protection.json
gh api repos/tkarakai/lifeor2-client/branches/main/protection
```

This requires an up-to-date branch, a PR, passing validation, resolved conversations, and linear history; it applies to administrators and disallows force pushes and branch deletion. Repository merge settings allow squash merging only.
