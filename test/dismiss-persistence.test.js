// Regression coverage for dismiss PERSISTENCE across a server restart.
//
// Reported symptom: "When I dismiss something it should remain dismissed even if
// I restart the server." Dismissals are a local-first, per-browser view
// preference kept in localStorage (key pr-deck:dismissed:v1) — see the
// state-architecture note in the README. Restarting the server must not lose
// them: the browser keeps localStorage, and on the next load the server returns
// fresh data with STABLE identifiers, so dismiss keys still match and the item
// stays hidden.
//
// A server restart is modelled here as a full page reload: the browser re-fetches
// /, /app.js, and /api/status (all served fresh, same data), while localStorage
// survives — exactly what happens when the user keeps the tab open / refreshes
// after `node server.js` is restarted. Network is fully mocked, so no server and
// no GitHub are needed and the run is deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

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
    flaggedJourneys: 0, activeJourneys: 0, shippedJourneys: 0, tracingUnknown: 3
  },
  pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
  actions: { failed: [], running: [] },
  cd: { running: [], finished: [], failed: [] },
  deployments: { running: [] },
  runners: { busy: [] },
  traces: {
    flagged: [],
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

// Opens the dashboard with the network mocked. Crucially — unlike the bulk-
// controls test — this does NOT clear pr-deck:dismissed:v1 on every navigation,
// so a page reload preserves dismissals exactly like a real browser would across
// a server restart. The browser context starts with empty storage anyway.
async function openDashboard({ view = "fail", failedRuns = [], dismissed = {} } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.addInitScript((startView) => {
    localStorage.setItem("pr-deck:v1", JSON.stringify({ view: startView, traceFilter: "unknown" }));
  }, view);

  if (Object.keys(dismissed).length) {
    await page.addInitScript((items) => {
      localStorage.setItem("pr-deck:dismissed:v1", JSON.stringify(items));
    }, dismissed);
  }

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
    if (p.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector("#content");
  return { browser, page };
}

const readDismissedKeys = (page) =>
  page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("pr-deck:dismissed:v1") || "{}")));

const pillCount = (page, key) =>
  page.locator(`.trace-filterbar button[data-trace-filter="${key}"] strong`).innerText();

test("a dismissed failing-CI run stays dismissed after a server restart (reload)", { skip }, async () => {
  const { browser, page } = await openDashboard({
    view: "fail",
    failedRuns: [workflowRun("acme/alpha", 101), workflowRun("acme/bravo", 102)]
  });
  try {
    await page.waitForSelector("[data-dismiss-key]");
    assert.equal(await page.locator("[data-dismiss-key]").count(), 2, "both failing runs visible at first");

    // Dismiss the first run.
    await page.locator("[data-dismiss-key]").first().click();
    await page.waitForFunction(() => document.querySelectorAll("[data-dismiss-key]").length === 1);
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /1 dismissed item/);

    const keysBefore = await readDismissedKeys(page);
    assert.equal(keysBefore.length, 1, "exactly one dismiss key persisted to localStorage");

    // Restart the server === reload the page: app.js reruns, /api/status returns
    // the same data, dismissals are reloaded from localStorage.
    await page.reload();
    await page.waitForSelector("#content");
    await page.waitForFunction(() => document.querySelectorAll("[data-dismiss-key]").length === 1);

    assert.equal(
      await page.locator("[data-dismiss-key]").count(),
      1,
      "dismissed run must NOT reappear after restart"
    );
    assert.match(
      await page.locator(".dismiss-bar-label").innerText(),
      /1 dismissed item/,
      "dismiss bar still reports the dismissal after restart"
    );
    assert.deepEqual(await readDismissedKeys(page), keysBefore, "dismiss key is stable across restart");
  } finally {
    await browser.close();
  }
});

test("dismissed pipeline traces stay dismissed after a server restart (reload)", { skip }, async () => {
  const { browser, page } = await openDashboard({ view: "pipelineTraces" });
  try {
    await page.click('button[data-trace-filter="unknown"]');
    await page.waitForSelector("[data-dismiss-all]");
    assert.equal(await page.locator("article.trace-card").count(), 3, "three unknown journeys visible");

    // Dismiss all three.
    await page.click("[data-dismiss-all]");
    await page.waitForSelector("[data-restore-all]");
    assert.equal(await page.locator("article.trace-card").count(), 0, "all three hidden after dismiss all");

    const keysBefore = await readDismissedKeys(page);
    assert.equal(keysBefore.length, 3, "three trace dismiss keys persisted");

    // Restart === reload.
    await page.reload();
    await page.click('button[data-trace-filter="unknown"]');
    await page.waitForSelector("#content");

    assert.equal(
      await page.locator("article.trace-card").count(),
      0,
      "dismissed traces must NOT reappear after restart"
    );
    assert.deepEqual(await readDismissedKeys(page), keysBefore, "trace dismiss keys stable across restart");

    // And they are still reversible after the restart.
    await page.waitForSelector("[data-restore-all]");
    await page.click("[data-restore-all]");
    await page.waitForSelector("[data-dismiss-all]");
    assert.equal(await page.locator("article.trace-card").count(), 3, "Restore all still works post-restart");
    assert.deepEqual(await readDismissedKeys(page), [], "localStorage cleared of dismissals after restore");
  } finally {
    await browser.close();
  }
});

test("legacy trace dismiss keys still hide the same PR journey", { skip }, async () => {
  const { browser, page } = await openDashboard({
    view: "pipelineTraces",
    dismissed: { "trace:acme/bravo:2": "2026-06-10T12:00:00Z" }
  });
  try {
    await page.click('button[data-trace-filter="unknown"]');
    await page.waitForSelector("#content");

    assert.equal(await page.locator("article.trace-card").count(), 2, "legacy-dismissed journey stays hidden");
    assert.equal(await pillCount(page, "unknown"), "2", "legacy dismissal is reflected in the sub-tab count");
    assert.match(await page.locator(".dismiss-bar-label").innerText(), /1 dismissed item/);

    await page.click("[data-restore-all]");
    await page.waitForSelector("[data-dismiss-all]");

    assert.equal(await page.locator("article.trace-card").count(), 3, "restore all removes the legacy dismissal");
    assert.deepEqual(await readDismissedKeys(page), [], "legacy key is removed from localStorage");
  } finally {
    await browser.close();
  }
});
