// providers/azure.js — the Azure DevOps provider adapter for watch-pr.
//
// Owns everything host-specific: the `az` CLI, and decoding Azure's votes / build
// policy / comment threads into the neutral provider contract that the core
// (check.js) consumes. The core never learns it is talking to Azure — it only sees
// the decoded shape below. Read-only against Azure: the only writes in the whole
// system are to the local state file, and those live in core.
//
// Provider interface (the neutral seam — see the handover's data contract):
//   me                 identity string; your own comments never count as a blocker
//   prUrl(repo, id)    web URL for a PR
//   decodePr(id, repo) the neutral decoded shape (prStatus, ci, approvals, threads, …)
// listMyOpenPrs() is optional and not implemented for Azure.

const { exec } = require("child_process");
const config = require("../config.js");

const AZ = config.azCliPath;
const ME = config.me; // your own comments are not "a reviewer waiting on you"

// Azure DevOps web URL for a PR. Repo-aware, so the watcher works across repositories
// (the per-PR `repository` field), not just the configured default.
function prUrl(repo, id) {
  return `${config.organization}/${config.project}/_git/${repo || config.defaultRepository}/pullrequest/${id}`;
}

function az(argsStr) {
  return new Promise((resolve, reject) => {
    exec(`"${AZ}" ${argsStr}`, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").trim() || err.message));
      try { resolve(JSON.parse(stdout || "null")); }
      catch (e) { reject(new Error("bad JSON from az: " + e.message)); }
    });
  });
}

// The `az` calls below run through a shell (az is a .cmd), so id and repository are
// interpolated into a command line. Validate them against a strict whitelist first — this
// is the trust boundary that stops shell-metacharacter injection from an untrusted repo/id
// (e.g. a CSRF POST to /watch?repo=...). project comes from local (trusted) config.
function assertSafeId(id) {
  if (!/^\d+$/.test(String(id))) throw new Error("PR id must be numeric");
}
function assertSafeRepo(repo) {
  if (!/^[A-Za-z0-9._/ -]+$/.test(String(repo))) throw new Error("invalid repository name");
}

// Fresh read of one PR from Azure. Returns decoded primitives + the human comment threads.
async function decodePr(id, repo) {
  const repository = repo || config.defaultRepository;
  assertSafeId(id);
  assertSafeRepo(repository);
  const [show, policies, threads] = await Promise.all([
    az(`repos pr show --id ${id} --query "{status:status, mergeStatus:mergeStatus, isDraft:isDraft, createdAt:creationDate, title:title, sourceRef:sourceRefName, targetRef:targetRefName, reviewers:reviewers[].{name:displayName, vote:vote, isContainer:isContainer}}" -o json`),
    az(`repos pr policy list --id ${id} --query "[].{name:configuration.type.displayName, status:status}" -o json`),
    az(`devops invoke --area git --resource pullRequestThreads --route-parameters project=${config.project} repositoryId=${repository} pullRequestId=${id} --query "value[].{id:id, status:status, comments:comments[].{author:author.displayName, type:commentType, content:content, updated:lastUpdatedDate}}" -o json`),
  ]);

  const reviewers = (show && show.reviewers) || [];
  // Exclude your own vote — your self-approval shouldn't count toward the bar, and this
  // matches the GitHub adapter (which excludes login === me). Container = team/group reviewer.
  const others = reviewers.filter((r) => !r.isContainer && (!ME || r.name !== ME));
  const approvers = others.filter((r) => r.vote === 10 || r.vote === 5);
  // vote -5 (waiting for author) / -10 (rejected) = a reviewer is blocking / waiting on you
  const blockers = others.filter((r) => r.vote === -5 || r.vote === -10);

  const buildPolicy = (policies || []).find((p) => p.name === "Build");
  const buildRaw = buildPolicy ? buildPolicy.status : ""; // queued|running|approved|rejected|notApplicable|""
  const ci = ({ approved: "passed", rejected: "failed", queued: "queued", running: "running" })[buildRaw] || "none";

  // human discussion threads only (drop system/auto threads)
  const humanThreads = (threads || []).filter((t) => (t.comments || []).some((c) => c.type === "text"));
  const threadInfo = humanThreads.map((t) => {
    const textComments = (t.comments || []).filter((c) => c.type === "text");
    const last = textComments[textComments.length - 1] || {};
    const maxUpdated = (t.comments || []).reduce((m, c) => (c.updated && c.updated > m ? c.updated : m), "");
    return {
      id: String(t.id),
      unresolved: t.status === "active",
      author: last.author || "",
      gist: (last.content || "").replace(/\s+/g, " ").slice(0, 140),
      updated: maxUpdated,
    };
  });

  const openComments = threadInfo.filter((t) => t.unresolved).length;
  const prStatus = (show && show.status) || "active";
  const mergeStatus = (show && show.mergeStatus) || "";
  const isDraft = !!(show && show.isDraft);
  const createdAt = (show && show.createdAt) || "";
  const title = (show && show.title) || "";
  const branch = ((show && show.sourceRef) || "").replace(/^refs\/heads\//, "");
  const target = ((show && show.targetRef) || "").replace(/^refs\/heads\//, "");
  const approvals = approvers.length;
  const changesRequested = blockers.length > 0;
  const ci_passed = ci === "passed";
  // a draft or an outstanding "changes requested" is never "ready to merge"
  const ready = !isDraft && !changesRequested && approvals >= 1 && ci_passed && openComments === 0;

  return {
    prStatus, mergeStatus, mergeable: mergeStatus === "succeeded",
    isDraft, createdAt, title, branch, target,
    buildRaw, ci,
    approvals, approvalNames: approvers.map((r) => r.name),
    changesRequested, blockerNames: blockers.map((r) => r.name),
    openComments, threads: threadInfo, ready,
  };
}

module.exports = { me: ME, prUrl, decodePr };
