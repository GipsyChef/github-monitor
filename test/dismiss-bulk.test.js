// Regression coverage for the "Dismiss all" / "Restore all" bulk controls and
// the trace-filter-bar count sync. The dashboard UI lives in public/app.js as a
// non-modular browser script, so this drives the real page through Playwright
// with every network call mocked — no server, no GitHub, fully deterministic.
//
// Covers:
//   1. "Dismiss all" only appears when >= 2 actionable rows are visible (a lone
//      row keeps just its own per-row Dismiss button).
//   2. "Dismiss all" dismisses every visible dismissable row; the bar flips to
//      the "N dismissed items / Show / Restore all" state.
//   3. The trace sub-tab pill count reflects locally dismissed journeys (the
//      previously-broken raw-summary count, now sourced from displayCounts).
//   4. "Restore all" brings every dismissed row back and restores the counts.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

// These tests drive a real Chromium via Playwright. CI installs the browser
// (see .github/workflows/ci.yml); when it is missing locally, skip with a clear
// hint instead of failing with Playwright's raw "Executable doesn't exist" error.
let browserMissing = false;
try {
  browserMissing = !existsSync(chromium.executablePath());
} catch {
  browserMissing = true;
}
const skip = browserMissing
  ? "Playwright Chromium not installed — run: npx playwright install chromium"
  : false;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(root, "public/index.html"), "utf8");
const appJs = readFileSync(path.join(root, "public/app.js"), "utf8");
const stylesCss = readFileSync(path.join(root, "public/styles.css"), "utf8");

function trace(status, repo, n) {
  return {
    id: `${repo}#${n}`,
    repo,
    prNumber: n,
    numberLabel: `#${n}`,
    title: `PR ${n} on ${repo}`,
    author: "tester",
    prUrl: `https://github.com/${repo}/pull/${n}`,
    headSha: "abc123",
    baseRef: "main",
    startedAt: "2026-06-04T10:00:00Z",
    lastEvidenceAt: "2026-06-04T10:00:00Z",
    evidence: [],
    rule: { source: "auto" },
    stage: "cd_started",
    status,
    severity: status === "flagged" ? "high" : "low",
    reason: "test reason",
    nextAction: { label: "Open PR", url: `https://github.com/${repo}/pull/${n}` },
    stages: [
      { key: "pr_opened", label: "PR opened", status: "complete", at: "", url: "" },
      { key: "ci_complete", label: "CI complete", status: "complete", at: "", url: "" },
      { key: "merged", label: "Merged", status: "complete", at: "2026-06-04T10:00:00Z", url: "" },
      { key: "cd_started", label: "CD started", status: status === "flagged" ? "blocked" : "unknown", at: "", url: "" },
      { key: "prod_complete", label: "Production complete", status: status === "flagged" ? "missing" : "unknown", at: "", url: "" }
    ]
  };
}

// One flagged journey (single dismissable row) and three unknown journeys.
const statusFixture = {
  account: "test-account",
  accounts: ["test-account"],
  generatedAt: "2026-06-04T12:00:00Z",
  warnings: [],
  options: {},
  autoMerge: { enabled: false, items: [] },
  summary: {
    repos: 4,
    passingPrs: 0, noCiPrs: 0, failingPrs: 0, conflictPrs: 0, runningPrs: 0,
    runningCd: 0, finishedCd: 0, failedCd: 0, skippedCd: 0,
    runningDeployments: 0, busyRunners: 0,
    flaggedJourneys: 1, activeJourneys: 0, shippedJourneys: 0, tracingUnknown: 3
  },
  pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
  actions: { failed: [], running: [] },
  cd: { running: [], finished: [], failed: [] },
  deployments: { running: [] },
  runners: { busy: [] },
  traces: {
    flagged: [trace("flagged", "acme/alpha", 1)],
    active: [],
    completed: [],
    unknown: [
      trace("unknown", "acme/bravo", 2),
      trace("unknown", "acme/charlie", 3),
      trace("unknown", "acme/delta", 4)
    ]
  },
  refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
  rateLimit: { core: { remaining: 5000, limit: 5000 } }
};

function workflowRun(repo, runNumber) {
  return {
    kind: "workflowRun",
    repo,
    workflow: "CI",
    runNumber,
    title: `CI run ${runNumber} on ${repo}`,
    branch: "main",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-06-04T11:00:00Z",
    url: `https://github.com/${repo}/actions/runs/${runNumber}`
  };
}

async function openDashboard({ view = "pipelineTraces", failedRuns = [] } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Inject the requested starting view + clean stores before app.js runs.
  await page.addInitScript((startView) => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: startView, traceFilter: "flagged" }));
    localStorage.removeItem("pr-deck:dismissed:v1");
    localStorage.removeItem("pr-deck:traces:v1");
  }, view);

  const statusBody = failedRuns.length
    ? { ...statusFixture, actions: { ...statusFixture.actions, failed: failedRuns } }
    : statusFixture;

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/" || p === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (p === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (p === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (p === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(statusBody) });
    if (p === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    // Stub every other API call (auto-merge config, etc.) with empty JSON.
    if (p.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector(view === "pipelineTraces" ? ".trace-filterbar" : "#content");
  return { browser, page };
}

const pillCount = (page, key) =>
  page.locator(`.trace-filterbar button[data-trace-filter="${key}"] strong`).innerText();

test("Dismiss all is hidden when only one dismissable row is visible", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    // Default sub-tab is "flagged" with a single journey.
    assert.equal(await pillCount(page, "flagged"), "1");
    assert.equal(await page.locator("article.trace-card").count(), 1);
    assert.equal(await page.locator(".row-dismiss").count(), 1, "row keeps its own Dismiss button");
    assert.equal(await page.locator("[data-dismiss-all]").count(), 0, "no bulk control for a lone row");
  } finally {
    await browser.close();
  }
});

test("Dismiss all clears the lane and Restore all brings it back, with synced pill counts", { skip }, async () => {
  const { browser, page } = await openDashboard();
  try {
    // Switch to the unknown sub-tab (three journeys).
    await page.click('button[data-trace-filter="unknown"]');
    await page.waitForSelector("[data-dismiss-all]");

    assert.equal(await pillCount(page, "unknown"), "3");
    assert.equal(await page.locator("article.trace-card").count(), 3);
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /3 items shown/);

    // Dismiss all three at once.
    await page.click("[data-dismiss-all]");
    await page.waitForSelector("[data-restore-all]");

    assert.equal(await page.locator("article.trace-card").count(), 0, "all rows hidden after dismiss all");
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /3 dismissed items/);
    assert.equal(await page.locator("[data-dismiss-all]").count(), 0, "Dismiss all gone once nothing is actionable");
    assert.equal(await page.locator("[data-dismiss-toggle]").count(), 1, "Show toggle present");
    // The count-sync fix: the sub-tab pill reflects the dismissals, not the raw summary.
    assert.equal(await pillCount(page, "unknown"), "0", "unknown pill drops to 0 after dismiss all");

    // Restore all three.
    await page.click("[data-restore-all]");
    await page.waitForSelector("[data-dismiss-all]");

    assert.equal(await page.locator("article.trace-card").count(), 3, "rows return after restore all");
    assert.equal(await pillCount(page, "unknown"), "3", "unknown pill returns to 3");
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /3 items shown/);
    assert.equal(await page.locator("[data-restore-all]").count(), 0, "Restore all gone once nothing is dismissed");
  } finally {
    await browser.close();
  }
});

test("Dismiss all works on the Failing CI lane (workflow-run rows)", { skip }, async () => {
  const { browser, page } = await openDashboard({
    view: "fail",
    failedRuns: [workflowRun("acme/alpha", 101), workflowRun("acme/bravo", 102)]
  });
  try {
    await page.waitForSelector("[data-dismiss-all]");
    assert.equal(await page.locator("[data-dismiss-key]").count(), 2, "both failing runs show a per-row Dismiss");
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /2 items shown/);

    await page.click("[data-dismiss-all]");
    await page.waitForSelector("[data-restore-all]");
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /2 dismissed items/);
    assert.equal(await page.locator("[data-dismiss-key]").count(), 0, "no actionable rows remain visible");

    await page.click("[data-restore-all]");
    await page.waitForSelector("[data-dismiss-all]");
    assert.equal(await page.locator("[data-dismiss-key]").count(), 2, "both runs restored");
  } finally {
    await browser.close();
  }
});
