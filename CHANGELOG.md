# Changelog

All notable changes to this project will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased]

### Added

- The footer rate-limit chip now tracks each GitHub App installation as an independent bucket. The headline number is the *tightest* bucket (lowest remaining-to-limit ratio) across all observed installations and resources — the one that would throttle first — and a `+N bucket(s)` suffix indicates additional buckets exist. Hover the chip for the full per-installation breakdown (account, used/limit, reset time) and the total observed capacity. PAT mode shows a single bucket as before.
- GitHub App authentication is now supported alongside the existing PAT path. When `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` are both set, the server signs a short-lived JWT, discovers installations, and mints per-installation access tokens that route requests by owner. PAT auth remains the default when those variables are absent. Setup, permission scoping, private-key handling, and rate-limit trade-offs are documented in `docs/github-app-setup.md`.
- GitHub REST GET requests now reuse ETag-based conditional caching: subsequent scans send `If-None-Match` and a 304 response is served from memory without consuming the primary rate limit. Warm dashboard refreshes now spend close to zero quota points where they previously spent dozens.
- Server-managed auto merge now monitors eligible passing PRs in the selected scope, keeps the countdown active without relying on the browser tab, and exposes `/api/auto-merge`.
- No-CI pull requests now appear in a dedicated view when they are non-draft, conflict-free, and reported as mergeable by GitHub.
- Pull requests can be closed from the dashboard through `POST /api/pull-request/close`.
- CI and CD failure rows and notifications now include the failing check, job, or workflow reason when GitHub reports one.
- Browser and in-app release notifications include more detail for completed CI/CD work.
- Security and release-readiness checks now include CI, CodeQL, dependency review, Scorecard, package verification, issue templates, PR templates, CODEOWNERS, and community documentation.
- Fuzz coverage was added for hardening-sensitive server behavior.
- Community documentation now includes contributor orientation and support boundaries for open source users.

### Changed

- Failed CD now lists only CD workflow runs that are still failing. A failure that has already been superseded by a newer successful run on the same workflow is no longer surfaced as a current problem; the run remains visible in Finished CD as a historical FAILURE row. The view title now reads "CD workflows still failing".
- Auto merge now targets only passing PRs with completed checks, while manually mergeable no-CI PRs remain available for explicit user action.
- Auto merge countdown was shortened from 30 seconds to 15 seconds.
- PR searches exclude archived repositories.
- The dashboard UI was tightened for accessibility and operational clarity by simplifying unused controls and improving segmented-control semantics.
- Repository metadata, package metadata, README, support, security, contributing, maintainer, license, and code of conduct documentation were prepared for public open source release.
- Changelog maintenance is now part of the contribution workflow, and this changelog has been backfilled with the project changes made so far.
- Refresh behavior is now driven by GitHub API quota state: low quota pauses refresh, disables the manual refresh button, and waits for the reset window.

### Fixed

- Failed CD now surfaces every workflow run that failed within the 3-day window, including failures that were superseded by a newer completed run. The previous "latest run only" logic silently hid failures whenever a follow-up redeploy succeeded or was skipped, while Finished CD still listed them as `FAILURE` — making the two views disagree on whether any deploys had failed.
- Each Failed CD row now indicates whether it is still failing or has been resolved by a newer successful run, and the Failed CD scoreboard chip distinguishes "N still failing" from "all resolved".
- Auto merge button now updates as soon as the server completes the merge, instead of staying stuck on "Merging" until the next periodic refresh.
- Auto merge button is disabled while in the "Merging" state so a user cannot fire a duplicate merge request that races the server-side auto-merge scan.
- Merge requests are rechecked server-side before merging and reject drafts, conflicts, failing checks, running checks, and no-CI PRs that GitHub does not currently report as mergeable.
- Successful merges now delete the PR head branch when GitHub allows it.
- Scorecard and code scanning workflows were corrected and gated appropriately for private repository state.
- Dashboard security headers now apply to API and static responses.
- CI/CD notification snapshots now account for conflicts and no-CI PRs so completion alerts do not miss visible PR states.
- Successful merge, close, and auto-merge follow-up actions no longer trigger an immediate status rescan while the dashboard is waiting for its scheduled refresh clock.

## [1.0.0] - 2026-05-13

- Initial local GitHub operations dashboard with PR, CI, CD, deployment, runner, notification, and guarded merge workflows.
- Direct GitHub REST and GraphQL integration using `GITHUB_TOKEN`, `GH_TOKEN`, or local GitHub CLI auth.
- Owner, owned-repository, and authored-PR dashboard scopes.
- PR grouping for passing, failing, running, and merge-conflict states.
- Optional CD/deploy/release/publish workflow audit, recent CD completion tracking, failed CD tracking, and running deployment visibility.
- Busy self-hosted runner visibility.
- GitHub API quota tracking with adaptive refresh recommendations.
- Browser notifications, service worker support, and an in-app notification inbox.
- Guarded manual merge support for passing PRs.
