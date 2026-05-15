import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 4177);
const githubApiBase = "https://api.github.com";
const githubGraphqlUrl = "https://api.github.com/graphql";
let githubTokenPromise;
const scanMetrics = new AsyncLocalStorage();

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
const RUNNING_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const FAILED_RUN_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
const FAILED_JOB_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
const FAILED_CHECK_CONCLUSIONS = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const RUNNING_DEPLOYMENT_STATES = new Set(["queued", "pending", "in_progress"]);
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

async function getGitHubToken() {
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

function githubUrl(path, query = {}) {
  const url = path.startsWith("http") ? new URL(path) : new URL(path, githubApiBase);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function githubRequest(path, { method = "GET", query = {}, body } = {}) {
  const token = await getGitHubToken();
  const response = await fetch(githubUrl(path, query), {
    method,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "github-monitor-local",
      "x-github-api-version": "2022-11-28"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  recordRateLimit(response);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = json?.message || text || `GitHub API returned ${response.status}`;
    throw new HttpError(response.status, message);
  }
  return json;
}

function createScanMetrics() {
  return {
    startedAt: new Date().toISOString(),
    requestCount: 0,
    rateLimits: {}
  };
}

function recordRateLimit(response) {
  const metrics = scanMetrics.getStore();
  if (!metrics) return;
  metrics.requestCount += 1;

  const limit = Number(response.headers.get("x-ratelimit-limit"));
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const used = Number(response.headers.get("x-ratelimit-used"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const resource = response.headers.get("x-ratelimit-resource") || "core";
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) return;

  const previous = metrics.rateLimits[resource];
  metrics.rateLimits[resource] = {
    resource,
    limit,
    remaining,
    used: Number.isFinite(used) ? used : null,
    resetAt: new Date(reset * 1000).toISOString()
  };

  if (previous && previous.remaining < remaining) {
    metrics.rateLimits[resource].remaining = previous.remaining;
  }
}

function snapshotRateLimit(metrics) {
  const resources = Object.values(metrics.rateLimits).sort((a, b) => a.resource.localeCompare(b.resource));
  const tightest = resources.reduce((lowest, item) => {
    if (!lowest) return item;
    return item.remaining / item.limit < lowest.remaining / lowest.limit ? item : lowest;
  }, null);
  return {
    requestCount: metrics.requestCount,
    resources,
    tightest
  };
}

function recommendRefresh(summary, options, rateLimit) {
  const activeCount = summary.runningPrs + summary.runningCd + summary.runningDeployments + summary.busyRunners;
  const problemCount = summary.failingPrs + summary.failedCd;
  let intervalSeconds = activeCount > 0 ? 60 : problemCount > 0 ? 180 : 300;

  if (options.mode === "all") intervalSeconds += 60;
  if (options.includeCd) intervalSeconds += 60;
  if (options.includeRepoRunners) intervalSeconds += 120;

  const tightest = rateLimit.tightest;
  if (tightest) {
    const remainingRatio = tightest.remaining / Math.max(1, tightest.limit);
    if (tightest.remaining < 50 || remainingRatio < 0.05) {
      intervalSeconds = Math.max(intervalSeconds, secondsUntil(tightest.resetAt) + 30);
    } else if (tightest.remaining < 200 || remainingRatio < 0.15) {
      intervalSeconds = Math.max(intervalSeconds, 900);
    } else if (tightest.remaining < 500 || remainingRatio < 0.3) {
      intervalSeconds = Math.max(intervalSeconds, 420);
    }
  }

  intervalSeconds = Math.max(45, Math.min(intervalSeconds, 3900));
  return {
    intervalSeconds,
    nextRefreshAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
    reason: refreshReason(activeCount, problemCount, tightest)
  };
}

function secondsUntil(isoDate) {
  const delta = Math.ceil((new Date(isoDate).getTime() - Date.now()) / 1000);
  return Number.isFinite(delta) ? Math.max(0, delta) : 0;
}

function refreshReason(activeCount, problemCount, tightest) {
  if (tightest && (tightest.remaining < 200 || tightest.remaining / Math.max(1, tightest.limit) < 0.15)) {
    return `Slowed for ${tightest.resource} API quota`;
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

async function githubRestPage(path, page, perPage = 100, query = {}) {
  return githubRequest(path, { query: { ...query, per_page: perPage, page } });
}

async function githubRestAll(path, pickItems, perPage = 100, query = {}) {
  const results = [];
  for (let page = 1; page <= 50; page += 1) {
    const json = await githubRestPage(path, page, perPage, query);
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

function isWithinFailedCdWindow(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time <= FAILED_CD_MAX_AGE_MS;
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
  if (!checks.length && !hasConflict) return null;
  const base = {
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    numberLabel: `#${pr.number}`,
    title: pr.title,
    author: pr.author?.login || "unknown",
    url: pr.url,
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
  const user = await githubRequest("/user");
  return user.login;
}

async function allOwners(me) {
  const orgs = await githubRestAll("/user/orgs", (json) => (Array.isArray(json) ? json : []));
  return [me, ...orgs.map((org) => org.login).filter(Boolean)];
}

async function fetchPullRequests({ mode, me, jobs }) {
  if (mode === "mine") return fetchPrQuery(`is:pr state:open author:${me}`);
  if (mode === "owned") return fetchPrQuery(`is:pr state:open owner:${me}`);
  const owners = await allOwners(me);
  const groups = await mapLimit(owners, jobs, async (owner) => {
    try {
      return await fetchPrQuery(`is:pr state:open owner:${owner}`);
    } catch {
      return [];
    }
  });
  return uniqueBy(groups.flat(), (pr) => pr.url);
}

async function fetchOwnerRepos(owner, me) {
  if (owner === me) {
    const repos = await githubRestAll("/user/repos", (json) => (Array.isArray(json) ? json : []), 100, {
      affiliation: "owner"
    });
    return repos.filter((repo) => !repo.archived && repo.owner?.login === me).map((repo) => repo.full_name);
  }
  const repos = await githubRestAll(`/orgs/${owner}/repos`, (json) => (Array.isArray(json) ? json : []));
  return repos.filter((repo) => !repo.archived).map((repo) => repo.full_name);
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

async function fetchCdWorkflows(repo) {
  const workflows = await githubRestAll(`/repos/${repo}/actions/workflows`, (json) => json?.workflows || []);
  return workflows.filter((workflow) => workflow.state === "active" && isCdWorkflow(workflow));
}

async function fetchWorkflowRuns(repo, workflowId, params) {
  const path = `/repos/${repo}/actions/workflows/${workflowId}/runs`;
  const json = await githubRequest(path, { query: params });
  return json?.workflow_runs || [];
}

async function fetchCdForRepo(repo) {
  const failed = [];
  const finished = [];
  const running = [];
  const failureReasons = new Map();
  let workflows = [];
  try {
    workflows = await fetchCdWorkflows(repo);
  } catch {
    return { failed, finished, running };
  }
  for (const workflow of workflows) {
    try {
      const completedRuns = await fetchWorkflowRuns(repo, workflow.id, { per_page: 20, status: "completed" });
      const latest = completedRuns[0];
      const failedAt = latest?.updated_at || latest?.created_at;
      if (latest && FAILED_RUN_CONCLUSIONS.has(latest.conclusion) && isWithinFailedCdWindow(failedAt)) {
        const failureReason = await fetchWorkflowRunFailureReason(repo, latest);
        failureReasons.set(latest.id, failureReason);
        failed.push({
          createdAt: failedAt,
          repo,
          workflow: workflow.name,
          runNumber: `#${latest.run_number}`,
          conclusion: latest.conclusion || "",
          failureReason,
          branch: latest.head_branch || "",
          title: latest.display_title || "",
          url: latest.html_url || ""
        });
      }
      for (const run of completedRuns) {
        const finishedAt = run.updated_at || run.created_at;
        if (!isWithinFinishedCdWindow(finishedAt)) continue;
        const failureReason = FAILED_RUN_CONCLUSIONS.has(run.conclusion)
          ? failureReasons.get(run.id) || await fetchWorkflowRunFailureReason(repo, run)
          : "";
        if (failureReason) failureReasons.set(run.id, failureReason);
        finished.push({
          createdAt: finishedAt,
          repo,
          workflow: workflow.name,
          runNumber: `#${run.run_number}`,
          conclusion: run.conclusion || "",
          failureReason,
          branch: run.head_branch || "",
          title: run.display_title || "",
          url: run.html_url || ""
        });
      }

      const recentRuns = await fetchWorkflowRuns(repo, workflow.id, { per_page: 20 });
      for (const run of recentRuns.filter((item) => RUNNING_RUN_STATUSES.has(item.status))) {
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

async function fetchRunningDeploymentsForRepo(repo) {
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
  let runningDeployments = [];
  let busyRunners = [];

  if (includeCd || includeRepoRunners) {
    repos = await listRepos({ mode, me, pullRequests, jobs });
  }

  if (includeCd && repos.length) {
    const cdGroups = await mapLimit(repos, jobs, fetchCdForRepo);
    failedCd = uniqueBy(cdGroups.flatMap((group) => group.failed), (run) => run.url || JSON.stringify(run));
    finishedCd = uniqueBy(cdGroups.flatMap((group) => group.finished), (run) => run.url || JSON.stringify(run));
    runningCd = uniqueBy(cdGroups.flatMap((group) => group.running), (run) => run.url || JSON.stringify(run));
    const deploymentGroups = await mapLimit(repos, jobs, fetchRunningDeploymentsForRepo);
    runningDeployments = uniqueBy(deploymentGroups.flat(), (deployment) => deployment.url || JSON.stringify(deployment));
  }

  if (includeRunners) {
    busyRunners = await fetchBusyRunners({ includeRepoRunners, repos, pullRequests, mode, me, jobs });
  }

  const prGroups = groupPullRequests(pullRequests);
  const summary = {
    repos: repos.length || new Set(pullRequests.map((pr) => pr.repo)).size,
    passingPrs: prGroups.pass.length,
    failingPrs: prGroups.fail.length,
    runningPrs: prGroups.running.length,
    conflictPrs: prGroups.conflicts.length,
    runningCd: runningCd.length,
    finishedCd: finishedCd.length,
    runningDeployments: runningDeployments.length,
    busyRunners: busyRunners.length,
    failedCd: failedCd.length
  };
  const rateLimit = snapshotRateLimit(scanMetrics.getStore() || createScanMetrics());

  return {
    account: me,
    generatedAt: new Date().toISOString(),
    options: { mode, jobs, includeCd, includeRunners, includeRepoRunners },
    summary,
    rateLimit,
    refresh: recommendRefresh(summary, { mode, jobs, includeCd, includeRunners, includeRepoRunners }, rateLimit),
    pullRequests: prGroups,
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
    }
  };
}

function groupPullRequests(pullRequests) {
  return {
    pass: pullRequests.filter((pr) => pr.state === "pass" && !pr.hasConflict).sort(sortByRepoAndNumber),
    fail: pullRequests.filter((pr) => pr.state === "fail" && !pr.hasConflict).sort(sortByRepoAndNumber),
    running: pullRequests.filter((pr) => pr.state === "running" && !pr.hasConflict).sort(sortByRepoAndNumber),
    conflicts: pullRequests.filter((pr) => pr.hasConflict).sort(sortByRepoAndNumber)
  };
}

function sortByRepoAndNumber(a, b) {
  return a.repo.localeCompare(b.repo) || a.number - b.number;
}

function sortByCreatedDesc(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

async function sendJson(res, status, body) {
  res.writeHead(status, {
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
  const pr = await fetchPullRequestByNumber(repo, number);
  if (!pr || pr.state !== "pass" || pr.checkCount < 1) {
    throw new HttpError(409, "This pull request does not have completed passing CI checks.");
  }
  if (pr.isDraft) {
    throw new HttpError(409, "Draft pull requests cannot be merged.");
  }
  if (pr.hasConflict) {
    throw new HttpError(409, "This pull request has merge conflicts.");
  }

  const result = await githubRequest(`/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: {
      merge_method: mergeMethod(body.mergeMethod)
    }
  });
  const merged = Boolean(result?.merged);
  const branchDelete = merged
    ? await deletePullRequestBranch(pr)
    : { deleted: false, skipped: true, reason: "Pull request was not merged." };

  await sendJson(res, 200, {
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
    if (requestUrl.pathname === "/api/pull-request/merge") {
      await mergePullRequest(req, res);
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
  });
}

export { groupPullRequests };
