import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SECURITY_HEADERS,
  bestProductionUrlCandidate,
  buildChangeSummary,
  classifyPullRequest,
  extractProductionUrlsFromText,
  groupPullRequests,
  isProductionTargetScanPath,
  isAutoMergeCandidate,
  mergeBlockReason,
  openPullRequestSearchQuery,
  quotaState,
  recommendRefresh,
  publicRouteFromFile,
  server
} from "../server.js";

const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("conflicted pull requests are excluded from CI status buckets", () => {
  const groups = groupPullRequests([
    { repo: "owner/a", number: 1, state: "pass", checkCount: 2, hasConflict: false },
    { repo: "owner/a", number: 2, state: "pass", checkCount: 2, hasConflict: true },
    { repo: "owner/a", number: 3, state: "fail", checkCount: 2, hasConflict: true },
    { repo: "owner/a", number: 4, state: "running", checkCount: 2, hasConflict: true }
  ]);

  assert.deepEqual(groups.pass.map((pr) => pr.number), [1]);
  assert.deepEqual(groups.fail.map((pr) => pr.number), []);
  assert.deepEqual(groups.running.map((pr) => pr.number), []);
  assert.deepEqual(groups.conflicts.map((pr) => pr.number), [2, 3, 4]);
});

test("ready pull requests without CI are listed separately from passing CI", () => {
  const groups = groupPullRequests([
    { repo: "owner/a", number: 1, state: "pass", checkCount: 2, isDraft: false, hasConflict: false },
    { repo: "owner/a", number: 2, state: "pass", checkCount: 0, isDraft: false, hasConflict: false },
    { repo: "owner/a", number: 3, state: "pass", checkCount: 0, isDraft: true, hasConflict: false },
    { repo: "owner/a", number: 4, state: "pass", checkCount: 0, isDraft: false, hasConflict: true }
  ]);

  assert.deepEqual(groups.pass.map((pr) => pr.number), [1]);
  assert.deepEqual(groups.noCi.map((pr) => pr.number), [2]);
  assert.deepEqual(groups.conflicts.map((pr) => pr.number), [4]);
});

test("pull requests without CI are classified instead of dropped", () => {
  const pr = classifyPullRequest({
    number: 12,
    title: "Docs update",
    url: "https://github.com/owner/a/pull/12",
    isDraft: false,
    mergeable: "MERGEABLE",
    author: { login: "dev" },
    repository: { nameWithOwner: "owner/a", isArchived: false },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: []
              }
            }
          }
        }
      ]
    }
  });

  assert.equal(pr.state, "pass");
  assert.equal(pr.checkCount, 0);
  assert.equal(pr.hasConflict, false);
});

test("pull request classification carries archived repo state", () => {
  const pr = classifyPullRequest({
    number: 13,
    title: "Archived repo update",
    url: "https://github.com/owner/old/pull/13",
    isDraft: false,
    mergeable: "MERGEABLE",
    author: { login: "dev" },
    repository: { nameWithOwner: "owner/old", isArchived: true },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: []
              }
            }
          }
        }
      ]
    }
  });

  assert.equal(pr.isArchived, true);
});

test("no-CI pull requests must be mergeable before merging", () => {
  assert.equal(
    mergeBlockReason({
      state: "pass",
      checkCount: 0,
      isDraft: false,
      hasConflict: false,
      mergeable: "MERGEABLE"
    }),
    ""
  );
  assert.equal(
    mergeBlockReason({
      state: "pass",
      checkCount: 0,
      isDraft: false,
      hasConflict: false,
      mergeable: "UNKNOWN"
    }),
    "This pull request is not currently mergeable."
  );
});

test("auto merge only targets passing pull requests with reported checks", () => {
  assert.equal(
    isAutoMergeCandidate({
      state: "pass",
      checkCount: 1,
      isDraft: false,
      hasConflict: false,
      mergeable: "MERGEABLE"
    }),
    true
  );
  assert.equal(
    isAutoMergeCandidate({
      state: "pass",
      checkCount: 0,
      isDraft: false,
      hasConflict: false,
      mergeable: "MERGEABLE"
    }),
    false
  );
});

test("open pull request searches exclude archived repositories", () => {
  assert.equal(openPullRequestSearchQuery("owner", "dev"), "is:pr state:open archived:false owner:dev");
  assert.equal(openPullRequestSearchQuery("author", "dev"), "is:pr state:open archived:false author:dev");
});

test("refresh recommendations pause when GitHub API quota is low", () => {
  const resetAt = new Date(Date.now() + 18 * 60 * 1000).toISOString();
  const rateLimit = {
    tightest: {
      resource: "core",
      remaining: 120,
      limit: 5000,
      resetAt
    }
  };

  const quota = quotaState(rateLimit);
  assert.equal(quota.status, "low");
  assert.equal(quota.blocked, true);

  const refresh = recommendRefresh(
    {
      runningPrs: 0,
      runningCd: 0,
      runningDeployments: 0,
      busyRunners: 0,
      failingPrs: 0,
      failedCd: 0
    },
    {
      mode: "all",
      includeCd: true,
      includeRepoRunners: false
    },
    rateLimit
  );

  assert.equal(refresh.quota.blocked, true);
  assert.equal(refresh.quota.resource, "core");
  assert.match(refresh.reason, /Paused for core API quota/);
  assert.ok(new Date(refresh.nextRefreshAt).getTime() >= new Date(resetAt).getTime());
});

test("production target scan finds deployable URLs in project code", () => {
  assert.equal(isProductionTargetScanPath("infra/cdk/app-stack.ts"), true);
  assert.equal(isProductionTargetScanPath("src/components/Button.tsx"), false);
  assert.deepEqual(
    extractProductionUrlsFromText("SITE_URL=https://safespendplan.com\nconst docs = 'https://docs.aws.amazon.com/foo'"),
    ["https://safespendplan.com", "https://docs.aws.amazon.com/foo"]
  );

  const best = bestProductionUrlCandidate([
    { url: "https://docs.aws.amazon.com/cloudfront/", source: "infra/README.md" },
    { url: "https://d111111abcdef8.cloudfront.net", source: "infra/cdk/app-stack.ts" },
    { url: "safespendplan-market-refresh.json", source: "infra/cdk/outputs.json" },
    { url: "deploy-frontend-stack.sh", source: "scripts/deploy.sh" },
    { url: "seo.sitemap", source: "public/sitemap.xml" },
    { url: "https://$api_domain", source: "scripts/deploy.sh" },
    { url: "certificate.domainvalidationoptions", source: "infra/cdk/app-stack.ts" },
    { url: "https://cloudfront.amazonaws.com", source: "infra/README.md" },
    { url: "https://webemail.local", source: "README.md" },
    { url: "safespendplan.com", source: "infra/cdk/app-stack.ts" },
    { url: "http://localhost:3000", source: "README.md" }
  ], "GipsyChef/safespendplan");

  assert.equal(best.url, "https://safespendplan.com/");
  assert.equal(best.source, "infra/cdk/app-stack.ts");
});

test("finished CD change summaries infer reviewable page links and cues", () => {
  assert.equal(publicRouteFromFile("app/settings/billing/page.tsx"), "/settings/billing");
  assert.equal(publicRouteFromFile("src/pages/docs/[slug].tsx"), "/docs/:slug");
  assert.equal(publicRouteFromFile("public/changelog.html"), "/changelog.html");
  assert.equal(publicRouteFromFile("pages/api/health.ts"), "");

  const summary = buildChangeSummary(
    "acme/app",
    {
      head_sha: "abcdef1234567890",
      display_title: "ship billing settings"
    },
    {
      sha: "abcdef1234567890",
      html_url: "https://github.com/acme/app/commit/abcdef1",
      stats: { additions: 18, deletions: 4 },
      commit: {
        message: "Improve billing settings\n\nBody",
        author: { name: "Dev" }
      },
      files: [
        {
          filename: "app/settings/billing/page.tsx",
          status: "modified",
          additions: 10,
          deletions: 2,
          changes: 12,
          blob_url: "https://github.com/acme/app/blob/abcdef1/app/settings/billing/page.tsx"
        },
        {
          filename: "app/settings/billing/styles.css",
          status: "modified",
          additions: 8,
          deletions: 2,
          changes: 10,
          blob_url: "https://github.com/acme/app/blob/abcdef1/app/settings/billing/styles.css"
        }
      ]
    },
    { url: "https://app.example.com", environment: "production" },
    {
      mergedPullRequests: [
        {
          pr: {
            number: 42,
            title: "Add billing summary",
            user: { login: "dev" },
            merged_at: "2026-05-20T10:00:00Z",
            html_url: "https://github.com/acme/app/pull/42"
          },
          files: [
            {
              filename: "app/settings/billing/page.tsx",
              status: "modified",
              additions: 5,
              deletions: 1,
              blob_url: "https://github.com/acme/app/blob/abcdef1/app/settings/billing/page.tsx"
            }
          ]
        }
      ]
    }
  );

  assert.equal(summary.shortSha, "abcdef1");
  assert.equal(summary.source, "commit");
  assert.equal(summary.filesChanged, 2);
  assert.equal(summary.message, "Improve billing settings");
  assert.equal(summary.changedPages.length, 1);
  assert.equal(summary.changedPages[0].url, "https://app.example.com/settings/billing");
  assert.match(summary.changedPages[0].lookFor, /rendered page/);
  assert.match(summary.changedFiles[1].lookFor, /Visual styling/);
  assert.equal(summary.mergedPullRequests.length, 1);
  assert.equal(summary.mergedPullRequests[0].numberLabel, "#42");
  assert.equal(summary.mergedPullRequests[0].changedPages[0].url, "https://app.example.com/settings/billing");

  const compareSummary = buildChangeSummary(
    "acme/app",
    {
      head_sha: "2222222222222222",
      display_title: "deploy multiple commits"
    },
    {
      html_url: "https://github.com/acme/app/compare/1111111...2222222",
      total_commits: 2,
      commits: [
        { commit: { message: "First", author: { name: "Dev" } } },
        { commit: { message: "Second", author: { name: "Dev" } } }
      ],
      files: [
        {
          filename: "app/page.tsx",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          blob_url: "https://github.com/acme/app/blob/2222222/app/page.tsx"
        }
      ]
    },
    { url: "https://app.example.com" },
    { source: "compare", baseSha: "1111111111111111" }
  );

  assert.equal(compareSummary.source, "compare");
  assert.equal(compareSummary.sourceLabel, "1111111...2222222");
  assert.equal(compareSummary.commitCount, 2);
  assert.equal(compareSummary.additions, 3);
  assert.equal(compareSummary.deletions, 1);
  assert.match(compareSummary.lookFor, /previous completed CD run/);

  const commitFallback = buildChangeSummary(
    "acme/app",
    {
      display_title: "deploy without diff",
      head_branch: "main"
    },
    null,
    { url: "https://app.example.com" },
    {
      recentCommits: [
        {
          sha: "3333333333333333",
          html_url: "https://github.com/acme/app/commit/3333333",
          commit: {
            message: "Ship homepage copy",
            author: { name: "Dev", date: "2026-05-20T12:00:00Z" }
          },
          files: [
            {
              filename: "app/page.tsx",
              status: "modified",
              additions: 4,
              deletions: 1,
              blob_url: "https://github.com/acme/app/blob/3333333/app/page.tsx"
            }
          ]
        }
      ]
    }
  );

  assert.equal(commitFallback.filesChanged, 0);
  assert.equal(commitFallback.recentCommits.length, 1);
  assert.equal(commitFallback.recentCommits[0].shortSha, "3333333");
  assert.equal(commitFallback.recentCommits[0].changedPages[0].url, "https://app.example.com/");
  assert.equal(commitFallback.reviewLinks.commitsUrl, "https://github.com/acme/app/commits/main");
  assert.match(commitFallback.lookFor, /recent commit summary/);

  const homepageTarget = buildChangeSummary(
    "acme/app",
    {
      display_title: "homepage deploy",
      head_branch: "main"
    },
    null,
    { url: "https://prod.example.com", environment: "production" },
    {
      mergedPullRequests: [
        {
          pr: {
            number: 7,
            title: "Change dashboard",
            user: { login: "dev" },
            merged_at: "2026-05-20T12:00:00Z",
            html_url: "https://github.com/acme/app/pull/7"
          },
          files: [
            {
              filename: "pages/dashboard.tsx",
              status: "modified",
              additions: 5,
              deletions: 1,
              blob_url: "https://github.com/acme/app/blob/head/pages/dashboard.tsx"
            }
          ]
        }
      ]
    }
  );

  assert.equal(homepageTarget.deployUrl, "https://prod.example.com");
  assert.equal(homepageTarget.mergedPullRequests[0].changedPages[0].url, "https://prod.example.com/dashboard");

  const inferredTarget = buildChangeSummary(
    "GipsyChef/safespendplan",
    {
      display_title: "deploy security fixes",
      head_branch: "main"
    },
    null,
    { url: "https://safespendplan.com/", environment: "production" },
    {
      mergedPullRequests: [
        {
          pr: {
            number: 118,
            title: "security: fix forgeable JWT key, magic-link race, plan IDOR",
            user: { login: "cigan1" },
            merged_at: "2026-05-20T12:00:00Z",
            html_url: "https://github.com/GipsyChef/safespendplan/pull/118"
          },
          files: [
            {
              filename: "src/auth/magic-link.ts",
              status: "modified",
              additions: 20,
              deletions: 4,
              blob_url: "https://github.com/GipsyChef/safespendplan/blob/head/src/auth/magic-link.ts"
            }
          ]
        }
      ]
    }
  );

  assert.equal(inferredTarget.mergedPullRequests[0].changedPages[0].url, "https://safespendplan.com/login");
  assert.equal(inferredTarget.mergedPullRequests[0].inferredPages, true);
});

test("page shell keeps accessible heading and button group semantics", () => {
  assert.match(indexHtml, /<h1 class="brand-name">PR Command Deck<\/h1>/);
  assert.doesNotMatch(indexHtml, /role="tablist"/);
  assert.match(indexHtml, /class="segmented" role="group" aria-label="Scope"/);
  assert.match(indexHtml, /data-mode="all" aria-pressed="true"/);
  assert.doesNotMatch(indexHtml, /class="grain"/);
});

test("page shell avoids external preconnect metadata links", () => {
  assert.doesNotMatch(indexHtml, /rel="preconnect"/);
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com/);
  assert.doesNotMatch(indexHtml, /fonts\.gstatic\.com/);
});

test("security headers restrict privileged local dashboard surfaces", () => {
  assert.match(SECURITY_HEADERS["content-security-policy"], /default-src 'self'/);
  assert.match(SECURITY_HEADERS["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(SECURITY_HEADERS["x-content-type-options"], "nosniff");
  assert.equal(SECURITY_HEADERS["referrer-policy"], "no-referrer");
});

test("runner status endpoint returns only busy runners", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": requestUrl.pathname === "/graphql" ? "graphql" : "core"
    };

    if (requestUrl.pathname === "/user") {
      return Response.json({ login: "maintainer" }, { headers });
    }
    if (requestUrl.pathname === "/user/orgs") {
      return Response.json([{ login: "acme" }], { headers });
    }
    if (requestUrl.pathname === "/graphql") {
      assert.match(body.variables.q, /is:pr state:open archived:false owner:/);
      return Response.json({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      }, { headers });
    }
    if (requestUrl.pathname === "/orgs/acme/actions/runners") {
      return Response.json({
        runners: [
          {
            name: "busy-linux",
            status: "online",
            busy: true,
            labels: [{ name: "self-hosted" }, { name: "linux" }]
          },
          {
            name: "idle-linux",
            status: "online",
            busy: false,
            labels: [{ name: "self-hosted" }]
          }
        ]
      }, { headers });
    }
    if (requestUrl.pathname === "/orgs/maintainer/actions/runners") {
      return Response.json({ runners: [] }, { headers });
    }

    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const { port } = testServer.address();
    const response = await previousFetch(`http://127.0.0.1:${port}/api/runners/status?mode=all&jobs=1`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.summary.busyRunners, 1);
    assert.deepEqual(data.runners.busy, [
      {
        level: "ORG",
        scope: "acme",
        name: "busy-linux",
        status: "online",
        labels: ["self-hosted", "linux"]
      }
    ]);
  } finally {
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("dashboard includes running non-CD workflow runs in CI running work", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : {};
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": requestUrl.pathname === "/graphql" ? "graphql" : "core"
    };

    if (requestUrl.pathname === "/user") {
      return Response.json({ login: "maintainer" }, { headers });
    }
    if (requestUrl.pathname === "/user/orgs") {
      return Response.json([{ login: "acme" }], { headers });
    }
    if (requestUrl.pathname === "/user/repos") {
      return Response.json([], { headers });
    }
    if (requestUrl.pathname === "/orgs/acme/repos") {
      return Response.json([
        { full_name: "acme/app", archived: false, owner: { login: "acme" } }
      ], { headers });
    }
    if (requestUrl.pathname === "/graphql") {
      assert.match(body.variables.q, /is:pr state:open archived:false owner:/);
      return Response.json({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      }, { headers });
    }
    if (requestUrl.pathname === "/repos/acme/app/actions/runs") {
      return Response.json({
        workflow_runs: [
          {
            name: "ci-lambdas",
            path: ".github/workflows/ci-lambdas.yml",
            status: "in_progress",
            created_at: "2026-05-18T20:00:00Z",
            run_number: 42,
            head_branch: "feature",
            display_title: "test lambdas",
            html_url: "https://github.com/acme/app/actions/runs/42"
          },
          {
            name: "Deploy",
            path: ".github/workflows/deploy.yml",
            status: "in_progress",
            created_at: "2026-05-18T20:01:00Z",
            run_number: 43,
            head_branch: "main",
            display_title: "deploy",
            html_url: "https://github.com/acme/app/actions/runs/43"
          },
          {
            name: "ci",
            path: ".github/workflows/ci.yml",
            status: "completed",
            created_at: "2026-05-18T20:02:00Z",
            run_number: 44,
            head_branch: "main",
            display_title: "done",
            html_url: "https://github.com/acme/app/actions/runs/44"
          }
        ]
      }, { headers });
    }

    return Response.json({ message: "not found" }, { status: 404, headers });
  };

  const testServer = await new Promise((resolve) => {
    const listener = server.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const { port } = testServer.address();
    const response = await previousFetch(`http://127.0.0.1:${port}/api/status?mode=all&includeCd=0&includeRunners=0&jobs=1`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.summary.runningPrs, 1);
    assert.deepEqual(data.actions.running, [
      {
        kind: "workflowRun",
        createdAt: "2026-05-18T20:00:00Z",
        repo: "acme/app",
        workflow: "ci-lambdas",
        runNumber: "#42",
        status: "in_progress",
        branch: "feature",
        title: "test lambdas",
        url: "https://github.com/acme/app/actions/runs/42"
      }
    ]);
  } finally {
    await new Promise((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});
