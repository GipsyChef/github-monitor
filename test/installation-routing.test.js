import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// App auth is decided at module load. Set env BEFORE importing server.js.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const tmpDir = mkdtempSync(join(tmpdir(), "ghmon-routing-"));
const pemPath = join(tmpDir, "key.pem");
writeFileSync(pemPath, pem, { mode: 0o600 });
chmodSync(pemPath, 0o600);

process.env.GITHUB_APP_ID = "999999";
process.env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const { server, parseOwners, sameAutoMergeOwners } = await import("../server.js");

function freshHeaders(resource = "core") {
  return {
    "content-type": "application/json",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4990",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    "x-ratelimit-resource": resource
  };
}

const INSTALLATIONS = [
  { id: 1001, login: "cigan1", type: "User" },
  { id: 1002, login: "siftfy", type: "Organization" },
  { id: 1003, login: "GipsyChef", type: "Organization" }
];

function installationTokenFor(id) {
  return `token-for-${id}`;
}

function ownerForToken(token) {
  for (const inst of INSTALLATIONS) {
    if (installationTokenFor(inst.id) === token) return inst.login;
  }
  return null;
}

function buildSearchHandler(graphqlRequestLog) {
  return (token, body) => {
    const owner = ownerForToken(token);
    graphqlRequestLog.push({ token, owner, q: body?.variables?.q || "" });
    const q = body?.variables?.q || "";
    // Only return PRs when the search "owner:" matches the authenticating installation's account.
    const match = /owner:(\S+)/.exec(q);
    const searchOwner = match ? match[1] : null;
    if (!owner || !searchOwner || searchOwner.toLowerCase() !== owner.toLowerCase()) {
      return {
        data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }
      };
    }
    return {
      data: {
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              __typename: "PullRequest",
              id: `pr-${searchOwner}-1`,
              number: 1,
              title: `${searchOwner} test PR`,
              url: `https://github.com/${searchOwner}/repo/pull/1`,
              isDraft: false,
              author: { login: "tester" },
              repository: {
                nameWithOwner: `${searchOwner}/repo`,
                isArchived: false
              },
              mergeable: "MERGEABLE",
              headRefName: "feature",
              headRepository: { nameWithOwner: `${searchOwner}/repo` },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] }
              },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "Test",
                              status: "COMPLETED",
                              conclusion: "SUCCESS"
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    };
  };
}

async function runWithStubbedFetch({ graphqlRequestLog }, fn) {
  const previousFetch = globalThis.fetch;
  const search = buildSearchHandler(graphqlRequestLog);
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const path = requestUrl.pathname;
    const authHeader = options.headers?.authorization || options.headers?.Authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const body = options.body ? JSON.parse(options.body) : {};

    if (path === "/app/installations") {
      return Response.json(
        INSTALLATIONS.map((inst) => ({
          id: inst.id,
          account: { login: inst.login, type: inst.type },
          repository_selection: "all"
        })),
        { headers: freshHeaders() }
      );
    }
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (tokenMatch) {
      const id = Number(tokenMatch[1]);
      return Response.json(
        {
          token: installationTokenFor(id),
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        },
        { headers: freshHeaders() }
      );
    }
    if (path === "/graphql") {
      return Response.json(search(token, body), { headers: freshHeaders("graphql") });
    }
    if (/^\/installation\/repositories$/.test(path)) {
      const ownerForRequest = ownerForToken(token);
      return Response.json(
        {
          total_count: 1,
          repositories: ownerForRequest
            ? [
                {
                  full_name: `${ownerForRequest}/repo`,
                  archived: false,
                  owner: { login: ownerForRequest }
                }
              ]
            : []
        },
        { headers: freshHeaders() }
      );
    }
    if (/\/actions\/workflows$/.test(path) || /\/actions\/runs$/.test(path) || /\/deployments$/.test(path)) {
      return Response.json({ workflows: [], workflow_runs: [], total_count: 0 }, { headers: freshHeaders() });
    }
    return Response.json({ message: "not found", path }, { status: 404, headers: freshHeaders() });
  };
  try {
    return await fn(previousFetch);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("App auth: each owner's PR search uses that owner's installation token", async () => {
  const graphqlRequestLog = [];
  await runWithStubbedFetch({ graphqlRequestLog }, async (realFetch) => {
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, "127.0.0.1", () => resolve(l));
    });
    try {
      const { port } = listener.address();
      const response = await realFetch(
        `http://127.0.0.1:${port}/api/status?mode=all&jobs=1&includeCd=0&includeRunners=0`
      );
      const data = await response.json();

      assert.equal(response.status, 200);
      // All 3 owners' PRs should appear, one per owner, because each search ran under that owner's token.
      const passingRepos = (data.pullRequests.pass || []).map((pr) => pr.repo).sort();
      assert.deepEqual(
        passingRepos,
        ["GipsyChef/repo", "cigan1/repo", "siftfy/repo"],
        `expected one passing PR per owner; got: ${JSON.stringify(passingRepos)}`
      );

      // Per-owner routing: each GraphQL request's token must match the owner: qualifier.
      const ownerSearches = graphqlRequestLog.filter((entry) => /owner:/.test(entry.q));
      assert.ok(ownerSearches.length >= 3, `expected at least 3 owner: searches; got ${ownerSearches.length}`);
      for (const entry of ownerSearches) {
        const match = /owner:(\S+)/.exec(entry.q);
        assert.ok(match, `unexpected query without owner: qualifier: ${entry.q}`);
        const searchOwner = match[1].toLowerCase();
        assert.equal(
          entry.owner.toLowerCase(),
          searchOwner,
          `search for owner:${searchOwner} used token for ${entry.owner}`
        );
      }
    } finally {
      await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

test("App auth: owners filter drops cross-owner PRs that a token can incidentally see", async () => {
  // Some installation tokens can see public PRs in repos outside their account
  // (e.g. mode=mine returns author: PRs across public repos). The owners filter
  // must scope the dashboard strictly, regardless of what the token can fetch.
  const graphqlRequestLog = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    const path = requestUrl.pathname;
    const authHeader = options.headers?.authorization || options.headers?.Authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const body = options.body ? JSON.parse(options.body) : {};
    const owner = ownerForToken(token);
    const headers = {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4990",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-resource": path === "/graphql" ? "graphql" : "core"
    };
    if (path === "/app/installations") {
      return Response.json(
        INSTALLATIONS.map((inst) => ({ id: inst.id, account: { login: inst.login, type: inst.type }, repository_selection: "all" })),
        { headers }
      );
    }
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (tokenMatch) {
      return Response.json({ token: installationTokenFor(Number(tokenMatch[1])), expires_at: new Date(Date.now() + 3600_000).toISOString() }, { headers });
    }
    if (path === "/graphql") {
      graphqlRequestLog.push({ token, owner, q: body?.variables?.q || "" });
      // Simulate the real GitHub behavior: an author: search routed through any token
      // can return PRs from a public external repo (here: "external/public-repo").
      const nodes = [
        // Owner-installation-scoped PR
        owner && {
          __typename: "PullRequest",
          id: `pr-${owner}-1`,
          number: 1,
          title: `${owner} authored PR`,
          url: `https://github.com/${owner}/repo/pull/1`,
          isDraft: false,
          author: { login: "tester" },
          repository: { nameWithOwner: `${owner}/repo`, isArchived: false },
          mergeable: "MERGEABLE",
          headRefName: "feature",
          headRepository: { nameWithOwner: `${owner}/repo` },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          commits: { nodes: [] }
        },
        // Public-repo PR that EVERY installation can see incidentally
        {
          __typename: "PullRequest",
          id: "pr-public-shared",
          number: 99,
          title: "shared public PR",
          url: "https://github.com/external/public-repo/pull/99",
          isDraft: false,
          author: { login: "tester" },
          repository: { nameWithOwner: "external/public-repo", isArchived: false },
          mergeable: "MERGEABLE",
          headRefName: "feature",
          headRepository: { nameWithOwner: "external/public-repo" },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          commits: { nodes: [] }
        }
      ].filter(Boolean);
      return Response.json({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }, { headers });
    }
    if (path === "/installation/repositories") {
      return Response.json({ total_count: 1, repositories: owner ? [{ full_name: `${owner}/repo`, archived: false, owner: { login: owner } }] : [] }, { headers });
    }
    return Response.json({ message: "not found" }, { status: 404, headers });
  };
  try {
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, "127.0.0.1", () => resolve(l));
    });
    try {
      const { port } = listener.address();
      const response = await previousFetch(
        `http://127.0.0.1:${port}/api/status?mode=mine&jobs=1&includeCd=0&includeRunners=0&owners=GipsyChef`
      );
      const data = await response.json();
      assert.equal(response.status, 200);
      const repos = [
        ...(data.pullRequests.pass || []),
        ...(data.pullRequests.noCi || [])
      ].map((pr) => pr.repo);
      assert.deepEqual(
        repos.sort(),
        ["GipsyChef/repo"],
        `expected only GipsyChef-scoped PR; got: ${JSON.stringify(repos)}`
      );
    } finally {
      await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("App auth: owners filter restricts dashboard scope and uses matching installation token", async () => {
  const graphqlRequestLog = [];
  await runWithStubbedFetch({ graphqlRequestLog }, async (realFetch) => {
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, "127.0.0.1", () => resolve(l));
    });
    try {
      const { port } = listener.address();
      const response = await realFetch(
        `http://127.0.0.1:${port}/api/status?mode=all&jobs=1&includeCd=0&includeRunners=0&owners=GipsyChef`
      );
      const data = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(data.options.owners, ["GipsyChef"]);
      const passingRepos = (data.pullRequests.pass || []).map((pr) => pr.repo);
      assert.deepEqual(passingRepos, ["GipsyChef/repo"]);
      assert.deepEqual(
        data.accounts.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
        ["cigan1", "GipsyChef", "siftfy"]
      );

      // No graphql request should be sent under a non-GipsyChef installation token for owner: queries.
      const ownerSearches = graphqlRequestLog.filter((entry) => /owner:GipsyChef/.test(entry.q));
      assert.ok(ownerSearches.length >= 1, "expected at least one owner:GipsyChef search");
      for (const entry of ownerSearches) {
        assert.equal(entry.owner, "GipsyChef");
      }
    } finally {
      await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

test("parseOwners handles comma-strings, arrays, blanks, and dedup", () => {
  assert.deepEqual(parseOwners(null), []);
  assert.deepEqual(parseOwners(""), []);
  assert.deepEqual(parseOwners("GipsyChef"), ["GipsyChef"]);
  assert.deepEqual(parseOwners("GipsyChef,cigan1"), ["GipsyChef", "cigan1"]);
  assert.deepEqual(parseOwners("  GipsyChef , , cigan1  "), ["GipsyChef", "cigan1"]);
  assert.deepEqual(parseOwners("GipsyChef,gipsychef,Cigan1"), ["GipsyChef", "Cigan1"]);
  assert.deepEqual(parseOwners(["GipsyChef", "", "cigan1"]), ["GipsyChef", "cigan1"]);
});

test("sameAutoMergeOwners is order- and case-insensitive", () => {
  assert.equal(sameAutoMergeOwners([], []), true);
  assert.equal(sameAutoMergeOwners(undefined, []), true);
  assert.equal(sameAutoMergeOwners(["GipsyChef"], ["gipsychef"]), true);
  assert.equal(sameAutoMergeOwners(["a", "b"], ["b", "a"]), true);
  assert.equal(sameAutoMergeOwners(["a"], ["a", "b"]), false);
  assert.equal(sameAutoMergeOwners(["a", "b"], ["a", "c"]), false);
});
