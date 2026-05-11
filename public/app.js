const STORAGE_KEY = "pr-deck:v1";

const persisted = loadPersisted();

const state = {
  data: null,
  mode: persisted.mode || "all",
  view: persisted.view || "fail",
  filter: persisted.filter || "",
  notifications: persisted.notifications !== false,
  activitySnapshot: null,
  refreshTimer: null,
  countdownTimer: null,
  nextRefreshAt: null,
  refreshReason: ""
};

const views = {
  fail: {
    kicker: "Failing CI",
    title: "PRs that need attention",
    empty: "Nothing failing. Quiet day on the desk.",
    color: "red",
    rows: (data) => data.pullRequests.fail
  },
  running: {
    kicker: "Open PRs with CI running",
    title: "Checks still in motion",
    empty: "No checks currently running.",
    color: "amber",
    rows: (data) => data.pullRequests.running
  },
  pass: {
    kicker: "Passing CI",
    title: "Ready PRs with completed checks",
    empty: "No PRs passing CI yet.",
    color: "green",
    rows: (data) => data.pullRequests.pass
  },
  runningCd: {
    kicker: "Running CD Actions",
    title: "Deploy and release workflows in progress",
    empty: "Nothing deploying right now.",
    color: "blue",
    rows: (data) => data.cd.running
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
    title: "Latest deploy failures by workflow",
    empty: "No failed CD actions.",
    color: "ink",
    rows: (data) => data.cd.failed
  }
};

const viewOrder = ["fail", "running", "pass", "runningCd", "deployments", "runners", "failedCd"];

const els = {
  account: document.querySelector("#account"),
  generatedAt: document.querySelector("#generatedAt"),
  includeCd: document.querySelector("#includeCd"),
  includeRunners: document.querySelector("#includeRunners"),
  includeRepoRunners: document.querySelector("#includeRepoRunners"),
  autoRefresh: document.querySelector("#autoRefresh"),
  notifications: document.querySelector("#notifications"),
  notifyTest: document.querySelector("#notifyTest"),
  jobs: document.querySelector("#jobs"),
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
  toastRegion: document.querySelector("#toastRegion")
};

const metricIds = {
  passingPrs: "metricPassing",
  failingPrs: "metricFailing",
  runningPrs: "metricRunning",
  runningCd: "metricCd",
  failedCd: "metricFailedCd",
  repos: "metricRepos"
};

const navIds = {
  pass: "navPass",
  fail: "navFail",
  running: "navRunning",
  runningCd: "navRunningCd",
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

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: state.mode,
        view: state.view,
        filter: state.filter,
        notifications: state.notifications
      })
    );
  } catch {}
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
  return Object.values(row)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .join(" ")
    .toLowerCase();
}

function actionKey(row) {
  return row?.url || [row?.repo, row?.workflow, row?.runNumber, row?.number].filter(Boolean).join(":");
}

function prKey(row) {
  return row?.url || `${row?.repo || ""}#${row?.number || ""}`;
}

function buildActivitySnapshot(data) {
  return {
    includeCd: Boolean(data?.options?.includeCd),
    ci: new Map((data?.pullRequests?.running || []).map((row) => [prKey(row), row])),
    cd: new Map((data?.cd?.running || []).map((row) => [actionKey(row), row]))
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
  els.notifyTest.disabled = permission === "unsupported" || permission === "denied";
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

async function sendPopup(title, body, tag) {
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
    sendPopup(
      `CI ${stateLabel}`,
      `${completed.repo} ${completed.numberLabel}: ${completed.title}`,
      `ci:${key}:${stateLabel}`
    );
  }

  if (!previousSnapshot.includeCd || !nextSnapshot.includeCd) return;
  const failedCdByKey = new Map((data?.cd?.failed || []).map((row) => [actionKey(row), row]));
  for (const [key, previous] of previousSnapshot.cd) {
    if (nextSnapshot.cd.has(key)) continue;
    const failed = failedCdByKey.get(key);
    const statusLabel = failed ? `failed (${failed.conclusion})` : "finished";
    sendPopup(
      `CD ${statusLabel}`,
      `${previous.repo} ${previous.workflow} ${previous.runNumber}: ${previous.title || previous.branch}`,
      `cd:${key}:${statusLabel}`
    );
  }
}

function setLoading(isLoading) {
  els.loading.classList.toggle("hidden", !isLoading);
  els.refresh.disabled = isLoading;
}

function setError(message) {
  els.errorPanel.textContent = message || "";
  els.errorPanel.classList.toggle("hidden", !message);
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

function renderRefreshStatus() {
  const data = state.data;
  const tightest = tightestRateLimit(data);
  if (!els.autoRefresh.checked) {
    els.nextRefresh.textContent = "paused";
  } else if (!state.nextRefreshAt) {
    els.nextRefresh.textContent = "after first scan";
  } else {
    const remaining = new Date(state.nextRefreshAt).getTime() - Date.now();
    els.nextRefresh.textContent = `${formatDuration(remaining)} · ${state.refreshReason || "adaptive"}`;
  }

  if (tightest) {
    els.rateLimit.textContent = `${tightest.resource}: ${tightest.remaining}/${tightest.limit} · resets ${formatTime(tightest.resetAt)}`;
  } else if (data?.rateLimit) {
    els.rateLimit.textContent = `Quota: ${data.rateLimit.requestCount} requests this scan`;
  } else {
    els.rateLimit.textContent = "Quota: waiting";
  }
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

function buildParams() {
  return new URLSearchParams({
    mode: state.mode,
    includeCd: els.includeCd.checked ? "1" : "0",
    includeRunners: els.includeRunners.checked ? "1" : "0",
    includeRepoRunners: els.includeRepoRunners.checked ? "1" : "0",
    jobs: els.jobs.value || "4"
  });
}

async function refresh({ source = "manual" } = {}) {
  if (source === "manual") clearRefreshTimer();
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
    state.data = data;
    render();
    scheduleAutoRefresh(data);
  } catch (error) {
    setError(error.message);
    if (els.autoRefresh.checked && source === "auto") {
      state.nextRefreshAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      state.refreshReason = "error backoff";
      clearRefreshTimer();
      state.refreshTimer = setTimeout(() => refresh({ source: "auto" }), 5 * 60 * 1000);
      renderRefreshStatus();
    }
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
  const navCounts = {
    pass: data.summary.passingPrs,
    fail: data.summary.failingPrs,
    running: data.summary.runningPrs,
    runningCd: data.summary.runningCd,
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
    button.setAttribute("aria-current", isActive ? "true" : "false");
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

  renderRefreshStatus();
  renderMetrics(data);
  updateTabTitle(data);
  syncActiveAffordances();

  const view = views[state.view];
  els.viewKicker.textContent = view.kicker;
  els.viewTitle.textContent = view.title;

  const query = state.filter.trim().toLowerCase();
  const all = view.rows(data);
  const rows = query ? all.filter((row) => rowText(row).includes(query)) : all;
  syncFilterUI(rows.length, all.length);

  els.content.innerHTML = rows.length
    ? rows.map((row) => renderRow(row, state.view, view)).join("")
    : `<div class="empty">${escapeHtml(view.empty)}</div>`;
}

function renderRow(row, viewKey, view) {
  if (["pass", "fail", "running"].includes(viewKey)) return renderPrRow(row, view);
  if (["runningCd", "failedCd"].includes(viewKey)) return renderCdRow(row, view, viewKey);
  if (viewKey === "deployments") return renderDeploymentRow(row, view);
  return renderRunnerRow(row, view);
}

function renderPrRow(row, view) {
  const detail = row.runningChecks?.length ? row.runningChecks.join(", ") : `${row.checkCount} checks complete`;
  return `
    <article class="row" data-href="${escapeHtml(row.url || "")}" style="--accent: var(--${view.color}); --soft: var(--${view.color}-soft);">
      <div class="row-main">
        <div class="repo">${escapeHtml(row.repo)}</div>
        <div class="title">${escapeHtml(row.title)}</div>
      </div>
      <div class="meta">${escapeHtml(row.numberLabel)} · @${escapeHtml(row.author)}</div>
      <div class="tag">${escapeHtml(row.state.toUpperCase())}</div>
      <div class="meta">${escapeHtml(detail)}</div>
      <a class="open-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Open PR</a>
    </article>
  `;
}

function renderCdRow(row, view, viewKey) {
  const status = viewKey === "failedCd" ? row.conclusion : row.status;
  return `
    <article class="row" data-href="${escapeHtml(row.url || "")}" style="--accent: var(--${view.color}); --soft: var(--${view.color}-soft);">
      <div class="row-main">
        <div class="repo">${escapeHtml(row.repo)}</div>
        <div class="title">${escapeHtml(row.title || row.workflow)}</div>
      </div>
      <div class="meta">${escapeHtml(row.workflow)} ${escapeHtml(row.runNumber)}</div>
      <div class="tag">${escapeHtml(status)}</div>
      <div class="meta">${escapeHtml(row.branch)} · ${escapeHtml(formatTime(row.createdAt))}</div>
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

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  persist();
  refresh();
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

els.refresh.addEventListener("click", () => refresh());
els.includeCd.addEventListener("change", refresh);
els.includeRunners.addEventListener("change", refresh);
els.includeRepoRunners.addEventListener("change", () => {
  if (els.includeRepoRunners.checked) els.includeRunners.checked = true;
  refresh();
});
els.autoRefresh.addEventListener("change", () => {
  if (els.autoRefresh.checked && state.data) {
    scheduleAutoRefresh(state.data);
  } else {
    clearRefreshTimer();
    state.nextRefreshAt = null;
    renderRefreshStatus();
  }
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
els.notifyTest.addEventListener("click", async () => {
  state.notifications = true;
  persist();
  syncNotificationControl();
  const permission = await requestNotificationPermission();
  if (permission !== "granted") {
    showToast("Notifications blocked", "Chrome did not grant browser notification permission.");
    syncNotificationControl();
    return;
  }
  const displayed = await showBrowserNotification(
    "PR Command Deck test",
    "Browser notifications are wired up.",
    `notifications:test:${Date.now()}`
  );
  showToast(
    displayed ? "Test notification sent" : "Native notification failed",
    displayed ? "If no popup appeared, check macOS Focus or Chrome notification settings." : "In-app alerts will still appear here."
  );
  syncNotificationControl();
});
els.jobs.addEventListener("change", refresh);

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

  const n = Number(event.key);
  if (Number.isInteger(n) && n >= 1 && n <= viewOrder.length) {
    event.preventDefault();
    setView(viewOrder[n - 1]);
  }
});

/* —— restore persisted state into the form —— */
els.filter.value = state.filter;
syncNotificationControl();
ensureCountdownTimer();
refresh();
