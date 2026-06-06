// Regression coverage for the "same old pipeline keeps notifying" bug.
//
// Reported symptom: the inbox kept filling with the SAME "Pipeline flagged"
// notifications "again and again", for activities that happened days ago.
//
// Two distinct causes, both fixed in public/app.js:
//   1. No persisted "already announced" ledger. notifyCompletedActions decides a
//      flag is new by diffing the in-memory activity snapshot, which is null on
//      every reload and forgets a trace that briefly drops out of the scan
//      window. So a flagged pipeline that flickers out and back re-notifies every
//      time it reappears. Fixed with a localStorage notified-tag ledger
//      (pr-deck:notified:v1) consulted in sendPopup, kept warm while the
//      condition persists.
//   2. No freshness gate. A pipeline whose latest evidence is days old still
//      popped the moment it was first seen in a session. Fixed by suppressing
//      notifications whose evidence timestamp is older than NOTIFY_STALE_EVENT_MS.
//
// Network is fully mocked, so no server and no GitHub are needed. The mocked
// /api/status body is mutable between scans so we can model a trace transitioning
// active -> flagged, flickering out, and coming back. Timestamps are computed
// relative to the real clock so the freshness gate is deterministic regardless of
// wall-clock date. A scan completes synchronously through render(), which runs
// AFTER the notification pass, so waiting for the rendered trace cards to match a
// round is a reliable barrier that the inbox write for that scan already happened.

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

const DAY_MS = 24 * 60 * 60 * 1000;

function trace(status, repo, n, lastEvidenceAt) {
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
    startedAt: lastEvidenceAt,
    lastEvidenceAt,
    evidence: [],
    rule: { source: "auto" },
    stage: "cd_started",
    status,
    severity: status === "flagged" ? "high" : "low",
    reason: "Merged PR has no matching production CD run yet.",
    nextAction: { label: "Open PR", url: `https://github.com/${repo}/pull/${n}` },
    stages: [
      { key: "merged", label: "Merged", status: "complete", at: lastEvidenceAt, url: "" },
      { key: "cd_started", label: "CD started", status: status === "flagged" ? "blocked" : "unknown", at: "", url: "" }
    ]
  };
}

function baseStatus(traceGroups) {
  return {
    account: "test-account",
    accounts: ["test-account"],
    generatedAt: new Date().toISOString(),
    warnings: [],
    options: {},
    autoMerge: { enabled: false, items: [] },
    summary: {
      repos: 1,
      passingPrs: 0, noCiPrs: 0, failingPrs: 0, conflictPrs: 0, runningPrs: 0,
      runningCd: 0, finishedCd: 0, failedCd: 0, skippedCd: 0,
      runningDeployments: 0, busyRunners: 0,
      flaggedJourneys: 0, activeJourneys: 0, shippedJourneys: 0, tracingUnknown: 0
    },
    pullRequests: { pass: [], noCi: [], fail: [], running: [], conflicts: [] },
    actions: { failed: [], running: [] },
    cd: { running: [], finished: [], failed: [] },
    deployments: { running: [] },
    runners: { busy: [] },
    traces: { flagged: [], active: [], completed: [], unknown: [], ...traceGroups },
    refresh: { quota: { status: "ok" }, nextRefreshAt: null, reason: "" },
    rateLimit: { core: { remaining: 5000, limit: 5000 } }
  };
}

// Opens the dashboard on the pipeline-traces view, flagged filter, with a mutable
// status body. Mutate `box.status` then call scan() to push the next snapshot.
async function openDashboard(initialStatus) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const box = { status: initialStatus };

  await page.addInitScript(() => {
    localStorage.setItem(
      "pr-deck:v1",
      JSON.stringify({ view: "pipelineTraces", traceFilter: "flagged" })
    );
  });

  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/" || p === "/index.html") return route.fulfill({ contentType: "text/html", body: indexHtml });
    if (p === "/app.js") return route.fulfill({ contentType: "text/javascript", body: appJs });
    if (p === "/styles.css") return route.fulfill({ contentType: "text/css", body: stylesCss });
    if (p === "/api/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify(box.status) });
    if (p === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    if (p.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("http://localhost/");
  await page.waitForSelector("#content");
  return { browser, page, box };
}

// Pushes a new snapshot and waits until the rendered flagged-trace cards reflect
// it. render() runs after the notification pass, so once the DOM settles the
// inbox write for this scan is already done.
async function scan(page, box, nextStatus, expectedFlaggedCards) {
  box.status = nextStatus;
  await page.click("#refresh");
  await page.waitForFunction(
    (n) => document.querySelectorAll("article.trace-card").length === n,
    expectedFlaggedCards
  );
}

const flaggedInboxCount = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("pr-deck:inbox:v1") || "[]").filter(
      (item) => item.title === "Pipeline flagged"
    ).length
  );

test("a flagged pipeline that flickers out and back is announced only once", { skip }, async () => {
  const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago — fresh
  const active = baseStatus({ active: [trace("active", "acme/alpha", 7, recent)] });
  const flagged = baseStatus({ flagged: [trace("flagged", "acme/alpha", 7, recent)] });
  const gone = baseStatus({}); // trace absent from the scan entirely

  const { browser, page, box } = await openDashboard(active);
  try {
    // First scan happened on load with the trace merely active: no notification,
    // and nothing under the flagged filter.
    assert.equal(await flaggedInboxCount(page), 0, "no notification while only active");

    // active -> flagged: this is a real transition and SHOULD announce once.
    await scan(page, box, flagged, 1);
    assert.equal(await flaggedInboxCount(page), 1, "first flag announced exactly once");

    // Trace drops out of the server's scan window (flicker out).
    await scan(page, box, gone, 0);

    // ...and comes back flagged. Pre-fix this re-announced because the snapshot
    // had forgotten it. The persisted ledger must keep the inbox at one entry.
    await scan(page, box, flagged, 1);
    assert.equal(
      await flaggedInboxCount(page),
      1,
      "the same flagged pipeline must NOT re-announce when it flickers back"
    );

    // A full reload (server restart) must also not resurrect the announcement.
    await page.reload();
    await page.waitForSelector("#content");
    await page.waitForFunction(() => document.querySelectorAll("article.trace-card").length === 1);
    await scan(page, box, flagged, 1);
    assert.equal(
      await flaggedInboxCount(page),
      1,
      "the announcement survives reload as a single inbox entry"
    );
  } finally {
    await browser.close();
  }
});

test("a pipeline whose evidence is days old is never announced", { skip }, async () => {
  const old = new Date(Date.now() - 5 * DAY_MS).toISOString(); // older than the freshness window
  const active = baseStatus({ active: [trace("active", "acme/bravo", 9, old)] });
  const flagged = baseStatus({ flagged: [trace("flagged", "acme/bravo", 9, old)] });

  const { browser, page, box } = await openDashboard(active);
  try {
    assert.equal(await flaggedInboxCount(page), 0, "no notification while only active");

    // active -> flagged, but the evidence is 5 days old. The card still renders,
    // yet the stale event must NOT produce a notification.
    await scan(page, box, flagged, 1);
    assert.equal(
      await flaggedInboxCount(page),
      0,
      "a days-old flagged pipeline must not announce itself"
    );
  } finally {
    await browser.close();
  }
});
