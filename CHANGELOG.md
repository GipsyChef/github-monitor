# Changelog

All notable changes to this project will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased]

### Added

- Server-managed auto merge now monitors eligible passing PRs in the selected scope, keeps the countdown active without relying on the browser tab, and exposes `/api/auto-merge`.
- No-CI pull requests now appear in a dedicated view when they are non-draft, conflict-free, and reported as mergeable by GitHub.
- Pull requests can be closed from the dashboard through `POST /api/pull-request/close`.
- CI and CD failure rows and notifications now include the failing check, job, or workflow reason when GitHub reports one.
- Browser and in-app release notifications include more detail for completed CI/CD work.
- Security and release-readiness checks now include CI, CodeQL, dependency review, Scorecard, package verification, issue templates, PR templates, CODEOWNERS, and community documentation.
- Fuzz coverage was added for hardening-sensitive server behavior.

### Changed

- Auto merge now targets only passing PRs with completed checks, while manually mergeable no-CI PRs remain available for explicit user action.
- Auto merge countdown was shortened from 30 seconds to 15 seconds.
- PR searches exclude archived repositories.
- The dashboard UI was tightened for accessibility and operational clarity by simplifying unused controls and improving segmented-control semantics.
- Repository metadata, package metadata, README, support, security, contributing, maintainer, license, and code of conduct documentation were prepared for public open source release.
- Changelog maintenance is now part of the contribution workflow, and this changelog has been backfilled with the project changes made so far.

### Fixed

- Auto merge button now updates as soon as the server completes the merge, instead of staying stuck on "Merging" until the next periodic refresh.
- Auto merge button is disabled while in the "Merging" state so a user cannot fire a duplicate merge request that races the server-side auto-merge scan.
- Merge requests are rechecked server-side before merging and reject drafts, conflicts, failing checks, running checks, and no-CI PRs that GitHub does not currently report as mergeable.
- Successful merges now delete the PR head branch when GitHub allows it.
- Scorecard and code scanning workflows were corrected and gated appropriately for private repository state.
- Dashboard security headers now apply to API and static responses.
- CI/CD notification snapshots now account for conflicts and no-CI PRs so completion alerts do not miss visible PR states.

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
