# GitHub Monitor

GitHub Monitor is a local dashboard for keeping track of open pull requests, CI status, CD workflows, deployments, and self-hosted runner activity across your GitHub account and organizations.

It is built for the common maintainer problem: you have work spread across several repositories, browser tabs, Actions pages, and notification streams, and you need one place that answers:

- Which PRs are failing?
- Which PRs are still running checks?
- Which passing PRs are ready to merge?
- Which deploy or release workflows are running or recently failed?
- Are any self-hosted runners busy?
- Is GitHub API quota getting tight?

The app runs only on your machine. It talks directly to GitHub's REST and GraphQL APIs, stores no GitHub token, and keeps notification history in browser localStorage.

## Quick Start

Prerequisites:

- Node.js 22 or newer
- One of the following authentication paths:
  - A GitHub token exposed as `GITHUB_TOKEN` or `GH_TOKEN`
  - GitHub CLI authenticated locally with `gh auth login`
  - A GitHub App with the variables `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` configured. See [docs/github-app-setup.md](docs/github-app-setup.md) for setup and quota trade-offs.

Install from GitHub:

```bash
git clone https://github.com/GipsyChef/github-monitor.git
cd github-monitor
npm ci
```

Start the dashboard:

```bash
npm start
```

Open:

```text
http://127.0.0.1:4177
```

Use an explicit token:

```bash
GITHUB_TOKEN=<your-token> npm start
```

Use another port:

```bash
PORT=4180 npm start
```

For a guided local launch that checks Node.js, GitHub CLI auth, and port availability:

```bash
npm run dev
```

## Install

GitHub Monitor is distributed as source code. Clone the repository and install the locked npm dependency graph:

```bash
git clone https://github.com/GipsyChef/github-monitor.git
cd github-monitor
npm ci
```

There are currently no runtime npm dependencies beyond Node.js itself; `npm ci` verifies the lockfile and prepares the project the same way CI does.

## What It Shows

- Open PRs from non-archived repositories, grouped by passing, no-CI, failing, running, and merge conflict states
- Running non-CD GitHub Actions workflow runs, including jobs that are not currently represented by an open PR status rollup
- Optional CD/deploy/release/publish workflow audit
- CD runs that finished in the last 24 hours
- Latest failed CD runs from the last 3 days
- Running GitHub deployments
- Busy organization and optional repository-level self-hosted runners
- GitHub API request count, remaining quota, and reset time
- Adaptive next-refresh timing based on activity and API quota
- Quota-aware refresh pausing when GitHub API quota is low, including a disabled manual refresh button until the reset window
- Browser notifications and an in-app inbox for CI/CD completions and new conflicts
- Optional auto-merge countdown for passing PRs with completed checks

The merge action is intentionally guarded: before merging, the server re-checks the PR and rejects drafts, conflicts, failing checks, running checks, and no-CI PRs that GitHub does not currently report as mergeable. No-CI PRs that are mergeable can be merged manually. After a successful merge, the server deletes the PR head branch. Auto merge is off by default; when enabled, the server monitors eligible passing PRs with completed checks in the selected scope, counts them down for 15 seconds, and runs the same guarded merge action even if the browser tab is not active. PRs can also be closed from the dashboard regardless of CI state.

If you run the server under a GitHub App and a target repository has a "Restrict who can push" branch protection rule on its merge target, the App must be in that rule's allowlist or merge calls return `You're not authorized to push to this branch.` See [docs/github-app-setup.md](docs/github-app-setup.md#step-6--allow-the-app-through-branch-protection-push-restrictions).

## Stack

- Backend: dependency-free Node HTTP server
- Frontend: dependency-free HTML/CSS/JavaScript
- Data source: direct GitHub REST and GraphQL API calls

This intentionally avoids storing GitHub tokens or adding a database. The local server reads `GITHUB_TOKEN` or `GH_TOKEN`; if neither is set, it uses `gh auth token` once to discover your existing local token. Optionally, the server can authenticate as a GitHub App you control by setting `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` instead — see [docs/github-app-setup.md](docs/github-app-setup.md). Merging PRs from the dashboard uses the active credential and requires write access to the target repository.

## Status

GitHub Monitor is a local-first utility. It is not designed as a hosted multi-user service.

## Prerequisites

- Node.js 22+
- A GitHub token with access to the repositories you want to scan, provided as `GITHUB_TOKEN` or `GH_TOKEN`
- Optional fallback: GitHub CLI authenticated locally, so the server can read `gh auth token`
- Optional alternative to PAT: a GitHub App you own, configured via `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH`. See [docs/github-app-setup.md](docs/github-app-setup.md).

Recommended token scopes depend on what you want to see:

- Read-only PR and Actions monitoring needs repository read access.
- Runner visibility requires Actions runner access for the owner or repository.
- Merging PRs requires write access to the target repository.

GitHub App permissions for the equivalent capabilities are documented in [docs/github-app-setup.md](docs/github-app-setup.md).

Check CLI fallback auth:

```bash
gh auth status
```

## Development

Run the syntax check:

```bash
npm test
```

Run the startup helper, which verifies Node.js, GitHub CLI auth, port availability, and opens the dashboard:

```bash
npm run dev
```

## Dashboard Controls

- `All owners`: your repos plus all orgs returned by GitHub
- `Owned`: repositories owned by your GitHub user
- `Mine`: PRs authored by you
- `CD audit`: scan CD/deploy/release/publish workflows, CD runs finished in the last 24 hours, failed latest CD runs, and running deployments
- `Busy runners`: scan owner/org self-hosted runners
- `Auto refresh`: schedules the next scan adaptively and shows a live countdown
- `Auto merge`: when enabled, passing PRs with completed checks in the selected scope count down for 15 seconds on the server and then merge automatically unless clicked first

## Adaptive Refresh

The server records GitHub rate-limit headers from each REST and GraphQL response and returns:

- GitHub requests used by the scan
- Per-resource quota, remaining calls, and reset time
- Under GitHub App auth: one bucket per installation, since each installation has its own independent quota. The chip in the footer shows the *tightest* bucket (lowest remaining-to-limit ratio) — the one that would throttle first — and notes how many other buckets exist; hover the chip for the full per-installation breakdown.
- A recommended next refresh time

The browser refreshes faster when PR checks, CD actions, deployments, or runners are active. It slows down when the dashboard is quiet, when expensive audit options are enabled, or when GitHub quota gets tight. When quota is low enough that another scan risks exhausting the GitHub API window, the dashboard pauses auto refresh, disables the manual refresh button, and waits until after GitHub's reset time before scanning again.

The notification inbox is kept in localStorage for quick follow-up and prunes entries older than 24 hours.

## API

```text
GET /api/status?mode=all&includeCd=1&includeRunners=0&includeRepoRunners=0&jobs=4
GET /api/runners/status?mode=all&includeRepoRunners=0&jobs=4
POST /api/pull-request/merge
POST /api/pull-request/close
GET /api/health
```

`mode` can be `all`, `owned`, or `mine`.
The runner status endpoint returns only busy self-hosted runners, using the same runner scan as the dashboard. Set `includeRepoRunners=1` to also scan repository-level runners.
Merge requests must include JSON like `{"repo":"owner/name","number":123}`. The server re-checks the PR before merging, rejects drafts, conflicts, failing checks, running checks, and no-CI PRs that GitHub does not currently report as mergeable, then deletes the PR head branch after a successful merge. Close requests use the same JSON shape and close the PR without requiring CI.

## Security

The server binds to `127.0.0.1` and should stay on a trusted local machine. It uses your GitHub token (or GitHub App installation tokens) for API calls and for merges triggered from the dashboard, so do not expose it to an untrusted network.

Never commit `.env` files, real tokens, GitHub App private keys (`*.pem`), screenshots with private repository data, or logs containing private repository names. Store GitHub App private keys outside this repository with file mode `0600` and treat them as credentials of equal sensitivity to the PAT they replace.

## Support

Use GitHub issues for reproducible bugs and focused feature requests. For suspected security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

This is a small local utility, so support is best effort. Hosted multi-user deployment support and debugging private repositories without a minimal reproduction are out of scope.

See [SUPPORT.md](SUPPORT.md) for support boundaries and issue details to include.

## Community

New contributors should start with [docs/COMMUNITY.md](docs/COMMUNITY.md). It explains the intended audience, good first contributions, support boundaries, security-sensitive areas, and maintainer expectations.

## Notes

Draft PRs with no CI checks are hidden. Non-draft PRs with no reported checks and no merge conflicts appear in the No CI view.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/COMMUNITY.md](docs/COMMUNITY.md), [SUPPORT.md](SUPPORT.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).
