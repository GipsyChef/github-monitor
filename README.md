# GitHub Monitor

A local visual dashboard for the same operational view provided by `/Users/cigan/Documents/projects/aws_scripts/open_prs.sh`.

It calls GitHub's REST and GraphQL APIs directly, scans open PRs, classifies PRs by latest CI status, and optionally audits CD workflows, running deployments, and busy self-hosted runners.

## Stack

- Backend: dependency-free Node HTTP server
- Frontend: dependency-free HTML/CSS/JavaScript
- Data source: direct GitHub REST and GraphQL API calls

This intentionally avoids storing GitHub tokens, adding a database, or introducing app auth. The local server reads `GITHUB_TOKEN` or `GH_TOKEN`; if neither is set, it uses `gh auth token` once to discover your existing local token. Merging PRs from the dashboard uses the same token and requires write access to the target repository.

## Prerequisites

- Node.js 20+
- A GitHub token with access to the repositories you want to scan, provided as `GITHUB_TOKEN` or `GH_TOKEN`
- Optional fallback: GitHub CLI authenticated locally, so the server can read `gh auth token`

Check CLI fallback auth:

```bash
gh auth status
```

Run with an explicit token:

```bash
GITHUB_TOKEN=github_pat_... npm start
```

## Run

```bash
npm start
```

Open:

```text
http://127.0.0.1:4177
```

Use a different port:

```bash
PORT=4180 npm start
```

## Dashboard Controls

- `All owners`: your repos plus all orgs returned by GitHub
- `Owned`: repositories owned by your GitHub user
- `Mine`: PRs authored by you
- `CD audit`: scan CD/deploy/release/publish workflows, failed latest CD runs, and running deployments
- `Busy runners`: scan owner/org self-hosted runners
- `Repo runners`: also scan repository-level runners
- `Jobs`: parallel GitHub lookups, capped at 16
- `Auto refresh`: schedules the next scan adaptively and shows a live countdown

## Adaptive Refresh

The server records GitHub rate-limit headers from each REST and GraphQL response and returns:

- GitHub requests used by the scan
- Per-resource quota, remaining calls, and reset time
- A recommended next refresh time

The browser refreshes faster when PR checks, CD actions, deployments, or runners are active. It slows down when the dashboard is quiet, when expensive audit options are enabled, or when GitHub quota gets tight.

## API

```text
GET /api/status?mode=all&includeCd=1&includeRunners=0&includeRepoRunners=0&jobs=4
POST /api/pull-request/merge
GET /api/health
```

`mode` can be `all`, `owned`, or `mine`.
Merge requests must include JSON like `{"repo":"owner/name","number":123}`. The server re-checks the PR before merging, rejects drafts, conflicts, and PRs without completed passing CI, then deletes the PR head branch after a successful merge.

## Notes

PRs with no CI checks are hidden, matching the behavior of the original script.
