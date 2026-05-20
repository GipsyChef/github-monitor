# Community Guide

GitHub Monitor is a small local-first maintainer utility. The community goal is to keep it reliable, understandable, and safe for people who run it against their own GitHub accounts.

## Who This Project Is For

- Maintainers who watch several repositories and want one local dashboard for PR, CI, CD, deployment, and runner state.
- Contributors who want to improve the local dashboard experience, GitHub API efficiency, security posture, or documentation.
- Teams evaluating whether a local-only operations dashboard fits their workflow.

It is not intended to become a hosted multi-user service in this repository. Proposals that move the project toward hosted auth, shared tenancy, central storage, or organization-wide SaaS operations need a separate design discussion before implementation.

## Good First Contributions

Good first issues usually improve one focused surface:

- README, setup, troubleshooting, or screenshots.
- Small UI/UX fixes that preserve the local dashboard workflow.
- GitHub API quota efficiency and caching improvements.
- Tests for PR classification, CD summaries, quota behavior, or security headers.
- Accessibility fixes for keyboard flow, labels, focus states, or responsive layout.

Before opening a larger PR, start with an issue or discussion so maintainers can confirm the direction.

## Contribution Expectations

- Keep PRs focused and reviewable.
- Include tests or a clear manual QA note for behavior changes.
- Update `README.md` and `CHANGELOG.md` when user-facing behavior changes.
- Avoid including private repository names, screenshots with sensitive data, tokens, logs, or local environment files.
- Be explicit when a change affects GitHub token scopes, merge behavior, auto-merge behavior, or API quota usage.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the development workflow.

## Support Boundaries

Maintainers can usually help with reproducible bugs, clear feature proposals, and documentation gaps.

Maintainers generally cannot debug private repositories, private GitHub organization policy, local token permissions, or hosted deployments without a minimal public reproduction.

See [SUPPORT.md](../SUPPORT.md) for where to ask for help.

## Security And Responsible Disclosure

Do not open public issues for suspected vulnerabilities. Follow [SECURITY.md](../SECURITY.md).

Security-sensitive areas include:

- GitHub token discovery and handling.
- Merge and auto-merge behavior.
- Branch deletion behavior.
- Local server binding and security headers.
- GitHub Actions, dependency review, CodeQL, and release workflows.

## Maintainers

The maintainer roster is in [MAINTAINERS.md](../MAINTAINERS.md). Maintainers triage issues, review security-sensitive changes, enforce the code of conduct, and cut releases.
