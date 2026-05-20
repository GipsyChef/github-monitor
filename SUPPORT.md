# Support

GitHub Monitor is a local-first open source utility maintained on a best-effort basis.

## Where To Get Help

- Use GitHub issues for reproducible bugs and focused feature requests.
- Use the pull request template when proposing code changes.
- For suspected security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Before Opening An Issue

Please include:

- your Node.js version;
- whether you use `GITHUB_TOKEN`, `GH_TOKEN`, or GitHub CLI auth;
- the dashboard mode and options selected;
- the relevant error message, browser console message, or API response summary;
- steps to reproduce with private repository names redacted.

For GitHub API quota issues, include the quota line shown in the dashboard, for example:

```text
core: 180/5000 · low · resets May 20, 11:08 AM
```

## Out Of Scope

The maintainers generally cannot provide:

- hosted multi-user deployment support;
- debugging for private repositories without a minimal reproduction;
- GitHub organization policy or token-permission administration;
- guaranteed response times;
- support for exposing the local server to untrusted networks.

## Security

The dashboard uses your GitHub token and can merge PRs when your token has write access. Keep it bound to `127.0.0.1` on a trusted local machine.
