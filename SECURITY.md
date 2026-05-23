# Security Policy

## Supported Versions

The `main` branch is the supported development line. Tagged releases will receive security fixes when maintainers have capacity to ship them.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/GipsyChef/github-monitor/security/advisories/new) if it is enabled for this repository. If that is unavailable, contact the maintainers privately at [cigan1@gmail.com](mailto:cigan1@gmail.com).

Include:

- affected version or commit;
- steps to reproduce;
- expected impact;
- whether a GitHub token, repository write access, or local network access is required.

## Security Model

GitHub Monitor is intended to run on a trusted local machine and binds to `127.0.0.1` by default. It authenticates to GitHub with either a personal access token (PAT) read from `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`, or with installation tokens minted from a GitHub App you control. Both paths are used for API reads and for merge or close actions initiated from the dashboard. Treat the local dashboard as privileged whenever the active credential can merge or close pull requests.

Do not expose the server directly to an untrusted network.

## GitHub App private keys

When the GitHub App auth mode is enabled (`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` both set):

- Store the `.pem` private key outside this repository. The recommended location is `~/.config/github-monitor/github-app-private-key.pem`.
- Set the file mode to `0600`. The server warns at startup if the key is readable by group or others.
- Do not paste private key contents into shell environment variables; use the file path mechanism. PEM bodies have literal newlines that are easy to leak through shell history, process listings, and CI logs.
- The repository `.gitignore` excludes `*.pem` files. Do not move the key into the working tree even temporarily.
- Rotate the key on a schedule and immediately if you suspect exposure. Setup and rotation steps are documented in [docs/github-app-setup.md](docs/github-app-setup.md). Audit usage in the App's settings and your repositories' security log when investigating a suspected leak.
