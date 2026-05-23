# GitHub App authentication (optional)

GitHub Monitor supports two authentication modes:

| Mode | When to use | Hourly REST quota |
| --- | --- | --- |
| Personal access token (PAT) — default | Single user, single account, small repo count, fast setup | 5,000 |
| GitHub App | Polling many repos across one or more organizations, want per-installation quota isolation, prefer scoped permissions over a broad PAT | 5,000 base + boost up to 12,500 per organization installation |

Both modes work with the same server code. Configuration alone decides which is used: if `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` are both set, the server uses GitHub App auth; otherwise it falls back to the existing PAT path (`GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`).

## When the App mode helps you

The GitHub App per-installation rate limit, on a non-Enterprise-Cloud organization, follows roughly this formula (see the official [REST rate-limits doc](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)):

```
limit = 5,000
       + 50 × (org users  − 20)   if more than 20 users in the org
       + 50 × (installed repos − 20)   if installed on more than 20 repos
       capped at 12,500
```

Two practical takeaways:

- Installing on more repositories increases the cap (until you hit 12,500). Selecting "All repositories" at install time, or installing on at least 20+ repositories, makes the biggest difference.
- Installations are scoped per account. Installing the App on five repositories in one organization gives you **one** rate-limit bucket, not five. Installing the App on five separate organizations gives you **five independent buckets**.

If you monitor repositories in a single small organization, expect a modest improvement. If you monitor multiple organizations, the per-installation isolation is the larger win.

## Step 1 — Create the GitHub App

The App is yours: each operator stands up their own. The project does not run a hosted shared App.

1. Open [github.com/settings/apps/new](https://github.com/settings/apps/new) — or for an organization-owned App: `https://github.com/organizations/<ORG>/settings/apps/new`.
2. **GitHub App name**: any unique name, e.g. `github-monitor-<your-handle>`.
3. **Homepage URL**: any URL you control, including this repo's URL.
4. **Webhook**: uncheck **Active**. GitHub Monitor polls; it does not consume webhooks.
5. **Repository permissions** (request only the access you need):

   | Permission | Access | Why |
   | --- | --- | --- |
   | Actions | Read-only | Workflow runs, runners |
   | Checks | Read-only | CheckRun data in the PR `statusCheckRollup` GraphQL field |
   | Commit statuses | Read-only | Legacy StatusContext data in the PR `statusCheckRollup` GraphQL field |
   | Contents | Read & write | Read commits, trees, file content; delete merged PR head branches |
   | Deployments | Read-only | Running deployments view |
   | Metadata | Read-only | Mandatory; repository discovery |
   | Pull requests | Read & write | List PRs; merge or close PRs from the dashboard |

6. **Organization permissions**:

   | Permission | Access | Why |
   | --- | --- | --- |
   | Self-hosted runners | Read-only | Organization-level runner visibility |

7. **Subscribe to events**: none.
8. **Where can this GitHub App be installed?**: choose "Any account" if you plan to install it on multiple orgs or both personal and org accounts; "Only on this account" otherwise.
9. Click **Create GitHub App**.
10. On the App's settings page, record the **App ID** (a number near the top).
11. Scroll to **Private keys** and click **Generate a private key**. The browser will download a `.pem` file. Store it locally, then delete the downloaded copy. See [Step 3](#step-3--store-the-private-key).

## Step 2 — Install the App on the accounts you want to monitor

1. On the App's settings page, click **Install App** in the sidebar.
2. For each account (personal account or organization) whose repos you want to monitor, click **Install** and choose:
   - **All repositories** — recommended if you frequently add or rename repos; the App will automatically have access to new repositories.
   - **Selected repositories** — explicit list. To approach the 12,500/hr cap, install on at least 20 repositories.

You can install the App on as many accounts as you want; each installation has an independent rate-limit bucket.

## Step 3 — Store the private key

GitHub Monitor reads the private key from a file path. Do not paste the key contents into an environment variable; PEM contents have literal newlines that are easy to mangle and leak through shell history and process listings.

```sh
mkdir -p ~/.config/github-monitor
mv ~/Downloads/<your-app>.<date>.private-key.pem ~/.config/github-monitor/github-app-private-key.pem
chmod 600 ~/.config/github-monitor/github-app-private-key.pem
```

If the file is readable by group or others, the server prints a warning at first use; treat that warning as actionable.

Add the key file to your global Git ignore as defense in depth. The project's local `.gitignore` already excludes `*.pem` so the key cannot be committed accidentally from this repository even if it is moved here.

### Rotating the private key

1. On the App's settings page, generate a new private key. GitHub shows up to two active keys per App; both work until you delete one.
2. Replace `~/.config/github-monitor/github-app-private-key.pem` with the new file (preserve `0600`).
3. Restart `github-monitor`. The next request mints a fresh JWT from the new key.
4. On the App's settings page, delete the old key.

If you suspect the key has been exposed, delete it first and treat the App as compromised: investigate any usage in your repositories' audit log.

## Step 4 — Configure the server

```sh
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY_PATH=~/.config/github-monitor/github-app-private-key.pem
npm start
```

At startup the server logs the active auth mode. Look for:

```
Auth mode: GitHub App (id 123456)
```

If you instead see `Auth mode: Personal access token`, one of the two environment variables is missing or empty and the server fell back to PAT mode.

## Step 5 — Verify the new quota

Open the dashboard. The footer chip near the API quota indicator (`core: 1487/5000 · watch · resets …`) will reflect the installation's limit. For an organization with 20+ users installed on 20+ repos, the `limit` portion should be `12500`. For smaller installations it stays at `5000` plus the small boosts described above.

Each installation has its own bucket. If the App is installed on multiple accounts, the dashboard reports the bucket of the request that triggered the most recent rate-limit header — not the sum.

## Limitations of the App mode

- `mine` mode in the dashboard filters PRs by author "me". Under App auth there is no human user identity behind the requests; the dashboard treats the first discovered installation's account login as "me" instead. If you depend on `mine` mode with a specific user identity, stay on PAT mode.
- GraphQL queries (PR search) use the first discovered installation's token by default. If your search query asks about an organization that the App is not installed on, the result will be empty.
- The App must be installed on at least one account before the server starts; otherwise the first request fails with "GitHub App has no installations."

## Falling back to PAT mode

To switch back, unset the App environment variables and restart:

```sh
unset GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY_PATH
npm start
```

The existing `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token` paths continue to work unchanged.
