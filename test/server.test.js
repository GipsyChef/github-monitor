import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SECURITY_HEADERS,
  classifyPullRequest,
  groupPullRequests,
  isAutoMergeCandidate,
  mergeBlockReason,
  openPullRequestSearchQuery,
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
