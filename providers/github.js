// providers/github.js — the GitHub provider adapter for watch-pr.
//
// Owns everything host-specific: the `gh` CLI, and mapping GitHub's PR state /
// review decision / status-check rollup / review threads into the neutral provider
// contract that the core (check.js) consumes. The core never learns it is talking to
// GitHub — it only sees the decoded shape below. Read-only against GitHub: the only
// writes in the whole system are to the local state file, and those live in core.
//
// Auth is owned by the CLI: run `gh auth login` once. No tokens in config.
// Repos are "owner/repo". Identity ("me") is the gh login, resolved once at load
// (config.me overrides, to avoid the subprocess).
//
// Provider interface (the neutral seam — see the handover's data contract):
//   me                 identity string; your own comments never count as a blocker
//   prUrl(repo, id)    web URL for a PR
//   decodePr(id, repo) the neutral decoded shape (prStatus, ci, approvals, threads, …)
//   listMyOpenPrs()    optional: [{ id, repo }] for "watch all my open PRs"

const { execFile, execFileSync } = require("child_process");
const config = require("../config.js");

// gh must be found without a shell (so the GraphQL query needs no quoting). On Windows
// execFile needs the .exe; elsewhere plain "gh". config.ghCliPath overrides both.
const GH = config.ghCliPath || (process.platform === "win32" ? "gh.exe" : "gh");

// Resolve identity once. Prefer config.me; else ask gh. Never throw at load time.
let ME = config.me || "";
if (!ME) {
  try { ME = execFileSync(GH, ["api", "user", "-q", ".login"], { windowsHide: true }).toString().trim(); }
  catch (e) { ME = ""; }
}

function prUrl(repo, id) {
  return `https://github.com/${repo || config.defaultRepository}/pull/${id}`;
}

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      try { resolve(JSON.parse(stdout || "null")); }
      catch (e) { reject(new Error("bad JSON from gh: " + e.message)); }
    });
  });
}

// GitHub PR state -> neutral prStatus.
function mapPrStatus(state) {
  const s = (state || "").toUpperCase();
  if (s === "MERGED") return "completed";
  if (s === "CLOSED") return "abandoned";
  return "active"; // OPEN
}

// statusCheckRollup[] -> normalized ci. Entries are CheckRun (status + conclusion) or
// StatusContext (state). Any failing conclusion/state -> failed; else anything still
// pending -> running; else all good -> passed; empty -> none. Also returns a compact
// host-native rollup token for change detection (buildRaw).
const FAIL = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE", "ERROR"]);
const PENDING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);
function deriveCi(rollup) {
  const checks = rollup || [];
  if (!checks.length) return { ci: "none", buildRaw: "" };
  const concl = checks.map((c) => (c.conclusion || "").toUpperCase());
  const states = checks.map((c) => (c.status || c.state || "").toUpperCase());
  if (concl.some((c) => FAIL.has(c)) || states.some((s) => FAIL.has(s))) return { ci: "failed", buildRaw: "FAILURE" };
  if (states.some((s) => PENDING.has(s))) return { ci: "running", buildRaw: "PENDING" };
  return { ci: "passed", buildRaw: "SUCCESS" };
}

// Unresolved review threads are NOT in `gh pr view --json`; fetch them via GraphQL.
// Returns { openComments, threads[] } in the neutral shape (threads carry the last
// comment's author/updatedAt/gist for new-comment detection).
async function fetchThreads(owner, name, id) {
  const q =
    "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){" +
    "reviewThreads(first:100){nodes{id isResolved comments(last:1){nodes{author{login} updatedAt body}}}}}}}";
  let data;
  try {
    data = await gh(["api", "graphql", "-f", "query=" + q, "-F", "o=" + owner, "-F", "r=" + name, "-F", "n=" + id]);
  } catch (e) {
    return { openComments: 0, threads: [] }; // never let thread lookup sink a decode
  }
  const nodes =
    (data && data.data && data.data.repository && data.data.repository.pullRequest &&
      data.data.repository.pullRequest.reviewThreads && data.data.repository.pullRequest.reviewThreads.nodes) || [];
  const threads = nodes.map((t, i) => {
    const last = ((t.comments && t.comments.nodes) || [])[0] || {};
    return {
      id: String(t.id || i),
      unresolved: t.isResolved === false,
      author: (last.author && last.author.login) || "",
      gist: (last.body || "").replace(/\s+/g, " ").slice(0, 140),
      updated: last.updatedAt || "",
    };
  });
  return { openComments: threads.filter((t) => t.unresolved).length, threads };
}

// Fresh read of one PR from GitHub. Returns the neutral decoded shape.
async function decodePr(id, repo) {
  const repository = repo || config.defaultRepository;
  const [owner, name] = String(repository).split("/");
  const required = config.approvalsRequired || 1;

  const view = await gh([
    "pr", "view", String(id), "-R", repository, "--json",
    "number,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup," +
    "headRefName,baseRefName,createdAt,url,latestReviews",
  ]);

  const prStatus = mapPrStatus(view && view.state);
  const isDraft = !!(view && view.isDraft);
  const mergeableRaw = (view && view.mergeable) || "UNKNOWN"; // MERGEABLE | CONFLICTING | UNKNOWN
  const { ci, buildRaw } = deriveCi(view && view.statusCheckRollup);

  // latestReviews: one entry per reviewer, their latest state. Exclude your own.
  const reviews = ((view && view.latestReviews) || []).filter((r) => {
    const login = (r.author && r.author.login) || "";
    return login && login !== ME;
  });
  const approvers = reviews.filter((r) => (r.state || "").toUpperCase() === "APPROVED");
  const blockers = reviews.filter((r) => (r.state || "").toUpperCase() === "CHANGES_REQUESTED");
  const approvals = approvers.length;

  const reviewDecision = (view && view.reviewDecision) || "";
  const changesRequested = reviewDecision === "CHANGES_REQUESTED" || blockers.length > 0;

  const { openComments, threads } = await fetchThreads(owner, name, id);

  const approved = reviewDecision === "APPROVED" || approvals >= required;
  const ready = !isDraft && !changesRequested && approved && ci === "passed" && openComments === 0;

  return {
    prStatus,
    mergeStatus: mergeableRaw, // host-native token, used by core only for change detection
    mergeable: mergeableRaw !== "CONFLICTING", // UNKNOWN is treated as clean (still computing)
    isDraft,
    createdAt: (view && view.createdAt) || "",
    title: (view && view.title) || "",
    branch: (view && view.headRefName) || "",
    target: (view && view.baseRefName) || "",
    buildRaw,
    ci,
    approvals,
    approvalNames: approvers.map((r) => (r.author && r.author.login) || ""),
    changesRequested,
    blockerNames: blockers.map((r) => (r.author && r.author.login) || ""),
    openComments,
    threads,
    ready,
  };
}

// Optional: every open PR I authored, as [{ id, repo }] — powers a "watch all my PRs"
// mode with zero manual registration.
async function listMyOpenPrs() {
  const rows = await gh(["search", "prs", "--author", "@me", "--state", "open", "--json", "number,repository"]);
  return (rows || []).map((r) => ({
    id: r.number,
    repo: (r.repository && (r.repository.nameWithOwner || r.repository.name)) || "",
  })).filter((r) => r.repo);
}

module.exports = { me: ME, prUrl, decodePr, listMyOpenPrs };
