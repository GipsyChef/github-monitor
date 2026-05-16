import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SECURITY_HEADERS,
  classifyPullRequest,
  groupPullRequests,
  isAutoMergeCandidate,
  mergeBlockReason,
  openPullRequestSearchQuery
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
