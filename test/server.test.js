import test from "node:test";
import assert from "node:assert/strict";

import { groupPullRequests } from "../server.js";

test("conflicted pull requests are excluded from CI status buckets", () => {
  const groups = groupPullRequests([
    { repo: "owner/a", number: 1, state: "pass", hasConflict: false },
    { repo: "owner/a", number: 2, state: "pass", hasConflict: true },
    { repo: "owner/a", number: 3, state: "fail", hasConflict: true },
    { repo: "owner/a", number: 4, state: "running", hasConflict: true }
  ]);

  assert.deepEqual(groups.pass.map((pr) => pr.number), [1]);
  assert.deepEqual(groups.fail.map((pr) => pr.number), []);
  assert.deepEqual(groups.running.map((pr) => pr.number), []);
  assert.deepEqual(groups.conflicts.map((pr) => pr.number), [2, 3, 4]);
});
