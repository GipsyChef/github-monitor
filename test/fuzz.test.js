import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { groupPullRequests } from "../server.js";

const prArbitrary = fc.record({
  repo: fc
    .tuple(fc.stringMatching(/[a-z0-9._-]{1,12}/), fc.stringMatching(/[a-z0-9._-]{1,12}/))
    .map(([owner, repo]) => `${owner}/${repo}`),
  number: fc.integer({ min: 1, max: 100000 }),
  state: fc.constantFrom("pass", "fail", "running", "unknown"),
  checkCount: fc.integer({ min: 0, max: 50 }),
  isDraft: fc.boolean(),
  hasConflict: fc.boolean()
});

test("fuzz pull request grouping invariants", () => {
  fc.assert(
    fc.property(fc.array(prArbitrary, { maxLength: 100 }), (pullRequests) => {
      const groups = groupPullRequests(pullRequests);
      const categorized = Object.values(groups).flat();

      assert.equal(new Set(categorized).size, categorized.length);
      assert.ok(groups.pass.every((pr) => pr.state === "pass" && pr.checkCount > 0 && !pr.hasConflict));
      assert.ok(groups.noCi.every((pr) => pr.state === "pass" && pr.checkCount === 0 && !pr.isDraft && !pr.hasConflict));
      assert.ok(groups.fail.every((pr) => pr.state === "fail" && !pr.hasConflict));
      assert.ok(groups.running.every((pr) => pr.state === "running" && !pr.hasConflict));
      assert.deepEqual(groups.conflicts, pullRequests.filter((pr) => pr.hasConflict).sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number));
    })
  );
});
