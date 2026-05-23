import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createSign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 4177);
const githubApiBase = "https://api.github.com";
const githubGraphqlUrl = "https://api.github.com/graphql";
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_APP_PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH || "";
const APP_AUTH_ENABLED = Boolean(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY_PATH);
let githubTokenPromise;
const scanMetrics = new AsyncLocalStorage();
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'"
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

const PR_SEARCH_GRAPHQL = `
  query($q: String!, $endCursor: String) {
    search(type: ISSUE, query: $q, first: 100, after: $endCursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        __typename
        ... on PullRequest {
          number
          title
          url
          isDraft
          mergeable
          author {
            login
          }
          repository {
            nameWithOwner
            isArchived
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  contexts(first: 100) {
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        status
                        conclusion
                        checkSuite {
                          workflowRun {
                            workflow {
                              name
                            }
                          }
                        }
                      }
                      ... on StatusContext {
                        context
                        state
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PR_BY_NUMBER_GRAPHQL = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        title
        url
        isDraft
        mergeable
        headRefName
        headRepository {
          nameWithOwner
        }
        author {
          login
        }
        repository {
          nameWithOwner
          isArchived
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      checkSuite {
                        workflowRun {
                          workflow {
                            name
                          }
                        }
                      }
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const CD_WORKFLOW_PATTERN = /(^|[^A-Za-z0-9])(cd|deploy|deployment|release|publish)([^A-Za-z0-9]|$)/i;
const FAILED_CD_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const FINISHED_CD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHANGE_FILE_LINK_LIMIT = 14;
const MERGED_PR_SUMMARY_LIMIT = 10;
const MERGED_PR_FILE_DETAIL_FETCH_LIMIT = 4;
const MERGED_PR_FILE_LINK_LIMIT = 6;
const PRODUCTION_TARGET_SCAN_LIMIT = 80;
const PRODUCTION_TARGET_MAX_FILE_BYTES = 260000;
const QUOTA_SLOW_REMAINING = 200;
const QUOTA_SLOW_RATIO = 0.15;
const QUOTA_WARN_REMAINING = 500;
const QUOTA_WARN_RATIO = 0.3;
const CD_WORKFLOW_CACHE_TTL_MS = 15 * 60 * 1000;
const WORKFLOW_RUN_CACHE_TTL_MS = 60 * 1000;
const RUNNING_ACTION_CACHE_TTL_MS = 60 * 1000;
const RUNNING_DEPLOYMENT_CACHE_TTL_MS = 60 * 1000;
const OWNER_REPOS_CACHE_TTL_MS = 5 * 60 * 1000;
const DEPLOYMENT_TARGET_CACHE_TTL_MS = 10 * 60 * 1000;
const PRODUCTION_TARGET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MERGED_PR_CACHE_TTL_MS = 10 * 60 * 1000;
const RECENT_COMMIT_CACHE_TTL_MS = 5 * 60 * 1000;
const RUNNING_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const FAILED_RUN_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
const SKIPPED_RUN_CONCLUSIONS = new Set(["skipped"]);
const FAILED_JOB_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
const FAILED_CHECK_CONCLUSIONS = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const RUNNING_DEPLOYMENT_STATES = new Set(["queued", "pending", "in_progress"]);
const SUCCESSFUL_DEPLOYMENT_STATES = new Set(["success"]);
const AUTO_MERGE_DELAY_MS = 15 * 1000;
const AUTO_MERGE_SCAN_MS = 60 * 1000;
const FAILURE_REASON_LABELS = {
  FAILURE: "failed",
  ERROR: "errored",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed out",
  ACTION_REQUIRED: "requires action",
  STARTUP_FAILURE: "failed to start",
  failure: "failed",
  cancelled: "cancelled",
  timed_out: "timed out",
  action_required: "requires action",
  startup_failure: "failed to start"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const autoMergeState = {
  enabled: false,
  options: {
    mode: "all",
    jobs: 4
  },
  candidates: new Map(),
  running: false,
  timer: null,
  lastScanAt: null,
  lastError: ""
};

const githubValueCache = new Map();

function run(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function getPatToken() {
  if (!githubTokenPromise) {
    githubTokenPromise = (async () => {
      const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (envToken) return envToken;
      const token = (await run("gh", ["auth", "token"], { timeoutMs: 10000 })).trim();
      if (!token) {
        throw new Error("Set GITHUB_TOKEN/GH_TOKEN or authenticate GitHub CLI with `gh auth login`.");
      }
      return token;
    })();
  }
  return githubTokenPromise;
}

async function getGitHubToken({ ownerHint = null } = {}) {
  if (APP_AUTH_ENABLED) {
    return getInstallationToken(ownerHint);
  }
  const token = await getPatToken();
  return { token, installationKey: "pat" };
}

function extractOwnerFromPath(path) {
  if (!path) return null;
  let pathname = path;
  if (path.startsWith("http")) {
    try {
      const u = new URL(path);
      if (u.host !== "api.github.com") return null;
      pathname = u.pathname;
    } catch {
      return null;
    }
  }
  const parts = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [first, second] = parts;
  if (first === "repos" || first === "orgs" || first === "users") {
    return second;
  }
  return null;
}

function buildAppJwtPayload(appId, nowSeconds) {
  return {
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: String(appId)
  };
}

function signAppJwt({ appId, privateKey, nowSeconds }) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = buildAppJwtPayload(appId, nowSeconds);
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

function installationTokenIsValid(entry, nowSeconds) {
  return Boolean(entry && entry.expiresAt - 90 > nowSeconds);
}

function expandHomePath(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

let cachedAppJwt = null;
let cachedPrivateKey = null;
let installationsByOwner = null;
const installationTokensByOwner = new Map();

async function loadAppPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  const resolvedPath = expandHomePath(GITHUB_APP_PRIVATE_KEY_PATH);
  try {
    const stats = await stat(resolvedPath);
    if ((stats.mode & 0o077) !== 0) {
      console.warn(`[github-monitor] private key at ${resolvedPath} is readable by group/others; run: chmod 600 ${resolvedPath}`);
    }
  } catch (error) {
    throw new Error(`GitHub App private key not found at ${resolvedPath}: ${error.message}`);
  }
  cachedPrivateKey = await readFile(resolvedPath, "utf8");
  return cachedPrivateKey;
}

async function getAppJwt() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (cachedAppJwt && cachedAppJwt.expiresAt - 30 > nowSeconds) {
    return cachedAppJwt.token;
  }
  const privateKey = await loadAppPrivateKey();
  const token = signAppJwt({ appId: GITHUB_APP_ID, privateKey, nowSeconds });
  cachedAppJwt = { token, expiresAt: nowSeconds + 540 };
  return token;
}

async function appAuthorizedRequest(url, init = {}) {
  const jwt = await getAppJwt();
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "github-monitor-local",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub App request to ${url} failed (${response.status}): ${text}`);
  }
  return response.json();
}

async function discoverInstallations() {
  if (installationsByOwner) return installationsByOwner;
  const installations = await appAuthorizedRequest(`${githubApiBase}/app/installations?per_page=100`);
  const map = new Map();
  for (const inst of installations) {
    const owner = inst.account?.login;
    if (!owner) continue;
    map.set(owner.toLowerCase(), {
      installationId: inst.id,
      accountLogin: owner,
      accountType: inst.account.type
    });
  }
  installationsByOwner = map;
  return map;
}

async function mintInstallationToken(installationId) {
  const data = await appAuthorizedRequest(
    `${githubApiBase}/app/installations/${installationId}/access_tokens`,
    { method: "POST" }
  );
  return {
    token: data.token,
    expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000)
  };
}

async function getInstallationToken(ownerHint) {
  const installations = await discoverInstallations();
  if (installations.size === 0) {
    throw new Error("GitHub App has no installations. Install the app on at least one account.");
  }
  const lookupKey = ownerHint ? String(ownerHint).toLowerCase() : null;
  const installation = (lookupKey && installations.get(lookupKey)) || installations.values().next().value;
  const cacheKey = installation.accountLogin.toLowerCase();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = installationTokensByOwner.get(cacheKey);
  if (installationTokenIsValid(cached, nowSeconds)) {
    return { token: cached.token, installationKey: cacheKey };
  }
  const minted = await mintInstallationToken(installation.installationId);
  installationTokensByOwner.set(cacheKey, minted);
  return { token: minted.token, installationKey: cacheKey };
}

function githubUrl(path, query = {}) {
  const url = path.startsWith("http") ? new URL(path) : new URL(path, githubApiBase);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

const etagCache = new Map();
const ETAG_CACHE_DISABLED = process.env.ETAG_CACHE_DISABLED === "1";
const ETAG_CACHEABLE_METHODS = new Set(["GET", "HEAD"]);

function isEtagCacheEnabled() {
  return !ETAG_CACHE_DISABLED;
}

function applyConditionalHeaders(headers, store, url, method) {
  if (!ETAG_CACHEABLE_METHODS.has(method)) return headers;
  const cached = store.get(url);
  if (!cached?.etag) return headers;
  return { ...headers, "if-none-match": cached.etag };
}

function takeCachedConditionalResponse(store, url, method, status) {
  if (status !== 304) return null;
  if (!ETAG_CACHEABLE_METHODS.has(method)) return null;
  const cached = store.get(url);
  if (!cached) return null;
  return cached.body;
}

function storeConditionalResponse(store, url, method, response, body) {
  if (!ETAG_CACHEABLE_METHODS.has(method)) return false;
  const etag = response.headers.get("etag");
  if (!etag) {
    store.delete(url);
    return false;
  }
  store.set(url, { etag, body });
  return true;
}

async function githubRequest(path, { method = "GET", query = {}, body, ownerHint } = {}) {
  const effectiveOwnerHint = ownerHint || extractOwnerFromPath(path);
  const { token, installationKey } = await getGitHubToken({ ownerHint: effectiveOwnerHint });
  const url = githubUrl(path, query);
  const cacheKey = url.toString();
  const baseHeaders = {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "github-monitor-local",
    "x-github-api-version": "2022-11-28"
  };
  const headers = isEtagCacheEnabled()
    ? applyConditionalHeaders(baseHeaders, etagCache, cacheKey, method)
    : baseHeaders;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  recordRateLimit(response, { conditional: response.status === 304, installationKey });

  if (isEtagCacheEnabled()) {
    const cachedBody = takeCachedConditionalResponse(etagCache, cacheKey, method, response.status);
    if (cachedBody !== null) return cachedBody;
  }

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = json?.message || text || `GitHub API returned ${response.status}`;
    throw new HttpError(response.status, message);
  }
  if (isEtagCacheEnabled()) {
    storeConditionalResponse(etagCache, cacheKey, method, response, json);
  }
  return json;
}

function createScanMetrics() {
  return {
    startedAt: new Date().toISOString(),
    requestCount: 0,
    conditionalHits: 0
  };
}

// Server-wide rate-limit bucket cache. Keyed by `${resource}::${installationKey}`.
// Cumulative across scans so the dashboard chip shows a stable multi-installation
// view even when a single scan only happens to touch a subset of installations.
const observedRateBuckets = new Map();

function resetObservedRateBuckets() {
  observedRateBuckets.clear();
}

function recordRateLimit(response, { conditional = false, installationKey = "pat" } = {}) {
  const metrics = scanMetrics.getStore();
  if (metrics) {
    metrics.requestCount += 1;
    if (conditional) metrics.conditionalHits += 1;
  }

  const limit = Number(response.headers.get("x-ratelimit-limit"));
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const used = Number(response.headers.get("x-ratelimit-used"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const resource = response.headers.get("x-ratelimit-resource") || "core";
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) return;

  const resetAt = new Date(reset * 1000).toISOString();
  const key = `${resource}::${installationKey}`;
  const previous = observedRateBuckets.get(key);
  const bucket = {
    resource,
    installationKey,
    limit,
    remaining,
    used: Number.isFinite(used) ? used : null,
    resetAt
  };
  // Within a single reset window, only ratchet `remaining` downward — never let a
  // stale out-of-order response bump it back up. After the reset window changes,
  // accept the fresh quota as the new baseline.
  if (previous && previous.resetAt === bucket.resetAt && previous.remaining < remaining) {
    bucket.remaining = previous.remaining;
  }
  observedRateBuckets.set(key, bucket);
}

function snapshotRateLimit(metrics) {
  const buckets = [...observedRateBuckets.values()].sort((a, b) => {
    const ratioA = a.remaining / Math.max(1, a.limit);
    const ratioB = b.remaining / Math.max(1, b.limit);
    if (ratioA !== ratioB) return ratioA - ratioB;
    return a.resource.localeCompare(b.resource) || a.installationKey.localeCompare(b.installationKey);
  });
  const tightest = buckets[0] || null;
  const resources = [];
  const seenResource = new Set();
  for (const bucket of buckets) {
    if (seenResource.has(bucket.resource)) continue;
    seenResource.add(bucket.resource);
    resources.push(bucket);
  }
  return {
    requestCount: metrics?.requestCount ?? 0,
    conditionalHits: metrics?.conditionalHits ?? 0,
    resources,
    buckets,
    bucketCount: buckets.length,
    tightest
  };
}

async function cachedGithubValue(key, ttlMs, loader) {
  const now = Date.now();
  const cached = githubValueCache.get(key);
  if (cached?.value !== undefined && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      githubValueCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs
      });
      return value;
    })
    .catch((error) => {
      githubValueCache.delete(key);
      throw error;
    });

  githubValueCache.set(key, {
    promise,
    expiresAt: now + Math.min(ttlMs, 30 * 1000)
  });
  return promise;
}

function buildDashboardWarnings(rateLimit, summary, options) {
  const warnings = [];
  const quota = quotaState(rateLimit);
  const tightest = quota.tightest;
  if (!tightest || quota.status === "ok") return warnings;

  if (quota.status === "exhausted") {
    warnings.push(
      `GitHub ${tightest.resource} API quota is exhausted until ${new Date(quota.resetAt).toLocaleTimeString()}; refresh is paused.`
    );
  } else if (quota.blocked) {
    warnings.push(
      `GitHub ${tightest.resource} API quota is low (${tightest.remaining}/${tightest.limit}); refresh is paused until ${new Date(quota.resetAt).toLocaleTimeString()}.`
    );
  } else if (options.includeCd && quota.status === "watch") {
    warnings.push(
      `GitHub ${tightest.resource} API quota is getting tight (${tightest.remaining}/${tightest.limit}); refresh cadence has slowed.`
    );
  }
  if (options.includeCd && summary.finishedCd === 0 && quota.blocked) {
    warnings.push("Finished CD can appear empty when GitHub rate limits the workflow scan.");
  }
  return warnings;
}

function quotaState(rateLimit) {
  const tightest = rateLimit?.tightest || null;
  if (!tightest) return { status: "unknown", blocked: false, tightest: null };
  const remaining = Number(tightest.remaining);
  const limit = Math.max(1, Number(tightest.limit) || 1);
  const remainingRatio = remaining / limit;
  const resetAt = tightest.resetAt || "";
  const retryAfterSeconds = secondsUntil(resetAt) + 30;
  if (remaining <= 0) {
    return { status: "exhausted", blocked: true, tightest, resetAt, retryAfterSeconds };
  }
  if (remaining < QUOTA_SLOW_REMAINING || remainingRatio < QUOTA_SLOW_RATIO) {
    return { status: "low", blocked: true, tightest, resetAt, retryAfterSeconds };
  }
  if (remaining < QUOTA_WARN_REMAINING || remainingRatio < QUOTA_WARN_RATIO) {
    return { status: "watch", blocked: false, tightest, resetAt, retryAfterSeconds: 0 };
  }
  return { status: "ok", blocked: false, tightest, resetAt, retryAfterSeconds: 0 };
}

function recommendRefresh(summary, options, rateLimit) {
  const activeCount = summary.runningPrs + summary.runningCd + summary.runningDeployments + summary.busyRunners;
  const problemCount = summary.failingPrs + summary.failedCd;
  let intervalSeconds = activeCount > 0 ? 60 : problemCount > 0 ? 180 : 300;

  if (options.mode === "all") intervalSeconds += 60;
  if (options.includeCd) intervalSeconds += 60;
  if (options.includeRepoRunners) intervalSeconds += 120;

  const quota = quotaState(rateLimit);
  const tightest = quota.tightest;
  if (tightest) {
    if (quota.blocked) {
      intervalSeconds = Math.max(intervalSeconds, quota.retryAfterSeconds);
    } else if (quota.status === "watch") {
      intervalSeconds = Math.max(intervalSeconds, 420);
    }
  }

  intervalSeconds = Math.max(45, Math.min(intervalSeconds, quota.blocked ? 7200 : 3900));
  return {
    intervalSeconds,
    nextRefreshAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
    reason: refreshReason(activeCount, problemCount, quota),
    quota: {
      status: quota.status,
      blocked: quota.blocked,
      resource: tightest?.resource || "",
      remaining: tightest?.remaining ?? null,
      limit: tightest?.limit ?? null,
      resetAt: quota.resetAt || "",
      retryAfterSeconds: quota.retryAfterSeconds || 0
    }
  };
}

function secondsUntil(isoDate) {
  const delta = Math.ceil((new Date(isoDate).getTime() - Date.now()) / 1000);
  return Number.isFinite(delta) ? Math.max(0, delta) : 0;
}

function refreshReason(activeCount, problemCount, quota) {
  if (quota?.blocked) {
    return `Paused for ${quota.tightest.resource} API quota`;
  }
  if (quota?.status === "watch") {
    return `Slowed for ${quota.tightest.resource} API quota`;
  }
  if (activeCount > 0) return "Active work detected";
  if (problemCount > 0) return "Open failures detected";
  return "Quiet dashboard";
}

async function githubGraphql(query, variables) {
  const json = await githubRequest(githubGraphqlUrl, {
    method: "POST",
    body: { query, variables }
  });
  if (json?.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join("; "));
  }
  return json;
}

async function githubRestPage(path, page, perPage = 100, query = {}, ownerHint) {
  return githubRequest(path, { query: { ...query, per_page: perPage, page }, ownerHint });
}

async function githubRestAll(path, pickItems, perPage = 100, query = {}, ownerHint) {
  const results = [];
  for (let page = 1; page <= 50; page += 1) {
    const json = await githubRestPage(path, page, perPage, query, ownerHint);
    const items = pickItems(json);
    if (!items.length) break;
    results.push(...items);
    if (items.length < perPage) break;
  }
  return results;
}

async function mapLimit(items, limit, mapper) {
  const output = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      output[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return output;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMode(value) {
  if (["mine", "owned", "all"].includes(value)) return value;
  return "all";
}

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseJobs(value) {
  const jobs = Number(value || process.env.OPEN_PRS_JOBS || 4);
  if (!Number.isInteger(jobs) || jobs < 1) return 4;
  return Math.min(jobs, 16);
}

function parseRepo(value) {
  const repo = String(value || "").trim();
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) {
    throw new HttpError(400, "Expected repo in owner/name format.");
  }
  return { owner, name, repo };
}

function parsePullNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new HttpError(400, "Expected a positive pull request number.");
  }
  return number;
}

function isWithinFailedCdWindow(value, now = Date.now()) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && now - time <= FAILED_CD_MAX_AGE_MS;
}

function selectFailedCdRuns(runs, { now = Date.now() } = {}) {
  if (!Array.isArray(runs)) return [];
  return runs.filter((run) => {
    if (!run || run.status !== "completed") return false;
    if (!FAILED_RUN_CONCLUSIONS.has(run.conclusion)) return false;
    return isWithinFailedCdWindow(run.updated_at || run.created_at, now);
  });
}

function findSupersedingSuccessfulRun(completedRunsNewestFirst, failedRun) {
  if (!Array.isArray(completedRunsNewestFirst) || !failedRun) return null;
  const idx = completedRunsNewestFirst.indexOf(failedRun);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (runOutcome(completedRunsNewestFirst[i]) === "success") return completedRunsNewestFirst[i];
  }
  return null;
}

function isWithinFinishedCdWindow(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time <= FINISHED_CD_MAX_AGE_MS;
}

function checkFinished(check) {
  if (check.__typename === "CheckRun") return check.status === "COMPLETED";
  return check.state !== "PENDING" && check.state !== "EXPECTED";
}

function checkFailed(check) {
  const conclusion = check.__typename === "CheckRun" ? check.conclusion : check.state;
  return FAILED_CHECK_CONCLUSIONS.has(conclusion);
}

function checkName(check) {
  if (check.__typename === "CheckRun") {
    const workflow = check.checkSuite?.workflowRun?.workflow?.name;
    const prefix = workflow ? `${workflow}/` : "";
    return `${prefix}${check.name || "unnamed check"}`;
  }
  return check.context || "status context";
}

function failureLabel(value) {
  return FAILURE_REASON_LABELS[value] || String(value || "failed").toLowerCase().replaceAll("_", " ");
}

function failedCheckLabel(check) {
  const conclusion = check.__typename === "CheckRun" ? check.conclusion : check.state;
  return `${checkName(check)} ${failureLabel(conclusion)}`;
}

function failureReasonFromChecks(checks) {
  const failedChecks = [...new Set(checks.filter(checkFailed).map(failedCheckLabel))];
  if (!failedChecks.length) return { failedChecks, failureReason: "" };
  const suffix = failedChecks.length > 3 ? `, +${failedChecks.length - 3} more` : "";
  return {
    failedChecks,
    failureReason: `${failedChecks.slice(0, 3).join(", ")}${suffix}`
  };
}

function cdFailureReason(conclusion) {
  return `Workflow ${failureLabel(conclusion)}`;
}

function runOutcome(run) {
  const conclusion = String(run?.conclusion || "").toLowerCase();
  if (FAILED_RUN_CONCLUSIONS.has(conclusion)) return "failure";
  if (SKIPPED_RUN_CONCLUSIONS.has(conclusion)) return "skipped";
  if (conclusion === "success") return "success";
  if (conclusion === "neutral") return "success";
  return conclusion || "completed";
}

async function fetchWorkflowRunSkipReason(repo, run) {
  if (!run?.id) return "";
  try {
    const jobs = await githubRestAll(
      `/repos/${repo}/actions/runs/${run.id}/jobs`,
      (json) => json?.jobs || [],
      100,
      { filter: "latest" }
    );
    if (!jobs.length) return "";
    const skippedJobs = [...new Set(jobs.filter((job) => String(job.conclusion || "").toLowerCase() === "skipped").map((job) => job.name || "unnamed job"))];
    if (!skippedJobs.length) return "";
    const suffix = skippedJobs.length > 3 ? `, +${skippedJobs.length - 3} more` : "";
    return `Skipped jobs: ${skippedJobs.slice(0, 3).join(", ")}${suffix}`;
  } catch {
    return "";
  }
}

function shortSha(value) {
  return String(value || "").slice(0, 7);
}

function publicRouteFromFile(filename) {
  const path = String(filename || "").replaceAll("\\", "/").replace(/^src\//, "");
  const appMatch = path.match(/^app\/(.+)\.(?:jsx?|tsx?|mdx)$/);
  if (appMatch && ["page", "layout"].includes(appMatch[1].split("/").at(-1))) {
    return routeFromSegments(appMatch[1].split("/").slice(0, -1));
  }

  const pagesMatch = path.match(/^pages\/(.+)\.(?:jsx?|tsx?|mdx)$/);
  if (pagesMatch && !pagesMatch[1].startsWith("api/") && !pagesMatch[1].startsWith("_")) {
    return routeFromSegments(pagesMatch[1].split("/"));
  }

  const publicMatch = path.match(/^public\/(.+)$/);
  if (publicMatch && !publicMatch[1].startsWith(".")) {
    return `/${publicMatch[1].replace(/^index\.html$/, "")}`.replace(/\/$/, "/");
  }

  return "";
}

function routeFromSegments(segments) {
  const visible = segments
    .filter((segment) => segment && !segment.startsWith("(") && !segment.startsWith("@"))
    .map((segment) => segment.replace(/^index$/, "").replace(/^\[\.\.\.(.+)\]$/, ":$1").replace(/^\[(.+)\]$/, ":$1"))
    .filter(Boolean);
  return `/${visible.join("/")}`.replace(/\/+/g, "/");
}

function joinUrl(base, route) {
  if (!base || !route) return "";
  try {
    return new URL(route.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
  } catch {
    return "";
  }
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

const PRODUCTION_TLDS = new Set([
  "ai", "app", "au", "biz", "ca", "cc", "cloud", "co", "com", "de", "dev", "digital", "dk",
  "email", "es", "fi", "finance", "fr", "in", "info", "io", "is", "it", "link", "live", "me",
  "money", "net", "nl", "no", "org", "page", "se", "site", "software", "systems", "tech",
  "today", "tools", "tv", "uk", "us", "world", "xyz"
]);

function normalizeWebUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    const cleaned = trimmed.replace(/[),.;\]}]+$/, "");
    const url = new URL(cleaned.startsWith("http") ? cleaned : `https://${cleaned}`);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function likelyProductionUrl(value) {
  const url = normalizeWebUrl(value);
  if (!url) return "";
  try {
    const host = new URL(url).hostname;
    const tld = host.split(".").at(-1)?.toLowerCase() || "";
    if (!/^[a-z0-9.-]+$/i.test(host)) return "";
    if (!PRODUCTION_TLDS.has(tld)) return "";
    if ([
      "cjs", "css", "env", "example", "html", "js", "json", "jsx", "lock", "local", "map",
      "md", "mjs", "php", "py", "rb", "sh", "sitemap", "test", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml"
    ].includes(tld)) return "";
    if (host === "example.com" || host.endsWith(".example.com")) return "";
    if (host === "github.com" || host.endsWith(".github.com")) return "";
    if (host === "npmjs.com" || host.endsWith(".npmjs.com")) return "";
    if (host === "schema.org" || host.endsWith(".schema.org")) return "";
    if (host === "amazonaws.com" || host.endsWith(".amazonaws.com")) return "";
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return "";
    if (host.startsWith("docs.") || host.startsWith("www.docs.")) return "";
    return `${new URL(url).origin}/`;
  } catch {
    return "";
  }
}

function firstProductionUrl(values) {
  for (const value of values.flat().filter(Boolean)) {
    const url = likelyProductionUrl(value);
    if (url) return url;
  }
  return "";
}

function extractProductionUrlsFromText(text) {
  const source = String(text || "");
  const urls = [...source.matchAll(/https?:\/\/[^\s"'`<>)]+/gi)].map((match) => match[0]);
  const envUrls = [...source.matchAll(/\b(?:SITE_URL|APP_URL|PUBLIC_URL|NEXT_PUBLIC_SITE_URL|VITE_SITE_URL)\s*[:=]\s*["']?([^"'\s,}]+)/gi)]
    .map((match) => match[1]);
  const urlHosts = new Set(urls.map((value) => {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return "";
    }
  }).filter(Boolean));
  const bareDomains = [...source.matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s"'`<>)]*)?/gi)]
    .map((match) => match[0])
    .filter((value) => !value.includes("@"))
    .filter((value) => {
      try {
        return !urlHosts.has(new URL(`https://${value}`).hostname.toLowerCase());
      } catch {
        return true;
      }
    });
  return [...new Set([...urls, ...envUrls, ...bareDomains])];
}

function hostLooksDeployable(host) {
  return [
    ".cloudfront.net",
    ".vercel.app",
    ".netlify.app",
    ".amplifyapp.com",
    ".pages.dev",
    ".firebaseapp.com",
    ".web.app",
    ".onrender.com",
    ".fly.dev",
    ".herokuapp.com",
    ".azurewebsites.net"
  ].some((suffix) => host.endsWith(suffix));
}

function productionUrlScore(url, sourcePath, repo) {
  const normalized = likelyProductionUrl(url);
  if (!normalized) return 0;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return 0;
  }
  const host = parsed.hostname.toLowerCase();
  const source = String(sourcePath || "").toLowerCase();
  const repoName = repo.split("/").at(-1)?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
  const isProviderHost = hostLooksDeployable(host);
  let score = 1;
  if (parsed.protocol === "https:") score += 1;
  if (isProviderHost) score += 2;
  if (!isProviderHost) score += 7;
  if (repoName && host.replace(/[^a-z0-9]/g, "").includes(repoName)) score += 4;
  if (/(prod|production|domain|site|url|deploy|cloudfront|amplify|vercel|netlify)/.test(normalized.toLowerCase())) score += 3;
  if (/(readme|deploy|prod|production|infra|cdk|stack|cloudfront|route53|domain|config|env|serverless|terraform|sst)/.test(source)) score += 2;
  if (/cloudfront\.net$/.test(host)) score -= 3;
  if (/(test|spec|mock|fixture|example|sample)/.test(source)) score -= 3;
  if (/(amazonaws\.com\/documentation|docs\.aws\.amazon\.com|developer\.mozilla\.org|vitejs\.dev|nextjs\.org|react\.dev)/.test(host)) score = 0;
  return Math.max(0, score);
}

function bestProductionUrlCandidate(candidates, repo) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      url: likelyProductionUrl(candidate.url),
      score: productionUrlScore(candidate.url, candidate.source, repo)
    }))
    .filter((candidate) => candidate.url && candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))[0] || null;
}

function changeCue(filename, status = "") {
  const path = String(filename || "").toLowerCase();
  const action = status === "removed" ? "was removed" : status === "added" ? "was added" : "changed";
  if (/\.(css|scss|sass|less)$/.test(path)) return `Visual styling ${action}; check spacing, colors, responsive layout, and hover/focus states.`;
  if (/(^|\/)(page|layout)\.(jsx?|tsx?|mdx)$/.test(path) || /(^|\/)pages\/.+\.(jsx?|tsx?|mdx)$/.test(path)) {
    return `The rendered page ${action}; check copy, layout, primary actions, and empty/error states.`;
  }
  if (/\/components?\//.test(path) || /\.(jsx?|tsx?)$/.test(path)) return `Shared UI or client behavior ${action}; check screens that use this component.`;
  if (/\.(md|mdx)$/.test(path)) return `Content ${action}; check headings, links, and any rendered documentation page.`;
  if (/(^|\/)(api|server|route)\b/.test(path)) return `Backend or route behavior ${action}; check the user flow that depends on this endpoint.`;
  if (/(^|\/)(package-lock\.json|package\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path)) return `Dependencies ${action}; check build output and dependency-sensitive screens.`;
  if (/(^|\/)\.github\/workflows\//.test(path)) return `Automation ${action}; check that deployment and release steps still run as expected.`;
  return `File ${action}; check the nearby feature or content that depends on it.`;
}

function changeLabel(filename) {
  const route = publicRouteFromFile(filename);
  if (route) return route;
  return String(filename || "Changed file").split("/").at(-1) || "Changed file";
}

function buildChangedPages(files, deployTarget = {}) {
  const seen = new Set();
  return files
    .map((file) => {
      const route = publicRouteFromFile(file.filename);
      if (!route || seen.has(route)) return null;
      seen.add(route);
      const sourcePath = file.filename || "";
      return {
        label: route,
        path: route,
        url: joinUrl(deployTarget.url, route),
        sourcePath,
        sourceUrl: file.blob_url || "",
        environment: deployTarget.environment || "",
        lookFor: `${changeCue(sourcePath, file.status)}${route.includes(":") ? " Replace the route parameter with a real production item before checking." : ""}`
      };
    })
    .filter(Boolean);
}

const ROUTE_HINTS = [
  { pattern: /dashboard|overview|home/i, routes: ["/dashboard"] },
  { pattern: /signup|sign-up|register|registration/i, routes: ["/signup"] },
  { pattern: /login|log-in|signin|sign-in|magic[-_\s]?link|auth/i, routes: ["/login"] },
  { pattern: /invite|invitation/i, routes: ["/invitations", "/invite"] },
  { pattern: /assessment|audit|questionnaire/i, routes: ["/assessment"] },
  { pattern: /security|password|jwt|session/i, routes: ["/settings/security", "/login"] },
  { pattern: /transaction|transactions/i, routes: ["/transactions"] },
  { pattern: /plaid|depository|deposit|account|accounts/i, routes: ["/accounts"] },
  { pattern: /billing|subscription|plan|pricing/i, routes: ["/billing", "/settings/billing"] },
  { pattern: /profile|user|member/i, routes: ["/profile", "/settings/profile"] },
  { pattern: /settings|preferences/i, routes: ["/settings"] },
  { pattern: /admin/i, routes: ["/admin"] }
];

function inferredRoutesFromChange(title = "", files = []) {
  const source = [
    title,
    ...files.map((file) => file.filename || file.path || "")
  ].join(" ");
  const routes = [];
  for (const hint of ROUTE_HINTS) {
    if (!hint.pattern.test(source)) continue;
    routes.push(...hint.routes);
  }
  return [...new Set(routes)].slice(0, 4);
}

function buildInferredProductionPages(title, files, deployTarget = {}) {
  if (!deployTarget.url) return [];
  return inferredRoutesFromChange(title, files).map((route) => ({
    label: route,
    path: route,
    url: joinUrl(deployTarget.url, route),
    sourcePath: "inferred from PR title/files",
    sourceUrl: "",
    environment: deployTarget.environment || "production",
    lookFor: "Inferred production page; verify the affected behavior visually."
  }));
}

function buildMergedPullRequestSummary(pr, files = [], deployTarget = {}) {
  const visibleFiles = files.slice(0, MERGED_PR_FILE_LINK_LIMIT);
  const changedPages = buildChangedPages(files, deployTarget);
  const inferredPages = changedPages.length ? [] : buildInferredProductionPages(pr.title, files, deployTarget);
  const filesChanged = files.length || Number(pr.changed_files || 0);
  const productionUrl = deployTarget.url || "";
  return {
    number: pr.number,
    numberLabel: `#${pr.number}`,
    title: pr.title || "Merged pull request",
    author: pr.user?.login || "unknown",
    mergedAt: pr.merged_at || pr.closed_at || "",
    url: pr.html_url || "",
    productionUrl,
    productionEnvironment: deployTarget.environment || "",
    filesChanged,
    changedPages: changedPages.length ? changedPages : inferredPages,
    inferredPages: !changedPages.length && inferredPages.length > 0,
    changedFiles: visibleFiles.map((file) => ({
      path: file.filename || "",
      status: file.status || "",
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
      url: file.blob_url || "",
      lookFor: changeCue(file.filename, file.status)
    })),
    hiddenFileCount: Math.max(0, filesChanged - visibleFiles.length),
    lookFor: changedPages.length
      ? `Open ${changedPages.map((page) => page.label).slice(0, 3).join(", ")}${changedPages.length > 3 ? ", and related pages" : ""}; verify the behavior described by this PR.`
      : files.length
      ? `Open the PR files and verify the changed feature areas, especially ${visibleFiles.map((file) => file.filename).slice(0, 3).join(", ")}.`
      : "Open the PR and Files tab to verify what changed."
  };
}

function summarizeMergedPullRequests(pullRequests = [], deployTarget = {}) {
  return pullRequests.map((item) => buildMergedPullRequestSummary(item.pr, item.files, deployTarget));
}

function commitChangedPages(commit, deployTarget = {}) {
  return buildChangedPages(commit.files || [], deployTarget);
}

function buildCommitSummary(commit, deployTarget = {}) {
  const files = Array.isArray(commit.files) ? commit.files : [];
  const message = commit.commit?.message || "";
  const changedPages = commitChangedPages({ files }, deployTarget);
  const inferredPages = changedPages.length ? [] : buildInferredProductionPages(message, files, deployTarget);
  const visibleFiles = files.slice(0, MERGED_PR_FILE_LINK_LIMIT);
  const productionUrl = deployTarget.url || "";
  return {
    sha: commit.sha || "",
    shortSha: shortSha(commit.sha),
    message: message.split("\n").find(Boolean) || "Commit",
    author: commit.commit?.author?.name || commit.author?.login || "unknown",
    committedAt: commit.commit?.author?.date || commit.commit?.committer?.date || "",
    url: commit.html_url || "",
    productionUrl,
    productionEnvironment: deployTarget.environment || "",
    filesChanged: files.length,
    changedPages: changedPages.length ? changedPages : inferredPages,
    inferredPages: !changedPages.length && inferredPages.length > 0,
    changedFiles: visibleFiles.map((file) => ({
      path: file.filename || "",
      status: file.status || "",
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
      url: file.blob_url || "",
      lookFor: changeCue(file.filename, file.status)
    })),
    hiddenFileCount: Math.max(0, files.length - visibleFiles.length),
    lookFor: changedPages.length
      ? `Open ${changedPages.map((page) => page.label).slice(0, 3).join(", ")}${changedPages.length > 3 ? ", and related pages" : ""}; verify the behavior changed by this commit.`
      : files.length
      ? `Open the commit files and verify the changed areas, especially ${visibleFiles.map((file) => file.filename).slice(0, 3).join(", ")}.`
      : "Open the commit to inspect the shipped change."
  };
}

function buildReviewLinks(repo, branch = "") {
  const encodedQuery = encodeURIComponent(`is:pr is:merged sort:updated-desc`);
  const branchPath = branch ? `/${encodeURIComponent(branch)}` : "";
  return {
    mergedPullRequestsUrl: `https://github.com/${repo}/pulls?q=${encodedQuery}`,
    commitsUrl: `https://github.com/${repo}/commits${branchPath}`,
    compareHelpUrl: `https://github.com/${repo}/compare`,
    repoUrl: `https://github.com/${repo}`
  };
}

function buildChangeSummary(repo, run, changeSet, deployTarget = {}, options = {}) {
  const sha = run?.head_sha || changeSet?.sha || run?.head_commit?.id || "";
  const files = Array.isArray(changeSet?.files) ? changeSet.files : [];
  const additions = changeSet?.stats?.additions ?? files.reduce((total, file) => total + Number(file.additions || 0), 0);
  const deletions = changeSet?.stats?.deletions ?? files.reduce((total, file) => total + Number(file.deletions || 0), 0);
  const commitCount = Number(changeSet?.total_commits || changeSet?.commits?.length || (changeSet?.sha ? 1 : 0));
  const changedFiles = files.map((file) => ({
    path: file.filename || "",
    status: file.status || "",
    additions: Number(file.additions || 0),
    deletions: Number(file.deletions || 0),
    changes: Number(file.changes || 0),
    url: file.blob_url || ""
  }));
  const changedPages = buildChangedPages(files, deployTarget);
  const visibleFiles = changedFiles.slice(0, CHANGE_FILE_LINK_LIMIT);
  const hiddenFileCount = Math.max(0, changedFiles.length - visibleFiles.length);
  const latestCommit = Array.isArray(changeSet?.commits) ? changeSet.commits.at(-1) : null;
  const message = latestCommit?.commit?.message || changeSet?.commit?.message || run?.head_commit?.message || run?.display_title || "";
  const firstLine = message.split("\n").find(Boolean) || run?.display_title || "No commit message available";
  const source = options.source || (changeSet?.total_commits != null ? "compare" : "commit");
  const sourceLabel = source === "compare"
    ? `${shortSha(options.baseSha)}...${shortSha(sha)}`
    : shortSha(sha);

  return {
    sha,
    shortSha: shortSha(sha),
    baseSha: options.baseSha || "",
    source,
    sourceLabel,
    commitCount,
    commitUrl: changeSet?.html_url || "",
    message: firstLine,
    author: latestCommit?.commit?.author?.name || changeSet?.commit?.author?.name || run?.head_commit?.author?.name || "",
    filesChanged: changedFiles.length,
    additions: Number(additions || 0),
    deletions: Number(deletions || 0),
    deployUrl: deployTarget.url || "",
    environment: deployTarget.environment || "",
    changedPages,
    changedFiles: visibleFiles.map((file) => ({
      ...file,
      label: changeLabel(file.path),
      lookFor: changeCue(file.path, file.status)
    })),
    hiddenFileCount,
    mergedPullRequests: summarizeMergedPullRequests(options.mergedPullRequests, deployTarget),
    recentCommits: (options.recentCommits || []).map((commit) => buildCommitSummary(commit, deployTarget)),
    reviewLinks: buildReviewLinks(repo, run?.head_branch || ""),
    lookFor: changedPages.length
      ? `Open the changed page links and verify the rendered routes affected by ${changedPages.map((page) => page.sourcePath).slice(0, 3).join(", ")}${changedPages.length > 3 ? ", and related files" : ""}${source === "compare" ? " since the previous completed CD run" : ""}.`
      : options.mergedPullRequests?.length
      ? `No deployment diff was available for this run. Use the recent merged PR summary below to inspect the latest shipped work.`
      : options.recentCommits?.length
      ? `No deployment diff or merged PR metadata was available. Use the recent commit summary below to inspect the latest shipped work.`
      : `GitHub did not return deployment diff, merged PR, or commit metadata for this run. Use the manual review links below to inspect merged PRs, commit history, or compare changes in GitHub.`
  };
}

async function fetchWorkflowRunChangeSummary(repo, run, deployTarget, previousRun = null, mergedPullRequests = [], recentCommits = []) {
  const sha = run?.head_sha || run?.head_commit?.id;
  if (!sha) return buildChangeSummary(repo, run, null, deployTarget, { mergedPullRequests, recentCommits });
  const baseSha = previousRun?.head_sha || previousRun?.head_commit?.id || "";
  if (baseSha && baseSha !== sha) {
    try {
      const compare = await githubRequest(`/repos/${repo}/compare/${baseSha}...${sha}`);
      return buildChangeSummary(repo, run, compare, deployTarget, { source: "compare", baseSha, mergedPullRequests, recentCommits });
    } catch {
      // Fall back to the head commit below.
    }
  }
  try {
    const commit = await githubRequest(`/repos/${repo}/commits/${sha}`);
    return buildChangeSummary(repo, run, commit, deployTarget, { mergedPullRequests, recentCommits });
  } catch {
    return buildChangeSummary(repo, run, null, deployTarget, { mergedPullRequests, recentCommits });
  }
}

function failedJobLabel(job) {
  return `${job.name || "unnamed job"} ${failureLabel(job.conclusion)}`;
}

async function fetchWorkflowRunFailureReason(repo, run) {
  const fallback = cdFailureReason(run?.conclusion);
  if (!run?.id) return fallback;
  try {
    const jobs = await githubRestAll(
      `/repos/${repo}/actions/runs/${run.id}/jobs`,
      (json) => json?.jobs || [],
      100,
      { filter: "latest" }
    );
    const failedJobs = [...new Set(jobs.filter((job) => FAILED_JOB_CONCLUSIONS.has(job.conclusion)).map(failedJobLabel))];
    if (!failedJobs.length) return fallback;
    const suffix = failedJobs.length > 3 ? `, +${failedJobs.length - 3} more` : "";
    return `${failedJobs.slice(0, 3).join(", ")}${suffix}`;
  } catch {
    return fallback;
  }
}

function runningCheckLabel(check) {
  if (check.__typename === "CheckRun") {
    const workflow = check.checkSuite?.workflowRun?.workflow?.name;
    const prefix = workflow ? `${workflow}/` : "";
    return `${prefix}${check.name || "unnamed check"} [${check.status || "UNKNOWN"}]`;
  }
  return `${check.context || "status context"} [${check.state || "UNKNOWN"}]`;
}

function classifyPullRequest(pr) {
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes?.filter(Boolean) || [];
  const mergeable = pr.mergeable || "UNKNOWN";
  const hasConflict = mergeable === "CONFLICTING";
  const base = {
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    numberLabel: `#${pr.number}`,
    title: pr.title,
    author: pr.author?.login || "unknown",
    url: pr.url,
    isArchived: Boolean(pr.repository.isArchived),
    isDraft: Boolean(pr.isDraft),
    mergeable,
    hasConflict,
    headRefName: pr.headRefName || "",
    headRepo: pr.headRepository?.nameWithOwner || ""
  };
  if (!checks.length) {
    return { ...base, state: "pass", checkCount: 0, runningChecks: [] };
  }
  if (checks.every(checkFinished)) {
    const failure = failureReasonFromChecks(checks);
    return {
      ...base,
      state: checks.some(checkFailed) ? "fail" : "pass",
      checkCount: checks.length,
      runningChecks: [],
      failedChecks: failure.failedChecks,
      failureReason: failure.failureReason
    };
  }
  return {
    ...base,
    state: "running",
    checkCount: checks.length,
    runningChecks: [...new Set(checks.filter((check) => !checkFinished(check)).map(runningCheckLabel))]
  };
}

async function fetchPrQuery(queryText) {
  const pullRequests = [];
  let endCursor = null;
  for (let page = 0; page < 50; page += 1) {
    const json = await githubGraphql(PR_SEARCH_GRAPHQL, { q: queryText, endCursor });
    const search = json?.data?.search;
    if (!search) break;
    pullRequests.push(
      ...search.nodes
        .filter((node) => node?.__typename === "PullRequest")
        .map(classifyPullRequest)
        .filter((pr) => !pr.isArchived)
        .filter(Boolean)
    );
    if (!search.pageInfo?.hasNextPage) break;
    endCursor = search.pageInfo.endCursor;
  }
  return pullRequests;
}

async function fetchPullRequestByNumber(repo, number) {
  const { owner, name } = parseRepo(repo);
  const json = await githubGraphql(PR_BY_NUMBER_GRAPHQL, { owner, name, number });
  const pr = json?.data?.repository?.pullRequest;
  if (!pr) {
    throw new HttpError(404, `Pull request ${repo}#${number} was not found.`);
  }
  return classifyPullRequest(pr);
}

async function getAccount() {
  if (APP_AUTH_ENABLED) {
    const installations = await discoverInstallations();
    const first = installations.values().next().value;
    if (!first) {
      throw new Error("GitHub App has no installations. Install the app on at least one account.");
    }
    return first.accountLogin;
  }
  const user = await githubRequest("/user");
  return user.login;
}

async function allOwners(me) {
  return cachedGithubValue(`owners:${me}`, OWNER_REPOS_CACHE_TTL_MS, async () => {
    if (APP_AUTH_ENABLED) {
      const installations = await discoverInstallations();
      return Array.from(installations.values()).map((inst) => inst.accountLogin);
    }
    const orgs = await githubRestAll("/user/orgs", (json) => (Array.isArray(json) ? json : []));
    return [me, ...orgs.map((org) => org.login).filter(Boolean)];
  });
}

function openPullRequestSearchQuery(qualifier, value) {
  return `is:pr state:open archived:false ${qualifier}:${value}`;
}

async function fetchPullRequests({ mode, me, jobs }) {
  if (mode === "mine") return fetchPrQuery(openPullRequestSearchQuery("author", me));
  if (mode === "owned") return fetchPrQuery(openPullRequestSearchQuery("owner", me));
  const owners = await allOwners(me);
  const groups = await mapLimit(owners, jobs, async (owner) => {
    try {
      return await fetchPrQuery(openPullRequestSearchQuery("owner", owner));
    } catch {
      return [];
    }
  });
  return uniqueBy(groups.flat(), (pr) => pr.url);
}

async function fetchOwnerRepos(owner, me) {
  return cachedGithubValue(`owner-repos:${owner}:${me}`, OWNER_REPOS_CACHE_TTL_MS, async () => {
    if (APP_AUTH_ENABLED) {
      const installations = await discoverInstallations();
      const installation = installations.get(owner.toLowerCase());
      if (!installation) return [];
      const repos = await githubRestAll(
        "/installation/repositories",
        (json) => json?.repositories || [],
        100,
        {},
        owner
      );
      return repos
        .filter((repo) => !repo.archived && repo.owner?.login?.toLowerCase() === owner.toLowerCase())
        .map((repo) => repo.full_name);
    }
    if (owner === me) {
      const repos = await githubRestAll("/user/repos", (json) => (Array.isArray(json) ? json : []), 100, {
        affiliation: "owner"
      });
      return repos.filter((repo) => !repo.archived && repo.owner?.login === me).map((repo) => repo.full_name);
    }
    const repos = await githubRestAll(`/orgs/${owner}/repos`, (json) => (Array.isArray(json) ? json : []));
    return repos.filter((repo) => !repo.archived).map((repo) => repo.full_name);
  });
}

async function listRepos({ mode, me, pullRequests, jobs }) {
  if (mode === "mine") return [...new Set(pullRequests.map((pr) => pr.repo))].sort();
  if (mode === "owned") return fetchOwnerRepos(me, me);
  const owners = await allOwners(me);
  const groups = await mapLimit(owners, jobs, async (owner) => {
    try {
      return await fetchOwnerRepos(owner, me);
    } catch {
      return [];
    }
  });
  return [...new Set(groups.flat())].sort();
}

function isCdWorkflow(workflow) {
  return CD_WORKFLOW_PATTERN.test(workflow.name || "") || CD_WORKFLOW_PATTERN.test(workflow.path || "");
}

function isCdWorkflowRun(run) {
  return CD_WORKFLOW_PATTERN.test(run.name || "") || CD_WORKFLOW_PATTERN.test(run.path || "");
}

async function fetchCdWorkflows(repo) {
  return cachedGithubValue(`cd-workflows:${repo}`, CD_WORKFLOW_CACHE_TTL_MS, async () => {
    const workflows = await githubRestAll(`/repos/${repo}/actions/workflows`, (json) => json?.workflows || []);
    return workflows.filter((workflow) => workflow.state === "active" && isCdWorkflow(workflow));
  });
}

async function fetchWorkflowRuns(repo, workflowId, params) {
  const cacheKey = `workflow-runs:${repo}:${workflowId}:${JSON.stringify(params || {})}`;
  return cachedGithubValue(cacheKey, WORKFLOW_RUN_CACHE_TTL_MS, async () => {
    const path = `/repos/${repo}/actions/workflows/${workflowId}/runs`;
    const json = await githubRequest(path, { query: params });
    return json?.workflow_runs || [];
  });
}

async function fetchRecentDeploymentTargets(repo) {
  return cachedGithubValue(`deployment-targets:${repo}`, DEPLOYMENT_TARGET_CACHE_TTL_MS, async () => {
    const targets = new Map();
    let deployments = [];
    try {
      deployments = await githubRestAll(`/repos/${repo}/deployments`, (json) => (Array.isArray(json) ? json : []), 20);
    } catch {
      return targets;
    }

    for (const deployment of deployments.slice(0, 20)) {
      if (!deployment.statuses_url || targets.has(deployment.ref)) continue;
      try {
        const statuses = await githubRestPage(deployment.statuses_url, 1, 1);
        const latest = Array.isArray(statuses) ? statuses[0] : null;
        const url = latest?.target_url || latest?.environment_url || "";
        if (latest && SUCCESSFUL_DEPLOYMENT_STATES.has(latest.state) && url) {
          targets.set(deployment.ref || "", {
            url,
            environment: deployment.environment || latest.environment || ""
          });
        }
      } catch {
        continue;
      }
    }

    return targets;
  });
}

async function fetchRepoProductionTarget(repo) {
  return cachedGithubValue(`production-target:${repo}`, PRODUCTION_TARGET_CACHE_TTL_MS, async () => {
    let metadata = null;
    try {
      metadata = await githubRequest(`/repos/${repo}`);
      const homepage = likelyProductionUrl(metadata?.homepage);
      if (homepage) {
        return {
          url: homepage,
          environment: "production",
          source: "repository homepage"
        };
      }
    } catch {}

    const defaultBranch = metadata?.default_branch || "";
    const codeTarget = await fetchRepoProductionTargetFromCode(repo, defaultBranch);
    if (codeTarget.url) return codeTarget;
    const scanTarget = await fetchRepoProductionTargetFromTree(repo, defaultBranch);
    if (scanTarget.url) return scanTarget;
    return {};
  });
}

async function fetchRepoTextFile(repo, path, ref = "") {
  try {
    const json = await githubRequest(`/repos/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`, {
      query: { ref }
    });
    if (json?.type !== "file" || !json.content) return "";
    if (json.encoding === "base64") {
      return Buffer.from(json.content.replace(/\s/g, ""), "base64").toString("utf8");
    }
    return String(json.content || "");
  } catch {
    return "";
  }
}

function productionUrlFromPackageJson(text) {
  try {
    const pkg = JSON.parse(text);
    return firstProductionUrl([
      pkg.homepage,
      pkg.config?.homepage,
      pkg.config?.site,
      pkg.config?.url,
      pkg.site,
      pkg.url
    ]);
  } catch {
    return "";
  }
}

function productionUrlFromCname(text) {
  const line = String(text || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line ? likelyProductionUrl(line) : "";
}

async function fetchRepoProductionTargetFromCode(repo, ref = "") {
  const packageJson = await fetchRepoTextFile(repo, "package.json", ref);
  const packageUrl = productionUrlFromPackageJson(packageJson);
  if (packageUrl) {
    return { url: packageUrl, environment: "production", source: "package.json homepage" };
  }

  for (const cnamePath of ["public/CNAME", "CNAME"]) {
    const cname = productionUrlFromCname(await fetchRepoTextFile(repo, cnamePath, ref));
    if (cname) {
      return { url: cname, environment: "production", source: cnamePath };
    }
  }

  const configPaths = [
    "vercel.json",
    "netlify.toml",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "vite.config.js",
    "vite.config.ts",
    "astro.config.mjs",
    "nuxt.config.js",
    "nuxt.config.ts",
    "svelte.config.js"
  ];
  for (const path of configPaths) {
    const text = await fetchRepoTextFile(repo, path, ref);
    const url = firstProductionUrl(extractProductionUrlsFromText(text));
    if (url) {
      return { url, environment: "production", source: path };
    }
  }

  return {};
}

function isProductionTargetScanPath(path) {
  const normalized = String(path || "").toLowerCase();
  if (!normalized || normalized.includes("node_modules/") || normalized.includes("dist/") || normalized.includes("build/")) return false;
  if (normalized.includes(".git/") || normalized.includes("coverage/") || normalized.includes("__snapshots__/")) return false;
  if (/(^|\/)(readme|deploy|deployment|production|prod|env|domain|domains|site|config|settings|constants|outputs|cloudfront|route53|serverless|sst|amplify|vercel|netlify|terraform|cdk|stack|stacks|infra|infrastructure)([-_.][^/]*)?\.(md|txt|json|js|mjs|cjs|ts|tsx|yml|yaml|toml|tf|env|example)$/i.test(path)) {
    return true;
  }
  if (/(^|\/)(package\.json|cname|\.env\.example|\.env\.production|\.env\.production\.example|vercel\.json|netlify\.toml|serverless\.ya?ml|sst\.config\.(js|ts)|amplify\.ya?ml)$/i.test(path)) {
    return true;
  }
  if (/^(infra|infrastructure|cdk|stacks?|lib|config|deploy|deployment|scripts|\.github\/workflows)\//i.test(path) && /\.(md|txt|json|js|mjs|cjs|ts|tsx|yml|yaml|toml|tf|env|example)$/i.test(path)) {
    return true;
  }
  return false;
}

async function fetchRepoTree(repo, ref = "") {
  const treeRef = ref || "HEAD";
  try {
    const json = await githubRequest(`/repos/${repo}/git/trees/${encodeURIComponent(treeRef)}`, {
      query: { recursive: "1" }
    });
    return Array.isArray(json?.tree) ? json.tree : [];
  } catch {
    return [];
  }
}

async function fetchRepoProductionTargetFromTree(repo, ref = "") {
  const tree = await fetchRepoTree(repo, ref);
  const candidates = [];
  const files = tree
    .filter((item) => item.type === "blob" && isProductionTargetScanPath(item.path))
    .filter((item) => !item.size || item.size <= PRODUCTION_TARGET_MAX_FILE_BYTES)
    .sort((a, b) => a.path.length - b.path.length)
    .slice(0, PRODUCTION_TARGET_SCAN_LIMIT);

  for (const file of files) {
    const text = await fetchRepoTextFile(repo, file.path, ref);
    for (const url of extractProductionUrlsFromText(text)) {
      candidates.push({ url, source: file.path });
    }
    if (file.path.toLowerCase().endsWith("cname")) {
      const cname = productionUrlFromCname(text);
      if (cname) candidates.push({ url: cname, source: file.path });
    }
  }

  const best = bestProductionUrlCandidate(candidates, repo);
  return best
    ? {
        url: best.url,
        environment: "production",
        source: best.source
      }
    : {};
}

async function fetchPullRequestFiles(repo, number) {
  return cachedGithubValue(`pr-files:${repo}:${number}`, MERGED_PR_CACHE_TTL_MS, async () => {
    try {
      const files = await githubRestPage(`/repos/${repo}/pulls/${number}/files`, 1, 100);
      return Array.isArray(files) ? files : [];
    } catch {
      return [];
    }
  });
}

async function fetchMergedPullRequestsFromList(repo) {
  const pulls = await githubRestPage(`/repos/${repo}/pulls`, 1, 100, {
    state: "closed",
    sort: "updated",
    direction: "desc"
  });
  return (Array.isArray(pulls) ? pulls : [])
    .filter((pr) => pr.merged_at)
    .sort((a, b) => String(b.merged_at || "").localeCompare(String(a.merged_at || "")))
    .slice(0, MERGED_PR_SUMMARY_LIMIT);
}

async function fetchMergedPullRequestsFromSearch(repo) {
  const json = await githubRequest("/search/issues", {
    query: {
      q: `repo:${repo} is:pr is:merged`,
      sort: "updated",
      order: "desc",
      per_page: MERGED_PR_SUMMARY_LIMIT
    }
  });
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.map((item) => ({
    number: item.number,
    title: item.title,
    merged_at: item.closed_at || item.updated_at || "",
    closed_at: item.closed_at || "",
    html_url: item.html_url || "",
    user: item.user || null
  }));
}

async function fetchRecentMergedPullRequests(repo) {
  return cachedGithubValue(`merged-prs:${repo}`, MERGED_PR_CACHE_TTL_MS, async () => {
    try {
      let merged = await fetchMergedPullRequestsFromList(repo);
      if (!merged.length) {
        merged = await fetchMergedPullRequestsFromSearch(repo);
      }
      return mapLimit(merged, 4, async (pr, index) => ({
        pr,
        files: index < MERGED_PR_FILE_DETAIL_FETCH_LIMIT ? await fetchPullRequestFiles(repo, pr.number) : []
      }));
    } catch {
      return [];
    }
  });
}

async function fetchRecentCommits(repo, branch = "") {
  return cachedGithubValue(`recent-commits:${repo}:${branch || "default"}`, RECENT_COMMIT_CACHE_TTL_MS, async () => {
    try {
      const commits = await githubRestPage(`/repos/${repo}/commits`, 1, MERGED_PR_SUMMARY_LIMIT, {
        sha: branch || undefined
      });
      const recent = Array.isArray(commits) ? commits.slice(0, MERGED_PR_SUMMARY_LIMIT) : [];
      return mapLimit(recent, 4, async (commit) => {
        try {
          return await githubRequest(`/repos/${repo}/commits/${commit.sha}`);
        } catch {
          return commit;
        }
      });
    } catch {
      return [];
    }
  });
}

async function fetchCdForRepo(repo) {
  const failed = [];
  const finished = [];
  const running = [];
  const failureReasons = new Map();
  const changeSummaries = new Map();
  let deploymentTargetsPromise = null;
  let repoProductionTargetPromise = null;
  let mergedPullRequestsPromise = null;
  let recentCommitsPromise = null;
  let workflows = [];
  try {
    workflows = await fetchCdWorkflows(repo);
  } catch {
    return { failed, finished, running };
  }
  for (const workflow of workflows) {
    try {
      const recentWorkflowRuns = await fetchWorkflowRuns(repo, workflow.id, { per_page: 20 });
      const completedRuns = recentWorkflowRuns.filter((run) => run.status === "completed");
      for (const failedRun of selectFailedCdRuns(completedRuns)) {
        const failedAt = failedRun.updated_at || failedRun.created_at;
        const failureReason = await fetchWorkflowRunFailureReason(repo, failedRun);
        failureReasons.set(failedRun.id, failureReason);
        const supersedingRun = findSupersedingSuccessfulRun(completedRuns, failedRun);
        const resolvedBy = supersedingRun
          ? {
              runNumber: `#${supersedingRun.run_number}`,
              url: supersedingRun.html_url || "",
              conclusion: supersedingRun.conclusion || "",
              createdAt: supersedingRun.updated_at || supersedingRun.created_at || ""
            }
          : null;
        failed.push({
          createdAt: failedAt,
          repo,
          workflow: workflow.name,
          runNumber: `#${failedRun.run_number}`,
          conclusion: failedRun.conclusion || "",
          failureReason,
          branch: failedRun.head_branch || "",
          title: failedRun.display_title || "",
          url: failedRun.html_url || "",
          resolvedBy
        });
      }
      for (const [runIndex, run] of completedRuns.entries()) {
        const finishedAt = run.updated_at || run.created_at;
        if (!isWithinFinishedCdWindow(finishedAt)) continue;
        const outcome = runOutcome(run);
        const failureReason = FAILED_RUN_CONCLUSIONS.has(run.conclusion)
          ? failureReasons.get(run.id) || await fetchWorkflowRunFailureReason(repo, run)
          : "";
        if (failureReason) failureReasons.set(run.id, failureReason);
        const skipReason = outcome === "skipped"
          ? await fetchWorkflowRunSkipReason(repo, run)
          : "";
        deploymentTargetsPromise ||= fetchRecentDeploymentTargets(repo);
        const deploymentTargets = await deploymentTargetsPromise;
        let deployTarget = deploymentTargets.get(run.head_branch || "") || deploymentTargets.get("") || {};
        if (!deployTarget.url) {
          repoProductionTargetPromise ||= fetchRepoProductionTarget(repo);
          deployTarget = await repoProductionTargetPromise || {};
        }
        const changeKey = run.head_sha || run.head_commit?.id || run.id;
        if (!changeSummaries.has(changeKey)) {
          mergedPullRequestsPromise ||= fetchRecentMergedPullRequests(repo);
          const mergedPullRequests = await mergedPullRequestsPromise;
          let recentCommits = [];
          if (!mergedPullRequests.length) {
            recentCommitsPromise ||= fetchRecentCommits(repo, run.head_branch || "");
            recentCommits = await recentCommitsPromise;
          }
          const previousRun = completedRuns.slice(runIndex + 1).find((item) => item.head_sha || item.head_commit?.id);
          changeSummaries.set(
            changeKey,
            await fetchWorkflowRunChangeSummary(repo, run, deployTarget, previousRun, mergedPullRequests, recentCommits)
          );
        }
        finished.push({
          createdAt: finishedAt,
          repo,
          workflow: workflow.name,
          runNumber: `#${run.run_number}`,
          conclusion: run.conclusion || "",
          outcome,
          failureReason,
          skipReason,
          branch: run.head_branch || "",
          title: run.display_title || "",
          url: run.html_url || "",
          changeSummary: changeSummaries.get(changeKey)
        });
      }

      for (const run of recentWorkflowRuns.filter((item) => RUNNING_RUN_STATUSES.has(item.status))) {
        running.push({
          createdAt: run.created_at,
          repo,
          workflow: workflow.name,
          runNumber: `#${run.run_number}`,
          status: run.status || "",
          branch: run.head_branch || "",
          title: run.display_title || "",
          url: run.html_url || ""
        });
      }
    } catch {
      continue;
    }
  }
  return { failed, finished, running };
}

async function fetchRunningActionsForRepo(repo) {
  return cachedGithubValue(`running-actions:${repo}`, RUNNING_ACTION_CACHE_TTL_MS, async () => {
    try {
      const json = await githubRequest(`/repos/${repo}/actions/runs`, { query: { per_page: 20 } });
      const runs = json?.workflow_runs || [];
      return runs
        .filter((run) => RUNNING_RUN_STATUSES.has(run.status))
        .filter((run) => !isCdWorkflowRun(run))
        .map((run) => ({
          kind: "workflowRun",
          createdAt: run.created_at || "",
          repo,
          workflow: run.name || "Workflow",
          runNumber: `#${run.run_number}`,
          status: run.status || "",
          branch: run.head_branch || "",
          title: run.display_title || run.name || "",
          url: run.html_url || ""
        }));
    } catch {
      return [];
    }
  });
}

async function fetchRunningDeploymentsForRepo(repo) {
  return cachedGithubValue(`running-deployments:${repo}`, RUNNING_DEPLOYMENT_CACHE_TTL_MS, async () => {
    const running = [];
    let deployments = [];
    try {
      deployments = await githubRestAll(`/repos/${repo}/deployments`, (json) => (Array.isArray(json) ? json : []), 20);
    } catch {
      return running;
    }
    for (const deployment of deployments.slice(0, 20)) {
      if (!deployment.statuses_url) continue;
      try {
        const statuses = await githubRestPage(deployment.statuses_url, 1, 1);
        const latest = Array.isArray(statuses) ? statuses[0] : null;
        if (latest && RUNNING_DEPLOYMENT_STATES.has(latest.state)) {
          running.push({
            createdAt: latest.created_at || deployment.created_at || "",
            repo,
            environment: deployment.environment || "",
            ref: deployment.ref || "",
            state: latest.state || "",
            task: deployment.task || "",
            description: latest.description || "",
            url: latest.target_url || latest.log_url || deployment.url || ""
          });
        }
      } catch {
        continue;
      }
    }
    return running;
  });
}

async function fetchBusyRepoRunners(repo) {
  try {
    const runners = await githubRestAll(`/repos/${repo}/actions/runners`, (json) => json?.runners || []);
    return runners.filter((runner) => runner.busy).map((runner) => ({
      level: "REPO",
      scope: repo,
      name: runner.name,
      status: runner.status || "",
      labels: (runner.labels || []).map((label) => label.name).filter(Boolean)
    }));
  } catch {
    return [];
  }
}

async function fetchBusyOrgRunners(owner) {
  try {
    const runners = await githubRestAll(`/orgs/${owner}/actions/runners`, (json) => json?.runners || []);
    return runners.filter((runner) => runner.busy).map((runner) => ({
      level: "ORG",
      scope: owner,
      name: runner.name,
      status: runner.status || "",
      labels: (runner.labels || []).map((label) => label.name).filter(Boolean)
    }));
  } catch {
    return [];
  }
}

async function fetchBusyRunners({ includeRepoRunners, repos, pullRequests, mode, me, jobs }) {
  const ownerSet = new Set();
  for (const pr of pullRequests) ownerSet.add(pr.repo.split("/")[0]);
  for (const repo of repos) ownerSet.add(repo.split("/")[0]);
  if (mode === "all") {
    for (const owner of await allOwners(me)) ownerSet.add(owner);
  }
  if (mode === "owned") ownerSet.add(me);

  const orgGroups = await mapLimit([...ownerSet].sort(), jobs, fetchBusyOrgRunners);
  const repoGroups = includeRepoRunners
    ? await mapLimit(repos, jobs, fetchBusyRepoRunners)
    : [];
  return uniqueBy([...orgGroups.flat(), ...repoGroups.flat()], (runner) =>
    [runner.level, runner.scope, runner.name].join(":")
  );
}

async function buildBusyRunnerData(requestUrl) {
  const params = requestUrl.searchParams;
  const mode = normalizeMode(params.get("mode"));
  const jobs = parseJobs(params.get("jobs"));
  const includeRepoRunners = parseBool(params.get("includeRepoRunners"), false);
  const me = await getAccount();
  const pullRequests = await fetchPullRequests({ mode, me, jobs });
  const repos = includeRepoRunners ? await listRepos({ mode, me, pullRequests, jobs }) : [];
  const busyRunners = await fetchBusyRunners({ includeRepoRunners, repos, pullRequests, mode, me, jobs });
  const sortedBusyRunners = busyRunners.sort((a, b) =>
    `${a.level}/${a.scope}/${a.name}`.localeCompare(`${b.level}/${b.scope}/${b.name}`)
  );
  return {
    account: me,
    generatedAt: new Date().toISOString(),
    options: { mode, jobs, includeRepoRunners },
    summary: {
      busyRunners: sortedBusyRunners.length,
      repos: repos.length || new Set(pullRequests.map((pr) => pr.repo)).size
    },
    runners: {
      busy: sortedBusyRunners
    },
    rateLimit: snapshotRateLimit(scanMetrics.getStore() || createScanMetrics())
  };
}

async function buildDashboardData(requestUrl) {
  const params = requestUrl.searchParams;
  const mode = normalizeMode(params.get("mode"));
  const jobs = parseJobs(params.get("jobs"));
  const includeCd = parseBool(params.get("includeCd"), true);
  const includeRunners = parseBool(params.get("includeRunners"), false) || parseBool(params.get("includeRepoRunners"), false);
  const includeRepoRunners = parseBool(params.get("includeRepoRunners"), false);
  const me = await getAccount();
  const pullRequests = await fetchPullRequests({ mode, me, jobs });
  let repos = [];
  let failedCd = [];
  let finishedCd = [];
  let runningCd = [];
  let runningActions = [];
  let runningDeployments = [];
  let busyRunners = [];

  repos = await listRepos({ mode, me, pullRequests, jobs });

  if (repos.length) {
    const actionGroups = await mapLimit(repos, jobs, fetchRunningActionsForRepo);
    runningActions = uniqueBy(actionGroups.flat(), (run) => run.url || JSON.stringify(run));
  }

  if (includeCd && repos.length) {
    const cdGroups = await mapLimit(repos, jobs, fetchCdForRepo);
    failedCd = uniqueBy(cdGroups.flatMap((group) => group.failed), (run) => run.url || JSON.stringify(run))
      .filter((run) => !run.resolvedBy);
    finishedCd = uniqueBy(cdGroups.flatMap((group) => group.finished), (run) => run.url || JSON.stringify(run));
    runningCd = uniqueBy(cdGroups.flatMap((group) => group.running), (run) => run.url || JSON.stringify(run));
    const deploymentGroups = await mapLimit(repos, jobs, fetchRunningDeploymentsForRepo);
    runningDeployments = uniqueBy(deploymentGroups.flat(), (deployment) => deployment.url || JSON.stringify(deployment));
  }

  if (includeRunners) {
    busyRunners = await fetchBusyRunners({ includeRepoRunners, repos, pullRequests, mode, me, jobs });
  }

  const prGroups = groupPullRequests(pullRequests);
  syncAutoMergeFromStatus(pullRequests, { mode, jobs });
  const summary = {
    repos: repos.length || new Set(pullRequests.map((pr) => pr.repo)).size,
    passingPrs: prGroups.pass.length,
    noCiPrs: prGroups.noCi.length,
    failingPrs: prGroups.fail.length,
    runningPrs: prGroups.running.length + runningActions.length,
    conflictPrs: prGroups.conflicts.length,
    runningCd: runningCd.length,
    finishedCd: finishedCd.length,
    skippedCd: finishedCd.filter((row) => row.outcome === "skipped").length,
    runningDeployments: runningDeployments.length,
    busyRunners: busyRunners.length,
    failedCd: failedCd.length
  };
  const rateLimit = snapshotRateLimit(scanMetrics.getStore() || createScanMetrics());
  const warnings = buildDashboardWarnings(rateLimit, summary, { mode, jobs, includeCd, includeRunners, includeRepoRunners });

  return {
    account: me,
    generatedAt: new Date().toISOString(),
    options: { mode, jobs, includeCd, includeRunners, includeRepoRunners },
    summary,
    rateLimit,
    warnings,
    refresh: recommendRefresh(summary, { mode, jobs, includeCd, includeRunners, includeRepoRunners }, rateLimit),
    pullRequests: prGroups,
    actions: {
      running: runningActions.sort(sortByCreatedDesc)
    },
    cd: {
      running: runningCd.sort(sortByCreatedDesc),
      finished: finishedCd.sort(sortByCreatedDesc),
      failed: failedCd.sort(sortByCreatedDesc)
    },
    deployments: {
      running: runningDeployments.sort(sortByCreatedDesc)
    },
    runners: {
      busy: busyRunners.sort((a, b) => `${a.scope}/${a.name}`.localeCompare(`${b.scope}/${b.name}`))
    },
    autoMerge: autoMergeSnapshot()
  };
}

function autoMergeKey(repo, number) {
  return `${repo}#${number}`;
}

function autoMergeSnapshot() {
  return {
    enabled: autoMergeState.enabled,
    running: autoMergeState.running,
    mode: autoMergeState.options.mode,
    jobs: autoMergeState.options.jobs,
    lastScanAt: autoMergeState.lastScanAt,
    lastError: autoMergeState.lastError,
    candidates: [...autoMergeState.candidates.values()]
      .map((candidate) => ({
        repo: candidate.repo,
        number: candidate.number,
        numberLabel: candidate.numberLabel,
        title: candidate.title,
        url: candidate.url,
        deadline: new Date(candidate.deadline).toISOString(),
        error: candidate.error || ""
      }))
      .sort(sortByRepoAndNumber)
  };
}

function clearAutoMergeTimer() {
  if (!autoMergeState.timer) return;
  clearTimeout(autoMergeState.timer);
  autoMergeState.timer = null;
}

function scheduleAutoMergeScan(delayMs = 0) {
  if (!autoMergeState.enabled || autoMergeState.timer || autoMergeState.running) return;
  autoMergeState.timer = setTimeout(runAutoMergeScan, Math.max(0, delayMs));
}

function syncAutoMergeCandidates(pullRequests) {
  const now = Date.now();
  const eligibleKeys = new Set();
  for (const pr of pullRequests) {
    if (!isAutoMergeCandidate(pr)) continue;
    const key = autoMergeKey(pr.repo, pr.number);
    eligibleKeys.add(key);
    const existing = autoMergeState.candidates.get(key);
    autoMergeState.candidates.set(key, {
      repo: pr.repo,
      number: pr.number,
      numberLabel: pr.numberLabel,
      title: pr.title,
      url: pr.url,
      deadline: existing?.deadline || now + AUTO_MERGE_DELAY_MS,
      error: ""
    });
  }

  for (const key of [...autoMergeState.candidates.keys()]) {
    if (!eligibleKeys.has(key)) autoMergeState.candidates.delete(key);
  }
}

function syncAutoMergeFromStatus(pullRequests, options) {
  if (!autoMergeState.enabled) return;
  if (autoMergeState.options.mode !== options.mode || autoMergeState.options.jobs !== options.jobs) return;
  syncAutoMergeCandidates(pullRequests);
  if (!autoMergeState.running) {
    clearAutoMergeTimer();
    scheduleAutoMergeScan(nextAutoMergeDelay());
  }
}

function nextAutoMergeDelay() {
  const now = Date.now();
  const deadlines = [...autoMergeState.candidates.values()].map((candidate) => candidate.deadline);
  const nextDeadline = deadlines.length ? Math.max(1000, Math.min(...deadlines) - now) : AUTO_MERGE_SCAN_MS;
  return Math.min(nextDeadline, AUTO_MERGE_SCAN_MS);
}

async function executeMergePullRequest(repo, number, methodValue) {
  const pr = await fetchPullRequestByNumber(repo, number);
  const reason = mergeBlockReason(pr);
  if (reason) {
    throw new HttpError(409, reason);
  }

  const result = await githubRequest(`/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: {
      merge_method: mergeMethod(methodValue)
    }
  });
  const merged = Boolean(result?.merged);
  const branchDelete = merged
    ? await deletePullRequestBranch(pr)
    : { deleted: false, skipped: true, reason: "Pull request was not merged." };

  return {
    merged,
    message: result?.message || "Pull request merged.",
    branchDelete,
    pr: {
      repo: pr.repo,
      number: pr.number,
      numberLabel: pr.numberLabel,
      title: pr.title,
      url: pr.url
    }
  };
}

async function runAutoMergeScan() {
  clearAutoMergeTimer();
  if (!autoMergeState.enabled || autoMergeState.running) return;

  autoMergeState.running = true;
  autoMergeState.lastError = "";
  try {
    const metrics = createScanMetrics();
    await scanMetrics.run(metrics, async () => {
      const me = await getAccount();
      const pullRequests = await fetchPullRequests({
        mode: autoMergeState.options.mode,
        me,
        jobs: autoMergeState.options.jobs
      });
      syncAutoMergeCandidates(pullRequests);
    });
    autoMergeState.lastScanAt = new Date().toISOString();

    const now = Date.now();
    const due = [...autoMergeState.candidates.values()].filter((candidate) => candidate.deadline <= now);
    for (const candidate of due) {
      const key = autoMergeKey(candidate.repo, candidate.number);
      autoMergeState.candidates.delete(key);
      try {
        await executeMergePullRequest(candidate.repo, candidate.number);
      } catch (error) {
        if (!error.status || error.status >= 500) {
          autoMergeState.candidates.set(key, {
            ...candidate,
            deadline: Date.now() + AUTO_MERGE_SCAN_MS,
            error: error.message || "Auto merge failed"
          });
        } else {
          autoMergeState.lastError = error.message || "Auto merge failed";
        }
      }
    }
  } catch (error) {
    autoMergeState.lastError = error.message || "Auto merge scan failed";
  } finally {
    autoMergeState.running = false;
    if (autoMergeState.enabled) scheduleAutoMergeScan(nextAutoMergeDelay());
  }
}

async function autoMergeConfig(req, res) {
  if (req.method === "GET") {
    await sendJson(res, 200, autoMergeSnapshot());
    return;
  }
  if (req.method !== "POST" && req.method !== "PUT") {
    throw new HttpError(405, "Method not allowed");
  }

  const body = await readJsonBody(req);
  const nextOptions = {
    mode: normalizeMode(body.mode),
    jobs: parseJobs(body.jobs)
  };
  const optionsChanged = autoMergeState.options.mode !== nextOptions.mode || autoMergeState.options.jobs !== nextOptions.jobs;
  autoMergeState.enabled = Boolean(body.enabled);
  autoMergeState.options = nextOptions;
  autoMergeState.lastError = "";

  if (autoMergeState.enabled) {
    clearAutoMergeTimer();
    if (optionsChanged) autoMergeState.candidates.clear();
    scheduleAutoMergeScan(0);
  } else {
    clearAutoMergeTimer();
    autoMergeState.candidates.clear();
  }

  await sendJson(res, 200, autoMergeSnapshot());
}

function groupPullRequests(pullRequests) {
  return {
    pass: pullRequests.filter((pr) => pr.state === "pass" && pr.checkCount > 0 && !pr.hasConflict).sort(sortByRepoAndNumber),
    noCi: pullRequests
      .filter((pr) => pr.state === "pass" && pr.checkCount === 0 && !pr.isDraft && !pr.hasConflict)
      .sort(sortByRepoAndNumber),
    fail: pullRequests.filter((pr) => pr.state === "fail" && !pr.hasConflict).sort(sortByRepoAndNumber),
    running: pullRequests.filter((pr) => pr.state === "running" && !pr.hasConflict).sort(sortByRepoAndNumber),
    conflicts: pullRequests.filter((pr) => pr.hasConflict).sort(sortByRepoAndNumber)
  };
}

function mergeBlockReason(pr) {
  if (!pr || pr.state !== "pass") return "This pull request is not ready to merge.";
  if (pr.isDraft) return "Draft pull requests cannot be merged.";
  if (pr.hasConflict) return "This pull request has merge conflicts.";
  if (pr.checkCount === 0 && pr.mergeable !== "MERGEABLE") {
    return "This pull request is not currently mergeable.";
  }
  return "";
}

function isAutoMergeCandidate(pr) {
  return !mergeBlockReason(pr) && pr.checkCount > 0;
}

function sortByRepoAndNumber(a, b) {
  return a.repo.localeCompare(b.repo) || a.number - b.number;
}

function sortByCreatedDesc(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

async function sendJson(res, status, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new HttpError(413, "Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function mergeMethod(value) {
  if (value == null || value === "") return undefined;
  if (["merge", "squash", "rebase"].includes(value)) return value;
  throw new HttpError(400, "mergeMethod must be merge, squash, or rebase.");
}

function encodeRefPath(ref) {
  return String(ref)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function deletePullRequestBranch(pr) {
  if (!pr.headRepo || !pr.headRefName) {
    return {
      deleted: false,
      skipped: true,
      reason: "Pull request head branch was not available."
    };
  }

  try {
    await githubRequest(`/repos/${pr.headRepo}/git/refs/heads/${encodeRefPath(pr.headRefName)}`, {
      method: "DELETE"
    });
    return {
      deleted: true,
      repo: pr.headRepo,
      branch: pr.headRefName
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        deleted: true,
        alreadyDeleted: true,
        repo: pr.headRepo,
        branch: pr.headRefName
      };
    }
    return {
      deleted: false,
      repo: pr.headRepo,
      branch: pr.headRefName,
      error: error.message
    };
  }
}

async function mergePullRequest(req, res) {
  if (req.method !== "POST") {
    throw new HttpError(405, "Method not allowed");
  }

  const body = await readJsonBody(req);
  const { repo } = parseRepo(body.repo);
  const number = parsePullNumber(body.number);
  autoMergeState.candidates.delete(autoMergeKey(repo, number));
  await sendJson(res, 200, await executeMergePullRequest(repo, number, body.mergeMethod));
}

async function closePullRequest(req, res) {
  if (req.method !== "POST") {
    throw new HttpError(405, "Method not allowed");
  }

  const body = await readJsonBody(req);
  const { repo } = parseRepo(body.repo);
  const number = parsePullNumber(body.number);
  autoMergeState.candidates.delete(autoMergeKey(repo, number));
  const pr = await fetchPullRequestByNumber(repo, number);

  const result = await githubRequest(`/repos/${repo}/pulls/${number}`, {
    method: "PATCH",
    body: {
      state: "closed"
    }
  });

  await sendJson(res, 200, {
    closed: result?.state === "closed",
    message: result?.state === "closed" ? "Pull request closed." : "GitHub did not close the pull request.",
    pr: {
      repo: pr.repo,
      number: pr.number,
      numberLabel: pr.numberLabel,
      title: pr.title,
      url: pr.url
    }
  });
}

async function sendStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) throw new HttpError(403, "Forbidden");
  const data = await readFile(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": types[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (requestUrl.pathname === "/api/status") {
      const metrics = createScanMetrics();
      try {
        await scanMetrics.run(metrics, async () => {
          const data = await buildDashboardData(requestUrl);
          await sendJson(res, 200, data);
        });
      } catch (error) {
        const status = error.status || 500;
        await sendJson(res, status, {
          error: error.message || "Unexpected error",
          rateLimit: snapshotRateLimit(metrics)
        });
      }
      return;
    }
    if (requestUrl.pathname === "/api/runners/status") {
      if (req.method !== "GET") {
        throw new HttpError(405, "Method not allowed");
      }
      const metrics = createScanMetrics();
      try {
        await scanMetrics.run(metrics, async () => {
          const data = await buildBusyRunnerData(requestUrl);
          await sendJson(res, 200, data);
        });
      } catch (error) {
        const status = error.status || 500;
        await sendJson(res, status, {
          error: error.message || "Unexpected error",
          rateLimit: snapshotRateLimit(metrics)
        });
      }
      return;
    }
    if (requestUrl.pathname === "/api/pull-request/merge") {
      await mergePullRequest(req, res);
      return;
    }
    if (requestUrl.pathname === "/api/auto-merge") {
      await autoMergeConfig(req, res);
      return;
    }
    if (requestUrl.pathname === "/api/pull-request/close") {
      await closePullRequest(req, res);
      return;
    }
    if (requestUrl.pathname === "/api/health") {
      await sendJson(res, 200, { ok: true });
      return;
    }
    await sendStatic(req, res);
  } catch (error) {
    if (error.code === "ENOENT") {
      await sendJson(res, 404, { error: "Not found" });
      return;
    }
    const status = error.status || 500;
    await sendJson(res, status, { error: error.message || "Unexpected error" });
  }
});

if (isMain) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`GitHub Monitor dashboard: http://127.0.0.1:${port}`);
    console.log(`Auth mode: ${APP_AUTH_ENABLED ? `GitHub App (id ${GITHUB_APP_ID})` : "Personal access token"}`);
  });
}

export {
  SECURITY_HEADERS,
  bestProductionUrlCandidate,
  buildChangeSummary,
  classifyPullRequest,
  extractProductionUrlsFromText,
  groupPullRequests,
  isProductionTargetScanPath,
  publicRouteFromFile,
  isBackendUrl,
  isAutoMergeCandidate,
  mergeBlockReason,
  openPullRequestSearchQuery,
  quotaState,
  recordRateLimit,
  snapshotRateLimit,
  resetObservedRateBuckets,
  createScanMetrics,
  scanMetrics,
  recommendRefresh,
  runOutcome,
  selectFailedCdRuns,
  findSupersedingSuccessfulRun,
  applyConditionalHeaders,
  takeCachedConditionalResponse,
  storeConditionalResponse,
  extractOwnerFromPath,
  buildAppJwtPayload,
  signAppJwt,
  installationTokenIsValid,
  server
};
