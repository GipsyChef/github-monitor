# Contributing to GitHub Monitor

Thanks for taking time to improve GitHub Monitor.

## Development Setup

Prerequisites:

- Node.js 22 or newer
- A GitHub token exposed as `GITHUB_TOKEN` or `GH_TOKEN`, or an authenticated GitHub CLI session

Run the local syntax check:

```bash
npm test
```

Start the dashboard:

```bash
npm start
```

Open `http://127.0.0.1:4177`.

## Pull Requests

- Keep changes focused and easy to review.
- Update `CHANGELOG.md` for every user-facing behavior change, workflow change, security hardening change, or notable documentation/process change.
- Update `README.md` when user-facing behavior, configuration, or security boundaries change.
- Add tests or focused verification notes for behavior changes.
- Do not commit real tokens, `.env` files, local logs, screenshots with private data, or repository/organization names that should not be public.
- For changes to merge behavior, GitHub API scopes, or token handling, describe the security impact in the PR.

Every pull request is expected to pass the required GitHub Actions checks:

- `CI`: installs with `npm ci`, runs tests on supported Node.js versions, smoke-tests `/api/health`, audits production dependencies, verifies package contents, and checks repository hygiene.
- `Dependency Review`: blocks newly introduced vulnerable dependencies at moderate severity or higher.
- `CodeQL`: runs GitHub's static analysis for JavaScript.

OpenSSF Scorecard runs on `main`, on a schedule, and on manual dispatch to track broader supply-chain posture.

## Community And Support

Read [docs/COMMUNITY.md](docs/COMMUNITY.md) before starting larger changes. It describes the project audience, good first contribution areas, support boundaries, and security-sensitive surfaces.

Use [SUPPORT.md](SUPPORT.md) when filing support requests so maintainers have the details needed to reproduce the issue.

## Contributor License

Contributions are accepted under the inbound-equals-outbound model: by submitting a contribution, you agree to license it under the same MIT License used by this project.

## Code of Conduct

All participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
