# Security Policy

## Supported Versions

The `main` branch is the supported development line. Tagged releases will receive security fixes when maintainers have capacity to ship them.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting if it is enabled for this repository. If that is unavailable, contact the maintainers privately through the contact methods listed on the repository owner's GitHub profile.

Include:

- affected version or commit;
- steps to reproduce;
- expected impact;
- whether a GitHub token, repository write access, or local network access is required.

## Security Model

GitHub Monitor is intended to run on a trusted local machine and binds to `127.0.0.1` by default. It uses the caller's GitHub token for API reads and for merge requests initiated from the dashboard. Treat the local dashboard as privileged when using a token that can merge pull requests.

Do not expose the server directly to an untrusted network.
