const STORAGE_KEY = "pr-deck:v1";
const INBOX_KEY = "pr-deck:inbox:v1";
const INBOX_MAX = 60;
const INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
const QUOTA_SLOW_REMAINING = 200;
const QUOTA_SLOW_RATIO = 0.15;

const persisted = loadPersisted();

const state = {
  data: null,
  mode: persisted.mode || "all",
  view: persisted.view || "fail",
  filter: persisted.filter || "",
  notifications: persisted.notifications !== false,
  activitySnapshot: null,
  refreshTimer: null,
  refreshRetryCount: 0,
  loading: false,
  countdownTimer: null,
  nextRefreshAt: null,
  refreshReason: "",
  inboxOpen: false,
  inbox: loadInbox(),
  autoMerge: persisted.autoMerge === true,
  merging: new Set(),
  merged: new Set(),
  closing: new Set(),
  closed: new Set(),
  autoMerges: new Map(),
  autoMergeTicker: null,
  autoMergeFollowUpTimer: null
};

const views = {
  fail: {
    kicker: "Failing CI",
    title: "PRs that need attention",
    empty: "Nothing failing. Quiet day on the desk.",
    color: "red",
    rows: (data) => data.pullRequests.fail
  },
  conflicts: {
    kicker: "Merge conflicts",
    title: "PRs blocked until rebased",
    empty: "No PRs with merge conflicts.",
    color: "red",
    rows: (data) => data.pullRequests.conflicts || []
  },
  running: {
    kicker: "Open PRs with CI running",
    title: "Checks still in motion",
    empty: "No checks or workflow runs currently running.",
    color: "amber",
    rows: (data) => [...(data.pullRequests.running || []), ...(data.actions?.running || [])]
  },
  pass: {
    kicker: "Passing CI",
    title: "Ready PRs with completed checks",
    empty: "No PRs passing CI yet.",
    color: "green",
    rows: (data) => data.pullRequests.pass
  },
  noCi: {
    kicker: "No CI",
    title: "Ready PRs without reported checks",
    empty: "No ready PRs without CI.",
    color: "gray",
    rows: (data) => data.pullRequests.noCi || []
  },
  runningCd: {
    kicker: "Running CD Actions",
    title: "Deploy and release workflows in progress",
    empty: "Nothing deploying right now.",
    color: "blue",
    rows: (data) => data.cd.running
  },
  finishedCd: {
    kicker: "Finished CD Actions",
    title: "Deploy and release workflows finished in the last day",
    empty: "No CD actions finished in the last day.",
    color: "green",
    rows: (data) => data.cd.finished || []
  },
  deployments: {
    kicker: "Running Deployments",
    title: "GitHub deployments not finished yet",
    empty: "No active deployments.",
    color: "violet",
    rows: (data) => data.deployments.running
  },
  runners: {
    kicker: "Busy Self-hosted Runners",
    title: "Runner capacity currently occupied",
    empty: "All self-hosted runners are idle.",
    color: "gray",
    rows: (data) => data.runners.busy
  },
  failedCd: {
    kicker: "Failed CD Actions",
    title: "CD workflows still failing",
    empty: "No CD workflows are still failing.",
    color: "ink",
    rows: (data) => data.cd.failed
  }
};

const viewOrder = ["fail", "conflicts", "running", "pass", "noCi", "runningCd", "finishedCd", "deployments", "runners", "failedCd"];

const els = {
  account: document.querySelector("#account"),
  generatedAt: document.querySelector("#generatedAt"),
  includeCd: document.querySelector("#includeCd"),
  includeRunners: document.querySelector("#includeRunners"),
  autoRefresh: document.querySelector("#autoRefresh"),
  autoMerge: document.querySelector("#autoMerge"),
  notifications: document.querySelector("#notifications"),
  refresh: document.querySelector("#refresh"),
  nextRefresh: document.querySelector("#nextRefresh"),
  rateLimit: document.querySelector("#rateLimit"),
  loading: document.querySelector("#loading"),
  errorPanel: document.querySelector("#errorPanel"),
  content: document.querySelector("#content"),
  viewKicker: document.querySelector("#viewKicker"),
  viewTitle: document.querySelector("#viewTitle"),
  filter: document.querySelector("#filter"),
  filterClear: document.querySelector("#filterClear"),
  filterCount: document.querySelector("#filterCount"),
  toastRegion: document.querySelector("#toastRegion"),
  inboxToggle: document.querySelector("#inboxToggle"),
  inboxBadge: document.querySelector("#inboxBadge"),
  inboxPanel: document.querySelector("#inboxPanel"),
  inboxHeading: document.querySelector("#inboxHeading"),
  inboxList: document.querySelector("#inboxList"),
  inboxEmpty: document.querySelector("#inboxEmpty"),
  inboxMarkAll: document.querySelector("#inboxMarkAll"),
  inboxClear: document.querySelector("#inboxClear")
};

const metricIds = {
  passingPrs: "metricPassing",
  noCiPrs: "metricNoCi",
  failingPrs: "metricFailing",
  conflictPrs: "metricConflicts",
  runningPrs: "metricRunning",
  runningCd: "metricCd",
  finishedCd: "metricFinishedCd",
  failedCd: "metricFailedCd",
  repos: "metricRepos"
};

const navIds = {
  pass: "navPass",
  noCi: "navNoCi",
  fail: "navFail",
  conflicts: "navConflicts",
  running: "navRunning",
  runningCd: "navRunningCd",
  finishedCd: "navFinishedCd",
  deployments: "navDeployments",
  runners: "navRunners",
  failedCd: "navFailedCd"
};

let lastGeneratedAt = null;
let generatedTicker = null;
const notificationWorkerPromise = "serviceWorker" in navigator
  ? navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
  : Promise.resolve(null);

function loadPersisted() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function loadInbox() {
  try {
    const raw = JSON.parse(localStorage.getItem(INBOX_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const pruned = pruneInbox(raw);
    if (pruned.length !== raw.length) {
      localStorage.setItem(INBOX_KEY, JSON.stringify(pruned));
    }
    return pruned;
  } catch {
    return [];
  }
}

function pruneInbox(items) {
  const cutoff = Date.now() - INBOX_TTL_MS;
  return items
    .filter((item) => {
      const time = new Date(item?.at || 0).getTime();
      return Number.isFinite(time) && time >= cutoff;
    })
    .slice(0, INBOX_MAX);
}

function saveInbox() {
  try {
    state.inbox = pruneInbox(state.inbox);
    localStorage.setItem(INBOX_KEY, JSON.stringify(state.inbox.slice(0, INBOX_MAX)));
  } catch {}
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: state.mode,
        view: state.view,
        filter: state.filter,
        autoMerge: state.autoMerge,
        notifications: state.notifications
      })
    );
  } catch {}
}

function isBackendUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    return parts.some((part) =>
      part === "api" ||
      part === "backend" ||
      part === "srv" ||
      part.startsWith("api-") ||
      part.endsWith("-api") ||
      part.startsWith("backend-") ||
      part.endsWith("-backend")
    );
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatRelative(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  const diff = Date.now() - date.getTime();
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return formatTime(value);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return `${hours}h ${restMinutes}m`;
  }
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function rowText(row) {
  return flattenText(row).join(" ").toLowerCase();
}

function flattenText(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [String(value)];
}

function actionKey(row) {
  return row?.url || [row?.repo, row?.workflow, row?.runNumber, row?.number].filter(Boolean).join(":");
}

function prKey(row) {
  return row?.url || `${row?.repo || ""}#${row?.number || ""}`;
}

function mergeKey(repo, number) {
  return `${repo || ""}#${number || ""}`;
}

function autoMergeRemainingSeconds(key) {
  const entry = state.autoMerges.get(key);
  if (!entry) return null;
  return Math.max(0, Math.ceil((entry.deadline - Date.now()) / 1000));
}

function clearAutoMerge(key) {
  state.autoMerges.delete(key);
  stopAutoMergeTickerIfIdle();
}

function ensureAutoMergeTicker() {
  if (state.autoMergeTicker) return;
  state.autoMergeTicker = setInterval(updateAutoMergeButtons, 1000);
}

function stopAutoMergeTickerIfIdle() {
  if (state.autoMerges.size || !state.autoMergeTicker) return;
  clearInterval(state.autoMergeTicker);
  state.autoMergeTicker = null;
  clearAutoMergeFollowUp();
}

function autoMergeButtonLabel(key) {
  const remaining = autoMergeRemainingSeconds(key);
  if (remaining == null) return "Merge";
  return remaining > 0 ? `Auto merge in ${remaining}s` : "Merging";
}

function ensureAutoMergeFollowUp() {
  if (state.autoMergeFollowUpTimer) return;
  state.autoMergeFollowUpTimer = setTimeout(async () => {
    try {
      await refreshAfterMutation("auto-merge-status");
    } finally {
      state.autoMergeFollowUpTimer = null;
    }
  }, 4000);
}

function clearAutoMergeFollowUp() {
  if (!state.autoMergeFollowUpTimer) return;
  clearTimeout(state.autoMergeFollowUpTimer);
  state.autoMergeFollowUpTimer = null;
}

function updateAutoMergeButtons() {
  let hasMerging = false;
  document.querySelectorAll(".merge-button[data-auto-merge='true']").forEach((button) => {
    const key = mergeKey(button.dataset.repo, button.dataset.number);
    const label = autoMergeButtonLabel(key);
    const isPending = label === "Merging";
    if (isPending) hasMerging = true;
    button.textContent = label;
    button.setAttribute(
      "aria-label",
      `${label} ${button.dataset.repo || ""} #${button.dataset.number || ""}`.trim()
    );
    button.title = isPending ? "Merging pull request..." : "Automatically merge when the timer reaches zero";
    if (isPending) button.disabled = true;
  });
  if (hasMerging) ensureAutoMergeFollowUp();
  else clearAutoMergeFollowUp();
  stopAutoMergeTickerIfIdle();
}

function syncAutoMerges(data) {
  state.autoMerges.clear();
  if (!state.autoMerge) {
    updateAutoMergeButtons();
    return;
  }

  for (const candidate of data?.autoMerge?.candidates || []) {
    const deadline = new Date(candidate.deadline).getTime();
    if (!Number.isFinite(deadline)) continue;
    state.autoMerges.set(mergeKey(candidate.repo, candidate.number), {
      deadline,
      error: candidate.error || ""
    });
  }
  if (state.autoMerges.size) ensureAutoMergeTicker();
  else stopAutoMergeTickerIfIdle();
  updateAutoMergeButtons();
}

function applyAutoMergeSnapshot(snapshot) {
  if (!snapshot) return;
  state.autoMerge = Boolean(snapshot.enabled);
  els.autoMerge.checked = state.autoMerge;
  syncAutoMerges({ autoMerge: snapshot });
  persist();
}

async function configureServerAutoMerge() {
  const response = await fetch("/api/auto-merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: state.autoMerge,
      mode: state.mode,
      jobs: 4
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Unable to configure auto merge");
  applyAutoMergeSnapshot(data);
  return data;
}

function failureDetail(row, fallback = "failed") {
  return row?.failureReason || (row?.failedChecks || []).join(", ") || fallback;
}

function buildActivitySnapshot(data) {
  const allPrs = [
    ...(data?.pullRequests?.pass || []),
    ...(data?.pullRequests?.noCi || []),
    ...(data?.pullRequests?.fail || []),
    ...(data?.pullRequests?.running || []),
    ...(data?.pullRequests?.conflicts || [])
  ];
  return {
    includeCd: Boolean(data?.options?.includeCd),
    ci: new Map((data?.pullRequests?.running || []).map((row) => [prKey(row), row])),
    cd: new Map((data?.cd?.running || []).map((row) => [actionKey(row), row])),
    conflicts: new Set(allPrs.filter((row) => row.hasConflict).map((row) => prKey(row)))
  };
}

function notificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

async function requestNotificationPermission() {
  if (notificationPermission() !== "default") return notificationPermission();
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

function syncNotificationControl() {
  const permission = notificationPermission();
  els.notifications.disabled = permission === "unsupported";
  if (permission === "denied" || permission === "unsupported") {
    els.notifications.checked = false;
    state.notifications = false;
    persist();
  } else {
    els.notifications.checked = state.notifications;
  }
}

async function showBrowserNotification(title, body, tag) {
  if (notificationPermission() !== "granted") return false;
  const registration = await notificationWorkerPromise;
  try {
    if (registration?.showNotification) {
      await registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        icon: "/favicon.svg",
        badge: "/favicon.svg",
        data: { url: window.location.href }
      });
      return true;
    }
    const notification = new Notification(title, {
      body,
      tag,
      renotify: true,
      icon: "/favicon.svg"
    });
    setTimeout(() => notification.close(), 10000);
    return true;
  } catch {
    return false;
  }
}

function showToast(title, body) {
  if (!els.toastRegion) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(body)}</span>
  `;
  els.toastRegion.append(toast);
  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 220);
  }, 8000);
}

function recordInbox(entry) {
  const id = `${entry.tag || entry.title}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
  const item = {
    id,
    tag: entry.tag || "",
    kind: entry.kind || "info",
    tone: entry.tone || "info",
    title: entry.title,
    body: entry.body,
    url: entry.url || "",
    at: new Date().toISOString(),
    read: false
  };
  state.inbox.unshift(item);
  state.inbox = state.inbox.slice(0, INBOX_MAX);
  saveInbox();
  renderInbox();
}

async function sendPopup(title, body, tag, options = {}) {
  recordInbox({
    title,
    body,
    tag,
    url: options.url || "",
    kind: options.kind || "info",
    tone: options.tone || "info"
  });
  if (!state.notifications) return;
  showToast(title, body);
  await showBrowserNotification(title, body, tag);
}

function notifyCompletedActions(previousSnapshot, data) {
  if (!previousSnapshot) return;
  const nextSnapshot = buildActivitySnapshot(data);
  const completedPrs = [
    ...(data?.pullRequests?.pass || []),
    ...(data?.pullRequests?.fail || [])
  ];
  const completedPrByKey = new Map(completedPrs.map((row) => [prKey(row), row]));

  for (const [key] of previousSnapshot.ci) {
    if (nextSnapshot.ci.has(key)) continue;
    const completed = completedPrByKey.get(key);
    if (!completed) continue;
    const stateLabel = completed.state === "pass" ? "passed" : "failed";
    const reason = completed.state === "fail" ? `. Reason: ${failureDetail(completed, "CI failed")}` : "";
    sendPopup(
      `CI ${stateLabel}`,
      `${completed.repo} ${completed.numberLabel}: ${completed.title}${reason}`,
      `ci:${key}:${stateLabel}`,
      {
        url: completed.url,
        kind: "ci",
        tone: completed.state === "pass" ? "success" : "danger"
      }
    );
  }

  const allPrs = [
    ...(data?.pullRequests?.pass || []),
    ...(data?.pullRequests?.noCi || []),
    ...(data?.pullRequests?.fail || []),
    ...(data?.pullRequests?.running || []),
    ...(data?.pullRequests?.conflicts || [])
  ];
  const prByKey = new Map(allPrs.map((row) => [prKey(row), row]));
  for (const key of nextSnapshot.conflicts) {
    if (previousSnapshot.conflicts?.has(key)) continue;
    const pr = prByKey.get(key);
    if (!pr) continue;
    sendPopup(
      "Merge conflict",
      `${pr.repo} ${pr.numberLabel}: ${pr.title}`,
      `conflict:${key}`,
      { url: pr.url, kind: "conflict", tone: "danger" }
    );
  }

  if (!previousSnapshot.includeCd || !nextSnapshot.includeCd) return;
  const failedCdByKey = new Map((data?.cd?.failed || []).map((row) => [actionKey(row), row]));
  const finishedCdByKey = new Map((data?.cd?.finished || []).map((row) => [actionKey(row), row]));
  for (const [key, previous] of previousSnapshot.cd) {
    if (nextSnapshot.cd.has(key)) continue;
    const failed = failedCdByKey.get(key);
    const finished = finishedCdByKey.get(key);
    const skipped = !failed && finished?.outcome === "skipped";
    let statusLabel;
    let reason;
    let tone;
    if (failed) {
      statusLabel = `failed (${failed.conclusion})`;
      reason = `. Reason: ${failureDetail(failed, "CD failed")}`;
      tone = "danger";
    } else if (skipped) {
      statusLabel = "skipped";
      reason = ". Production was not deployed.";
      tone = "warning";
    } else {
      statusLabel = "finished";
      reason = "";
      tone = "success";
    }
    sendPopup(
      `CD ${statusLabel}`,
      `${previous.repo} ${previous.workflow} ${previous.runNumber}: ${previous.title || previous.branch}${reason}`,
      `cd:${key}:${statusLabel}`,
      {
        url: failed?.url || finished?.url || previous.url,
        kind: "cd",
        tone
      }
    );
  }
}

function setLoading(isLoading) {
  state.loading = isLoading;
  els.loading.classList.toggle("hidden", !isLoading);
  updateRefreshButtonState();
}

function setError(message, tone = "error") {
  els.errorPanel.textContent = message || "";
  els.errorPanel.classList.toggle("hidden", !message);
  els.errorPanel.classList.toggle("warning", Boolean(message) && tone === "warning");
}

function dashboardWarning(data) {
  const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
  return warnings.join(" ");
}

function clearRefreshTimer() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function ensureCountdownTimer() {
  if (state.countdownTimer) return;
  state.countdownTimer = setInterval(renderRefreshStatus, 1000);
}

function ensureGeneratedTicker() {
  if (generatedTicker) return;
  generatedTicker = setInterval(() => {
    if (lastGeneratedAt) els.generatedAt.textContent = formatRelative(lastGeneratedAt);
  }, 30000);
}

function tightestRateLimit(data) {
  return data?.rateLimit?.tightest || null;
}

function quotaBlockFromRateLimit(rateLimit) {
  const tightest = rateLimit?.tightest;
  if (!tightest) return null;
  const remaining = Number(tightest.remaining);
  const limit = Math.max(1, Number(tightest.limit) || 1);
  const remainingRatio = remaining / limit;
  if (remaining >= QUOTA_SLOW_REMAINING && remainingRatio >= QUOTA_SLOW_RATIO) return null;
  const resetAt = tightest.resetAt || "";
  const resetTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetTime) || resetTime <= Date.now()) return null;
  return {
    resource: tightest.resource || "GitHub",
    resetAt,
    retryAt: new Date(resetTime + 30_000).toISOString(),
    remaining,
    limit
  };
}

function quotaRefreshBlock(data = state.data) {
  const quota = data?.refresh?.quota;
  if (quota?.blocked) {
    const retryAt = state.nextRefreshAt || quota.resetAt;
    const retryTime = new Date(retryAt).getTime();
    if (Number.isFinite(retryTime) && retryTime > Date.now()) {
      return {
        resource: quota.resource || "GitHub",
        retryAt,
        remaining: quota.remaining,
        limit: quota.limit
      };
    }
  }
  return quotaBlockFromRateLimit(data?.rateLimit);
}

function updateRefreshButtonState() {
  const quotaBlock = quotaRefreshBlock();
  const disabled = Boolean(state.loading || quotaBlock);
  els.refresh.disabled = disabled;
  els.refresh.classList.toggle("loading", Boolean(state.loading));
  els.refresh.classList.toggle("quota-blocked", Boolean(quotaBlock && !state.loading));
  els.refresh.setAttribute(
    "aria-label",
    quotaBlock ? "Refresh paused until GitHub API quota resets" : "Refresh now"
  );
  els.refresh.title = quotaBlock
    ? `Refresh paused for ${quotaBlock.resource} API quota until ${formatTime(quotaBlock.retryAt)}`
    : "Refresh (R)";
}

function quotaBlockMessage(block) {
  if (!block) return "";
  const quota = Number.isFinite(Number(block.remaining)) && Number.isFinite(Number(block.limit))
    ? ` (${block.remaining}/${block.limit})`
    : "";
  return `${block.resource} API quota is low${quota}. Refresh is paused until ${formatTime(block.retryAt)}.`;
}

function rateLimitTooltip(tightest, quotaState, quotaBlock) {
  if (!tightest) {
    return "GitHub API quota is not available until the first scan finishes.";
  }
  const resource = tightest.resource || "GitHub";
  const remaining = tightest.remaining ?? "?";
  const limit = tightest.limit ?? "?";
  const reset = formatTime(tightest.resetAt);
  const base = `${resource} is the GitHub API quota bucket used by this scan. ${remaining} of ${limit} requests remain until it resets at ${reset}.`;
  if (quotaBlock) {
    return `${base} Low means another scan could exhaust the bucket, so refresh is paused until after the reset window.`;
  }
  if (quotaState === "watch") {
    return `${base} Watch means quota is getting tight, so the dashboard slows refreshes.`;
  }
  return `${base} The dashboard adjusts refresh timing from this quota.`;
}

function renderRefreshStatus() {
  const data = state.data;
  const tightest = tightestRateLimit(data);
  const quotaBlock = quotaRefreshBlock(data);
  if (!els.autoRefresh.checked) {
    els.nextRefresh.textContent = "paused";
  } else if (!state.nextRefreshAt) {
    els.nextRefresh.textContent = "after first scan";
  } else {
    const remaining = new Date(state.nextRefreshAt).getTime() - Date.now();
    els.nextRefresh.textContent = `${formatDuration(remaining)} · ${state.refreshReason || "adaptive"}`;
  }

  if (tightest) {
    const quotaState = quotaBlock ? "low" : data?.refresh?.quota?.status === "watch" ? "watch" : "";
    els.rateLimit.textContent = `${tightest.resource}: ${tightest.remaining}/${tightest.limit}${quotaState ? ` · ${quotaState}` : ""} · resets ${formatTime(tightest.resetAt)}`;
    const tooltip = rateLimitTooltip(tightest, quotaState, quotaBlock);
    els.rateLimit.title = tooltip;
    els.rateLimit.setAttribute("aria-label", tooltip);
  } else if (data?.rateLimit) {
    els.rateLimit.textContent = `Quota: ${data.rateLimit.requestCount} requests this scan`;
    els.rateLimit.title = "GitHub API request count for the most recent scan.";
    els.rateLimit.setAttribute("aria-label", els.rateLimit.title);
  } else {
    els.rateLimit.textContent = "Quota: waiting";
    els.rateLimit.title = "GitHub API quota will appear after the first scan finishes.";
    els.rateLimit.setAttribute("aria-label", els.rateLimit.title);
  }
  updateRefreshButtonState();
}

function scheduleAutoRefresh(data) {
  clearRefreshTimer();
  if (!els.autoRefresh.checked || !data?.refresh?.nextRefreshAt) {
    state.nextRefreshAt = null;
    renderRefreshStatus();
    return;
  }

  state.nextRefreshAt = data.refresh.nextRefreshAt;
  state.refreshReason = data.refresh.reason;
  const delay = Math.max(5000, new Date(state.nextRefreshAt).getTime() - Date.now());
  state.refreshTimer = setTimeout(() => refresh({ source: "auto" }), delay);
  ensureCountdownTimer();
  renderRefreshStatus();
}

function scheduleRefreshRetry() {
  clearRefreshTimer();
  if (!els.autoRefresh.checked) {
    state.nextRefreshAt = null;
    renderRefreshStatus();
    return;
  }

  const quotaBlock = quotaRefreshBlock();
  const quotaDelay = quotaBlock ? new Date(quotaBlock.retryAt).getTime() - Date.now() : 0;
  const retryDelay = REFRESH_RETRY_DELAYS_MS[Math.min(state.refreshRetryCount, REFRESH_RETRY_DELAYS_MS.length - 1)];
  const delay = Math.max(5000, quotaBlock ? quotaDelay : retryDelay);
  state.refreshRetryCount += 1;
  state.nextRefreshAt = new Date(Date.now() + delay).toISOString();
  state.refreshReason = quotaBlock ? `Paused for ${quotaBlock.resource} API quota` : "retrying after error";
  state.refreshTimer = setTimeout(() => refresh({ source: "retry" }), delay);
  ensureCountdownTimer();
  renderRefreshStatus();
}

function scheduledRefreshDelayMs() {
  if (!state.nextRefreshAt) return 0;
  const delay = new Date(state.nextRefreshAt).getTime() - Date.now();
  return Number.isFinite(delay) ? delay : 0;
}

async function refreshAfterMutation(source) {
  if (state.loading) return;

  const quotaBlock = quotaRefreshBlock();
  if (quotaBlock) {
    state.nextRefreshAt = quotaBlock.retryAt;
    state.refreshReason = `Paused for ${quotaBlock.resource} API quota`;
    setError(quotaBlockMessage(quotaBlock), "warning");
    if (els.autoRefresh.checked) scheduleAutoRefresh(state.data);
    renderRefreshStatus();
    return;
  }

  if (els.autoRefresh.checked && state.refreshTimer && scheduledRefreshDelayMs() > 1000) {
    renderRefreshStatus();
    return;
  }

  await refresh({ source });
}

function buildParams() {
  return new URLSearchParams({
    mode: state.mode,
    includeCd: els.includeCd.checked ? "1" : "0",
    includeRunners: els.includeRunners.checked ? "1" : "0",
    includeRepoRunners: "0",
    jobs: "4"
  });
}

async function refresh({ source = "manual" } = {}) {
  if (source === "manual") clearRefreshTimer();
  const quotaBlock = quotaRefreshBlock();
  if (quotaBlock) {
    state.nextRefreshAt = quotaBlock.retryAt;
    state.refreshReason = `Paused for ${quotaBlock.resource} API quota`;
    setError(quotaBlockMessage(quotaBlock), "warning");
    if (els.autoRefresh.checked) scheduleAutoRefresh(state.data);
    renderRefreshStatus();
    return;
  }
  setLoading(true);
  setError("");
  try {
    const response = await fetch(`/api/status?${buildParams().toString()}`);
    const data = await response.json();
    if (!response.ok) {
      if (data.rateLimit) {
        state.data = { ...(state.data || {}), rateLimit: data.rateLimit };
        renderRefreshStatus();
      }
      throw new Error(data.error || "Unable to refresh dashboard");
    }
    notifyCompletedActions(state.activitySnapshot, data);
    state.activitySnapshot = buildActivitySnapshot(data);
    if (data.autoMerge) applyAutoMergeSnapshot(data.autoMerge);
    state.data = data;
    state.refreshRetryCount = 0;
    render();
    scheduleAutoRefresh(data);
  } catch (error) {
    setError(error.message);
    scheduleRefreshRetry();
  } finally {
    setLoading(false);
  }
}

function updateTabTitle(data) {
  const failing = data?.summary?.failingPrs ?? 0;
  document.title = failing > 0 ? `(${failing}) PR Command Deck` : "PR Command Deck";
}

function renderMetrics(data) {
  for (const [key, id] of Object.entries(metricIds)) {
    document.querySelector(`#${id}`).textContent = data.summary[key] ?? 0;
  }
  const skippedCd = Number(data.summary.skippedCd || 0);
  const finishedCdSub = document.querySelector("#metricFinishedCdSub");
  if (finishedCdSub) {
    if (skippedCd > 0) {
      finishedCdSub.textContent = `⊘ ${skippedCd} skipped`;
      finishedCdSub.setAttribute("aria-label", `${skippedCd} of ${data.summary.finishedCd ?? 0} finished CD runs were skipped — production was not deployed`);
      finishedCdSub.hidden = false;
    } else {
      finishedCdSub.textContent = "";
      finishedCdSub.removeAttribute("aria-label");
      finishedCdSub.hidden = true;
    }
  }
  const finishedCdDot = document.querySelector("#navFinishedCdDot");
  if (finishedCdDot) {
    finishedCdDot.classList.toggle("amber", skippedCd > 0);
    finishedCdDot.classList.toggle("green", skippedCd === 0);
  }
  const failedCdTotal = Number(data.summary.failedCd || 0);
  const failedCdDot = document.querySelector("#navFailedCdDot");
  if (failedCdDot) {
    failedCdDot.classList.toggle("red", failedCdTotal > 0);
    failedCdDot.classList.toggle("ink", failedCdTotal === 0);
  }
  const navCounts = {
    pass: data.summary.passingPrs,
    noCi: data.summary.noCiPrs,
    fail: data.summary.failingPrs,
    conflicts: data.summary.conflictPrs,
    running: data.summary.runningPrs,
    runningCd: data.summary.runningCd,
    finishedCd: data.summary.finishedCd,
    deployments: data.summary.runningDeployments,
    runners: data.summary.busyRunners,
    failedCd: data.summary.failedCd
  };
  for (const [key, id] of Object.entries(navIds)) {
    document.querySelector(`#${id}`).textContent = navCounts[key] ?? 0;
  }
}

function syncActiveAffordances() {
  document.querySelectorAll(".segment").forEach((button) => {
    const isActive = button.dataset.mode === state.mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  document.querySelectorAll(".rail-item").forEach((button) => {
    const isActive = button.dataset.view === state.view;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "true" : "false");
  });
  document.querySelectorAll("button.metric").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
}

function syncFilterUI(matched, total) {
  els.filterClear.classList.toggle("hidden", !state.filter);
  if (!state.filter) {
    els.filterCount.textContent = "";
  } else {
    els.filterCount.textContent = `${matched}/${total}`;
  }
}

function render() {
  const data = state.data;
  if (!data) return;

  els.account.textContent = data.account;
  lastGeneratedAt = data.generatedAt;
  els.generatedAt.textContent = formatRelative(data.generatedAt);
  ensureGeneratedTicker();

  setError(dashboardWarning(data), "warning");
  renderRefreshStatus();
  renderMetrics(data);
  updateTabTitle(data);
  syncActiveAffordances();

  const view = views[state.view];
  els.viewKicker.textContent = view.kicker;
  els.viewTitle.textContent = view.title;
  syncAutoMerges(data);

  const query = state.filter.trim().toLowerCase();
  const all = view.rows(data);
  const rows = query ? all.filter((row) => rowText(row).includes(query)) : all;
  syncFilterUI(rows.length, all.length);

  els.content.innerHTML = rows.length
    ? rows.map((row) => renderRow(row, state.view, view)).join("")
    : `<div class="empty">${escapeHtml(view.empty)}</div>`;
}

function renderRow(row, viewKey, view) {
  if (viewKey === "running" && row.kind === "workflowRun") return renderWorkflowRunRow(row, view);
  if (["pass", "noCi", "fail", "running", "conflicts"].includes(viewKey)) return renderPrRow(row, view);
  if (viewKey === "finishedCd") return renderFinishedCdRow(row, view);
  if (["runningCd", "finishedCd", "failedCd"].includes(viewKey)) return renderCdRow(row, view, viewKey);
  if (viewKey === "deployments") return renderDeploymentRow(row, view);
  return renderRunnerRow(row, view);
}

function mergeBlockReason(row) {
  if (row.state !== "pass") return "CI is not passing";
  if (row.isDraft) return "Draft pull requests cannot be merged";
  if (row.hasConflict) return "Resolve merge conflicts first";
  if (row.checkCount === 0 && row.mergeable !== "MERGEABLE") return "Pull request is not currently mergeable";
  return "";
}

function renderPrActions(row) {
  const key = mergeKey(row.repo, row.number);
  const reason = mergeBlockReason(row);
  const isMerging = state.merging.has(key);
  const isMerged = state.merged.has(key);
  const isClosing = state.closing.has(key);
  const isClosed = state.closed.has(key);
  const isAutoMerge = !reason && !isMerging && !isMerged && state.autoMerges.has(key);
  const isAutoMergePending = isAutoMerge && autoMergeRemainingSeconds(key) <= 0;
  const buttonLabel = isMerged ? "Merged" : isMerging ? "Merging" : isAutoMerge ? autoMergeButtonLabel(key) : "Merge";
  const buttonTitle = isMerged
    ? "Pull request merged"
    : isMerging
    ? "Merging pull request..."
    : reason || (isAutoMerge ? "Automatically merge when the timer reaches zero" : "Merge this pull request");
  const closeLabel = isClosed ? "Closed" : isClosing ? "Closing" : "Close";
  const closeTitle = isClosed
    ? "Pull request closed"
    : isClosing
    ? "Closing pull request..."
    : "Close this pull request";
  const showMergeButton = row.state === "pass" && !isClosed && !(row.checkCount === 0 && row.mergeable !== "MERGEABLE");
  const mergeButton = showMergeButton
    ? `<button
         class="merge-button"
         type="button"
         data-repo="${escapeHtml(row.repo)}"
         data-number="${escapeHtml(row.number)}"
         data-title="${escapeHtml(row.title)}"
         data-state="${isMerged ? "merged" : isMerging ? "merging" : "ready"}"
         data-auto-merge="${isAutoMerge ? "true" : "false"}"
         aria-label="${escapeHtml(buttonLabel)} ${escapeHtml(row.repo)} ${escapeHtml(row.numberLabel)}"
         ${reason || isMerging || isMerged || isClosing || isAutoMergePending ? "disabled" : ""}
         title="${escapeHtml(buttonTitle)}"
       >
         ${buttonLabel}
       </button>`
    : "";
  const closeButton = !isMerged
    ? `<button
         class="close-button"
         type="button"
         data-repo="${escapeHtml(row.repo)}"
         data-number="${escapeHtml(row.number)}"
         data-title="${escapeHtml(row.title)}"
         data-state="${isClosed ? "closed" : isClosing ? "closing" : "ready"}"
         aria-label="${escapeHtml(closeLabel)} ${escapeHtml(row.repo)} ${escapeHtml(row.numberLabel)}"
         ${isClosing || isClosed || isMerging ? "disabled" : ""}
         title="${escapeHtml(closeTitle)}"
       >
         ${closeLabel}
       </button>`
    : "";
  return `
    <div class="row-actions">
      ${mergeButton}
      ${closeButton}
      <a class="open-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Open PR</a>
    </div>
  `;
}

function renderPrRow(row, view) {
  const detail = row.state === "fail"
    ? `Reason: ${failureDetail(row, "CI failed")}`
    : row.runningChecks?.length
    ? row.runningChecks.join(", ")
    : row.checkCount
    ? `${row.checkCount} checks complete`
    : "no checks reported";
  const stateLabel = row.checkCount ? row.state.toUpperCase() : "NO CI";
  const conflictBadge = row.hasConflict
    ? `<span class="conflict-pill" title="Branch has merge conflicts that block this PR">
         <svg viewBox="0 0 24 24" aria-hidden="true">
           <path d="M12 3 2 21h20L12 3Zm0 6v6m0 3v.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
         </svg>
         Conflict
       </span>`
    : "";
  const draftBadge = row.isDraft
    ? `<span class="draft-pill" title="Draft pull request">Draft</span>`
    : "";
  return `
    <article class="row${row.hasConflict ? " row-conflict" : ""}" data-href="${escapeHtml(row.url || "")}" style="--accent: var(--${view.color}); --soft: var(--${view.color}-soft);">
      <div class="row-main">
        <div class="repo">${escapeHtml(row.repo)}</div>
        <div class="title">${escapeHtml(row.title)}</div>
      </div>
      <div class="meta">${escapeHtml(row.numberLabel)} · @${escapeHtml(row.author)}</div>
      <div class="tag-group">
        <span class="tag">${escapeHtml(stateLabel)}</span>
        ${conflictBadge}
        ${draftBadge}
      </div>
      <div class="meta">${escapeHtml(detail)}</div>
      ${renderPrActions(row)}
    </article>
  `;
}

function renderCdRow(row, view, viewKey) {
  const status = viewKey === "runningCd" ? row.status : row.conclusion;
  const timeDetail = [row.branch, formatTime(row.createdAt)].filter(Boolean).join(" · ");
  const detail = viewKey === "failedCd" || row.failureReason
    ? [`Reason: ${failureDetail(row, "CD failed")}`, timeDetail].filter(Boolean).join(" · ")
    : timeDetail;
  const tagClass = viewKey === "failedCd" ? `tag tag-${statusClass(status)}` : "tag";
  return `
    <article class="row" data-href="${escapeHtml(row.url || "")}" style="--accent: var(--${view.color}); --soft: var(--${view.color}-soft);">
      <div class="row-main">
        <div class="repo">${escapeHtml(row.repo)}</div>
        <div class="title">${escapeHtml(row.title || row.workflow)}</div>
      </div>
      <div class="meta">${escapeHtml(row.workflow)} ${escapeHtml(row.runNumber)}</div>
      <div class="${tagClass}">${escapeHtml(status)}</div>
      <div class="meta">${escapeHtml(detail)}</div>
      ${row.url ? `<a class="open-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Open Run</a>` : ""}
    </article>
  `;
}

function statusClass(status) {
  return String(status || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "unknown";
}

function formatSignedCount(value, prefix) {
  const number = Number(value || 0);
  if (!number) return "";
  return `${prefix}${number}`;
}

function renderChangedPages(summary) {
  const pages = summary?.changedPages || [];
  if (!pages.length) {
    return `
      <li class="review-empty">
        No route-like page file was detected. Use the changed file links below and the run link to inspect the deployed behavior.
      </li>
    `;
  }
  return pages.map((page) => {
    const label = page.environment ? `${page.label} · ${page.environment}` : page.label;
    const pageLink = page.url
      ? `<a class="page-link" href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
      : `<span class="page-link page-link-muted">${escapeHtml(label)}</span>`;
    const source = page.sourceUrl
      ? `<a class="source-link" href="${escapeHtml(page.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(page.sourcePath)}</a>`
      : `<span>${escapeHtml(page.sourcePath)}</span>`;
    return `
      <li>
        <div class="review-link-row">
          ${pageLink}
          ${source}
        </div>
        <p>${escapeHtml(page.lookFor || "Check the changed page in the deployed app.")}</p>
      </li>
    `;
  }).join("");
}

function renderChangedFiles(summary) {
  const files = summary?.changedFiles || [];
  if (!files.length) {
    return `<li class="review-empty">No deployment diff was available for this run. Use the recent merged PR summary below.</li>`;
  }
  const rows = files.map((file) => {
    const delta = [formatSignedCount(file.additions, "+"), formatSignedCount(file.deletions, "-")].filter(Boolean).join(" ");
    const fileLabel = file.url
      ? `<a class="source-link" href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.path)}</a>`
      : `<span>${escapeHtml(file.path)}</span>`;
    return `
      <li>
        <div class="file-change-line">
          ${fileLabel}
          <span class="file-status">${escapeHtml(file.status || "changed")}${delta ? ` · ${escapeHtml(delta)}` : ""}</span>
        </div>
        <p>${escapeHtml(file.lookFor || "Check the affected behavior.")}</p>
      </li>
    `;
  }).join("");
  const hidden = summary.hiddenFileCount
    ? `<p class="review-more">${escapeHtml(summary.hiddenFileCount)} more changed files are available in the commit link.</p>`
    : "";
  return `${rows}${hidden}`;
}

function renderPrPageLinks(pr) {
  let pages = pr.changedPages || [];
  pages = pages.filter((page) => !page.url || !isBackendUrl(page.url));
  if (!pages.length) {
    if (!pr.productionUrl || isBackendUrl(pr.productionUrl)) return "";
    const label = pr.productionEnvironment ? `Production site · ${pr.productionEnvironment}` : "Production site";
    return `
      <div class="pr-page-links">
        <a class="page-link page-link-quiet visual-page-link" href="${escapeHtml(pr.productionUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>
      </div>
    `;
  }
  return `
    <div class="pr-page-links">
      ${pages.slice(0, 3).map((page) => {
        const label = page.environment ? `${page.label} · ${page.environment}` : page.label;
        return page.url
          ? `<a class="page-link" href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
          : `<span class="page-link page-link-muted">${escapeHtml(label)}</span>`;
      }).join("")}
      ${pages.length > 3 ? `<span class="page-link page-link-muted">+${escapeHtml(pages.length - 3)} more</span>` : ""}
    </div>
  `;
}

function renderPrFileLinks(pr) {
  const files = pr.changedFiles || [];
  if (!files.length) return "";
  return `
    <details class="source-details">
      <summary>Files changed (${escapeHtml(pr.filesChanged || files.length)})</summary>
      <div class="pr-file-links">
      ${files.slice(0, 4).map((file) => `
        <a class="source-link" href="${escapeHtml(file.url || pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.path)}</a>
      `).join("")}
      ${pr.hiddenFileCount ? `<span class="file-status">+${escapeHtml(pr.hiddenFileCount)} more</span>` : ""}
      </div>
    </details>
  `;
}

function uniqueVisualPages(summary) {
  const seen = new Set();
  const groups = [
    ...(summary?.changedPages || []),
    ...(summary?.mergedPullRequests || []).flatMap((item) => item.changedPages || []),
    ...(summary?.recentCommits || []).flatMap((item) => item.changedPages || [])
  ];
  return groups.filter((page) => {
    if (page.url && isBackendUrl(page.url)) return false;
    const key = page.url || page.path || page.label;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).concat(
    !seen.size && summary?.deployUrl && !isBackendUrl(summary.deployUrl)
      ? [{
          label: "Production site",
          path: "/",
          url: summary.deployUrl,
          environment: summary.environment || "production"
        }]
      : []
  );
}

function renderVisualReviewLinks(summary) {
  const pages = uniqueVisualPages(summary);
  if (!pages.length) return "";
  return `
    <section class="visual-review" aria-label="Production pages to visually verify">
      <div class="visual-review-head">
        <h3>Visual checks in production</h3>
        <span>${escapeHtml(pages.length)} ${pages.length === 1 ? "page" : "pages"}</span>
      </div>
      <div class="visual-link-grid">
        ${pages.slice(0, 12).map((page) => {
          const label = page.environment ? `${page.label} · ${page.environment}` : page.label;
          return page.url
            ? `<a class="page-link visual-page-link" href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
            : `<span class="page-link page-link-muted visual-page-link">${escapeHtml(label)}</span>`;
        }).join("")}
      </div>
    </section>
  `;
}

function renderMergedPrSummary(summary) {
  const prs = summary?.mergedPullRequests || [];
  if (!prs.length) {
    return `<li class="review-empty">No recent merged PRs were available from GitHub for this repository.</li>`;
  }
  return prs.map((pr) => `
    <li class="summary-item">
      <div class="summary-item-primary">
        <div class="merged-pr-head">
          <a class="source-link merged-pr-title" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">
            ${escapeHtml(pr.numberLabel)} ${escapeHtml(pr.title)}
          </a>
          <span class="file-status">${escapeHtml(pr.filesChanged || 0)} files · ${escapeHtml(formatTime(pr.mergedAt))} · @${escapeHtml(pr.author)}</span>
        </div>
        ${renderPrPageLinks(pr)}
      </div>
      <details class="summary-item-details">
        <summary>Verification details</summary>
        <p><strong>Look for:</strong> ${escapeHtml(pr.changedPages?.length ? (pr.inferredPages ? "The inferred production page should reflect this PR's behavior if it shipped there." : "The linked production page should reflect the PR behavior visually.") : "Use the PR link, then inspect the affected app area visually.")}</p>
        ${renderPrFileLinks(pr)}
      </details>
    </li>
  `).join("");
}

function renderRecentCommitSummary(summary) {
  const commits = summary?.recentCommits || [];
  if (!commits.length) {
    return `<li class="review-empty">No recent commit metadata was available from GitHub for this repository.</li>`;
  }
  return commits.map((commit) => `
    <li class="summary-item">
      <div class="summary-item-primary">
        <div class="merged-pr-head">
          <a class="source-link merged-pr-title" href="${escapeHtml(commit.url)}" target="_blank" rel="noreferrer">
            ${escapeHtml(commit.shortSha || "commit")} ${escapeHtml(commit.message)}
          </a>
          <span class="file-status">${escapeHtml(commit.filesChanged || 0)} files · ${escapeHtml(formatTime(commit.committedAt))} · ${escapeHtml(commit.author)}</span>
        </div>
        ${renderPrPageLinks(commit)}
      </div>
      <details class="summary-item-details">
        <summary>Verification details</summary>
        <p><strong>Look for:</strong> ${escapeHtml(commit.changedPages?.length ? (commit.inferredPages ? "The inferred production page should reflect this commit's behavior if it shipped there." : "The linked production page should reflect the commit behavior visually.") : "Use the commit link, then inspect the affected app area visually.")}</p>
        ${renderPrFileLinks(commit)}
      </details>
    </li>
  `).join("");
}

function renderReviewLinks(summary) {
  const links = summary?.reviewLinks || {};
  const items = [
    ["Merged PR search", links.mergedPullRequestsUrl],
    ["Commit history", links.commitsUrl],
    ["Compare manually", links.compareHelpUrl]
  ].filter(([, href]) => href);
  if (!items.length) return "";
  return `
    <div class="fallback-links" aria-label="Manual GitHub review links">
      ${items.map(([label, href]) => `
        <a class="open-link fallback-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>
      `).join("")}
    </div>
  `;
}

function renderReviewSection(title, ariaLabel, className, body, options = {}) {
  if (!body) return "";
  const meta = options.meta ? `<span>${escapeHtml(options.meta)}</span>` : "";
  if (options.collapsible) {
    return `
      <details class="review-section review-section-collapsible" aria-label="${escapeHtml(ariaLabel)}" ${options.open === false ? "" : "open"}>
        <summary>
          <span>${escapeHtml(title)}</span>
          ${meta}
        </summary>
        <ul class="review-list ${escapeHtml(className)}">
          ${body}
        </ul>
      </details>
    `;
  }
  return `
    <section class="review-section" aria-label="${escapeHtml(ariaLabel)}">
      <h3>${escapeHtml(title)}</h3>
      <ul class="review-list ${escapeHtml(className)}">
        ${body}
      </ul>
    </section>
  `;
}

function renderFinishedCdRow(row, view) {
  const summary = row.changeSummary || {};
  const hasChangedPages = Boolean(summary.changedPages?.length);
  const hasChangedFiles = Boolean(summary.changedFiles?.length);
  const hasMergedPrs = Boolean(summary.mergedPullRequests?.length);
  const hasRecentCommits = Boolean(summary.recentCommits?.length);
  const outcome = row.outcome || "";
  const isSkipped = outcome === "skipped";
  const status = row.conclusion || "completed";
  const statusTone = isSkipped
    ? "warning"
    : row.failureReason ? "danger" : statusClass(status);
  const timeDetail = [row.branch, formatTime(row.createdAt)].filter(Boolean).join(" · ");
  const fileCount = hasChangedFiles || Number(summary.filesChanged || 0) > 0
    ? `${summary.filesChanged} files`
    : hasMergedPrs
    ? `${summary.mergedPullRequests.length} merged PRs`
    : hasRecentCommits
    ? `${summary.recentCommits.length} commits`
    : "manual review links";
  const delta = [formatSignedCount(summary.additions, "+"), formatSignedCount(summary.deletions, "-")].filter(Boolean).join(" ");
  const changeLinkLabel = summary.sourceLabel || summary.shortSha || "change unavailable";
  const commitLink = summary.commitUrl
    ? `<a class="source-link" href="${escapeHtml(summary.commitUrl)}" target="_blank" rel="noreferrer">${escapeHtml(changeLinkLabel)}</a>`
    : `<span>${escapeHtml(changeLinkLabel)}</span>`;
  const changeSourceLabel = summary.source === "compare" ? "Diff" : "Commit";
  const commitCount = Number(summary.commitCount || 0);
  const pageSection = hasChangedPages
    ? renderReviewSection("Changed route sources", "Changed route sources", "page-review-list", renderChangedPages(summary))
    : "";
  const fileSection = hasChangedFiles
    ? renderReviewSection("Source details", "Changed files and review cues", "file-review-list", renderChangedFiles(summary))
    : "";
  const mergedPrSection = hasMergedPrs ? renderReviewSection(
    "Recent merged PR summary",
    "Recent merged pull requests",
    "merged-pr-list",
    renderMergedPrSummary(summary),
    { collapsible: true, meta: `${summary.mergedPullRequests.length} PRs`, open: false }
  ) : "";
  const commitSection = !hasMergedPrs && hasRecentCommits ? renderReviewSection(
    "Recent commit summary",
    "Recent commits",
    "merged-pr-list",
    renderRecentCommitSummary(summary),
    { collapsible: true, meta: `${summary.recentCommits.length} commits`, open: false }
  ) : "";
  const tagLabel = isSkipped
    ? `<span aria-hidden="true">⊘</span> ${escapeHtml(status)}`
    : escapeHtml(status);
  const tagAriaLabel = isSkipped
    ? "Deploy skipped — production was not updated"
    : `Run conclusion: ${status}`;
  const reasonLine = row.skipReason
    ? `<span class="review-banner-reason">${escapeHtml(row.skipReason)}</span>`
    : `<span class="review-banner-reason">Skip reason was not derivable from GitHub. Open the run to see the workflow gate that blocked it.</span>`;
  const noteOrBanner = isSkipped
    ? `<div class="review-banner review-banner-warning" role="status">
        <strong>Production was not deployed.</strong>
        GitHub Actions skipped this workflow run — open the run to see which gate blocked the deploy.
        ${reasonLine}
      </div>`
    : `<p class="review-note">${escapeHtml(summary.lookFor || "Open the run and changed files to inspect this deployment.")}</p>`;
  return `
    <article class="cd-card" data-outcome="${escapeHtml(outcome || "")}" style="--accent: var(--${view.color}); --soft: var(--${view.color}-soft);">
      <div class="cd-card-head row" data-href="${escapeHtml(row.url || "")}">
        <div class="row-main">
          <div class="repo">${escapeHtml(row.repo)}</div>
          <div class="title">${escapeHtml(row.title || row.workflow)}</div>
        </div>
        <div class="meta">${escapeHtml(row.workflow)} ${escapeHtml(row.runNumber)}</div>
        <div class="tag tag-${escapeHtml(statusTone)}" role="status" aria-label="${escapeHtml(tagAriaLabel)}">${tagLabel}</div>
        <div class="meta">${escapeHtml(timeDetail)}</div>
        ${row.url ? `<a class="open-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Open Run</a>` : ""}
      </div>
      <div class="cd-review">
        <div class="review-summary">
          <div>
            <span>Changed</span>
            <strong>${escapeHtml(fileCount)}${delta ? ` · ${escapeHtml(delta)}` : ""}</strong>
          </div>
          <div>
            <span>${changeSourceLabel}</span>
            <strong>${commitLink}${commitCount > 1 ? ` · ${escapeHtml(commitCount)} commits` : ""}</strong>
          </div>
          <div>
            <span>Deploy target</span>
            <strong>${summary.deployUrl ? `<a class="source-link" href="${escapeHtml(summary.deployUrl)}" target="_blank" rel="noreferrer">${escapeHtml(summary.environment || "open app")}</a>` : "not found"}</strong>
          </div>
        </div>
        <p class="review-message"><strong>Change:</strong> ${escapeHtml(summary.message || row.title || row.workflow)}</p>
        ${noteOrBanner}
        ${renderVisualReviewLinks(summary)}
        ${renderReviewLinks(summary)}
        ${mergedPrSection}
        ${commitSection}
        ${pageSection || fileSection ? `<details class="source-details source-details-block"><summary>Source details</summary>${pageSection}${fileSection}</details>` : ""}
      </div>
    </article>
  `;
}

function renderWorkflowRunRow(row, view) {
  const detail = [row.branch, formatTime(row.createdAt)].filter(Boolean).join(" · ");
  return `
    <article class="row" data-href="${escapeHtml(row.url || "")}" style="--accent: var(--${view.color}); --soft: var(--${view.color}-soft);">
      <div class="row-main">
        <div class="repo">${escapeHtml(row.repo)}</div>
        <div class="title">${escapeHtml(row.title || row.workflow)}</div>
      </div>
      <div class="meta">${escapeHtml(row.workflow)} ${escapeHtml(row.runNumber)}</div>
      <div class="tag">${escapeHtml(row.status || "running")}</div>
      <div class="meta">${escapeHtml(detail)}</div>
      ${row.url ? `<a class="open-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Open Run</a>` : ""}
    </article>
  `;
}

function renderDeploymentRow(row, view) {
  return `
    <article class="row" data-href="${escapeHtml(row.url || "")}" style="--accent: var(--${view.color}); --soft: var(--${view.color}-soft);">
      <div class="row-main">
        <div class="repo">${escapeHtml(row.repo)}</div>
        <div class="title">${escapeHtml(row.environment || "Deployment")}</div>
      </div>
      <div class="meta">${escapeHtml(row.ref)} ${escapeHtml(row.task)}</div>
      <div class="tag">${escapeHtml(row.state)}</div>
      <div class="meta">${escapeHtml(row.description)} · ${escapeHtml(formatTime(row.createdAt))}</div>
      ${row.url ? `<a class="open-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Open Link</a>` : ""}
    </article>
  `;
}

function renderRunnerRow(row) {
  return `
    <article class="row" style="--accent: #87806f; --soft: var(--gray-soft);">
      <div class="row-main">
        <div class="repo">${escapeHtml(row.scope)}</div>
        <div class="title">${escapeHtml(row.name)}</div>
      </div>
      <div class="meta">${escapeHtml(row.level)}</div>
      <div class="tag">${escapeHtml(row.status || "busy")}</div>
      <div class="meta">${escapeHtml((row.labels || []).join(", "))}</div>
      <span></span>
    </article>
  `;
}

function setView(view) {
  if (!views[view] || state.view === view) return;
  state.view = view;
  persist();
  render();
}

/* —— inbox —— */
function unreadInboxCount() {
  return state.inbox.reduce((n, item) => n + (item.read ? 0 : 1), 0);
}

function relativeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Math.max(0, Date.now() - date.getTime());
  const s = Math.round(diff / 1000);
  if (s < 30) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function inboxIconFor(kind) {
  if (kind === "ci") return "CI";
  if (kind === "cd") return "CD";
  if (kind === "conflict") return "⚠";
  return "•";
}

function renderInbox() {
  const unread = unreadInboxCount();
  const total = state.inbox.length;

  if (unread > 0) {
    els.inboxBadge.textContent = unread > 99 ? "99+" : String(unread);
    els.inboxBadge.classList.remove("hidden");
    els.inboxToggle.classList.add("has-unread");
  } else {
    els.inboxBadge.classList.add("hidden");
    els.inboxToggle.classList.remove("has-unread");
  }
  els.inboxToggle.setAttribute(
    "aria-label",
    unread > 0 ? `Open notification inbox (${unread} unread)` : "Open notification inbox"
  );

  if (total === 0) {
    els.inboxHeading.textContent = "No notifications yet";
  } else if (unread === 0) {
    els.inboxHeading.textContent = `${total} · all read`;
  } else {
    els.inboxHeading.textContent = `${unread} new · ${total} total`;
  }

  els.inboxMarkAll.disabled = unread === 0;
  els.inboxClear.disabled = total === 0;
  els.inboxEmpty.classList.toggle("hidden", total > 0);

  if (!state.inboxOpen) return;

  els.inboxList.innerHTML = state.inbox
    .map(
      (item) => `
        <a
          class="inbox-item tone-${escapeHtml(item.tone || "info")}${item.read ? " is-read" : ""}"
          data-id="${escapeHtml(item.id)}"
          ${item.url ? `href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer"` : 'href="#" data-noopen="true"'}
          role="listitem"
        >
          <span class="inbox-kind">${escapeHtml(inboxIconFor(item.kind))}</span>
          <span class="inbox-body">
            <span class="inbox-row-title">${escapeHtml(item.title)}</span>
            <span class="inbox-row-meta">${escapeHtml(item.body || "")}</span>
          </span>
          <span class="inbox-time" title="${escapeHtml(formatTime(item.at))}">${escapeHtml(relativeTime(item.at))}</span>
        </a>
      `
    )
    .join("");
}

function openInbox() {
  state.inboxOpen = true;
  els.inboxPanel.classList.remove("hidden");
  els.inboxPanel.setAttribute("aria-hidden", "false");
  els.inboxToggle.setAttribute("aria-expanded", "true");
  renderInbox();
}

function closeInbox() {
  if (!state.inboxOpen) return;
  state.inboxOpen = false;
  els.inboxPanel.classList.add("hidden");
  els.inboxPanel.setAttribute("aria-hidden", "true");
  els.inboxToggle.setAttribute("aria-expanded", "false");
}

function toggleInbox() {
  if (state.inboxOpen) {
    closeInbox();
  } else {
    openInbox();
  }
}

function markAllInboxRead() {
  let changed = false;
  for (const item of state.inbox) {
    if (!item.read) {
      item.read = true;
      changed = true;
    }
  }
  if (changed) {
    saveInbox();
    renderInbox();
    closeInbox();
  }
}

function clearInbox() {
  if (!state.inbox.length) return;
  state.inbox = [];
  saveInbox();
  renderInbox();
  closeInbox();
}

function markInboxItemRead(id) {
  const item = state.inbox.find((entry) => entry.id === id);
  if (!item || item.read) return;
  item.read = true;
  saveInbox();
  renderInbox();
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  persist();
  if (state.autoMerge) {
    configureServerAutoMerge().finally(() => refresh());
  } else {
    refresh();
  }
}

async function mergePullRequest(button) {
  const repo = button.dataset.repo;
  const number = Number(button.dataset.number);
  const key = mergeKey(repo, number);
  const title = button.dataset.title || `#${number}`;
  if (!repo || !Number.isInteger(number)) return;
  if (state.merging.has(key) || state.merged.has(key)) return;

  clearAutoMerge(key);
  state.merging.add(key);
  state.merged.delete(key);
  setError("");
  render();
  try {
    const response = await fetch("/api/pull-request/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, number })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Unable to merge pull request");
    }
    if (!data.merged) {
      throw new Error(data.message || "GitHub did not merge the pull request");
    }
    state.merging.delete(key);
    state.merged.add(key);
    render();
    const branchStatus = data.branchDelete?.deleted
      ? "Branch deleted."
      : data.branchDelete?.error
      ? `Branch delete failed: ${data.branchDelete.error}`
      : "Branch delete was skipped.";
    showToast(
      data.branchDelete?.deleted ? "PR merged" : "PR merged, branch not deleted",
      `${data.pr?.repo || repo} ${data.pr?.numberLabel || `#${number}`}: ${data.pr?.title || title}. ${branchStatus}`
    );
    await refreshAfterMutation("merge");
  } catch (error) {
    setError(error.message);
    showToast("Merge failed", error.message);
  } finally {
    state.merging.delete(key);
    render();
  }
}

async function closePullRequest(button) {
  const repo = button.dataset.repo;
  const number = Number(button.dataset.number);
  const key = mergeKey(repo, number);
  const title = button.dataset.title || `#${number}`;
  if (!repo || !Number.isInteger(number)) return;
  if (state.closing.has(key) || state.closed.has(key) || state.merging.has(key) || state.merged.has(key)) return;

  clearAutoMerge(key);
  state.closing.add(key);
  state.closed.delete(key);
  setError("");
  render();
  try {
    const response = await fetch("/api/pull-request/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, number })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Unable to close pull request");
    }
    if (!data.closed) {
      throw new Error(data.message || "GitHub did not close the pull request");
    }
    state.closing.delete(key);
    state.closed.add(key);
    render();
    showToast(
      "PR closed",
      `${data.pr?.repo || repo} ${data.pr?.numberLabel || `#${number}`}: ${data.pr?.title || title}.`
    );
    await refreshAfterMutation("close");
  } catch (error) {
    setError(error.message);
    showToast("Close failed", error.message);
  } finally {
    state.closing.delete(key);
    render();
  }
}

/* —— wiring —— */
document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

document.querySelectorAll(".rail-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelectorAll("button.metric").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

els.autoMerge.checked = state.autoMerge;
els.refresh.addEventListener("click", () => refresh());
els.includeCd.addEventListener("change", refresh);
els.includeRunners.addEventListener("change", refresh);
els.autoRefresh.addEventListener("change", () => {
  if (els.autoRefresh.checked && state.data) {
    scheduleAutoRefresh(state.data);
  } else {
    clearRefreshTimer();
    state.nextRefreshAt = null;
    renderRefreshStatus();
  }
});
els.autoMerge.addEventListener("change", () => {
  state.autoMerge = els.autoMerge.checked;
  persist();
  if (!state.autoMerge) {
    for (const key of [...state.autoMerges.keys()]) clearAutoMerge(key);
  }
  render();
  configureServerAutoMerge()
    .then(() => refreshAfterMutation("auto-merge"))
    .catch((error) => {
      setError(error.message);
      showToast("Auto merge failed", error.message);
    });
});
els.notifications.addEventListener("change", async () => {
  state.notifications = els.notifications.checked;
  persist();
  if (state.notifications) {
    const permission = await requestNotificationPermission();
    if (permission === "denied" || permission === "unsupported") {
      state.notifications = false;
      persist();
      syncNotificationControl();
      showToast("Notifications blocked", "Allow notifications for this site in your browser settings.");
      return;
    }
    if (permission === "granted") {
      sendPopup("Notifications enabled", "CI/CD completion alerts are active.", "notifications:test");
    } else {
      showToast("In-app alerts enabled", "Browser notification permission was not granted.");
    }
  }
  syncNotificationControl();
});
els.inboxToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleInbox();
});
els.inboxMarkAll.addEventListener("click", markAllInboxRead);
els.inboxClear.addEventListener("click", clearInbox);
els.inboxPanel.addEventListener("click", (event) => {
  const item = event.target.closest(".inbox-item");
  if (!item) return;
  if (item.dataset.noopen === "true") {
    event.preventDefault();
  }
  markInboxItemRead(item.dataset.id);
});

els.content.addEventListener("click", (event) => {
  const button = event.target.closest(".merge-button");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  mergePullRequest(button);
});

els.content.addEventListener("click", (event) => {
  const button = event.target.closest(".close-button");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  closePullRequest(button);
});

document.addEventListener("click", (event) => {
  if (!state.inboxOpen) return;
  if (event.target.closest("#inboxPanel") || event.target.closest("#inboxToggle")) return;
  closeInbox();
});

els.filter.addEventListener("input", (event) => {
  state.filter = event.target.value;
  persist();
  render();
});

els.filterClear.addEventListener("click", () => {
  state.filter = "";
  els.filter.value = "";
  persist();
  render();
  els.filter.focus();
});

/* row click — open URL anywhere on the card (ignore clicks on the explicit link/buttons) */
els.content.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  if (event.target.closest("a, button")) return;
  const href = row.dataset.href;
  if (href) window.open(href, "_blank", "noopener,noreferrer");
});

/* keyboard shortcuts */
document.addEventListener("keydown", (event) => {
  const target = event.target;
  const inField = target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

  if (event.key === "Escape" && target === els.filter) {
    state.filter = "";
    els.filter.value = "";
    persist();
    render();
    els.filter.blur();
    return;
  }

  if (event.key === "Escape" && state.inboxOpen) {
    event.preventDefault();
    closeInbox();
    els.inboxToggle.focus();
    return;
  }

  if (inField) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === "/") {
    event.preventDefault();
    els.filter.focus();
    els.filter.select();
    return;
  }

  if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    refresh();
    return;
  }

  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    toggleInbox();
    return;
  }

  const n = Number(event.key);
  if (event.key === "0" && viewOrder.length >= 10) {
    event.preventDefault();
    setView(viewOrder[9]);
    return;
  }
  if (Number.isInteger(n) && n >= 1 && n <= viewOrder.length) {
    event.preventDefault();
    setView(viewOrder[n - 1]);
  }
});

/* —— restore persisted state into the form —— */
els.filter.value = state.filter;
syncNotificationControl();
renderInbox();
ensureCountdownTimer();
configureServerAutoMerge()
  .catch((error) => {
    setError(error.message);
  })
  .finally(() => refresh());
