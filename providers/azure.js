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
//   listMyOpenPrs()          optional: [{id,repo,createdAt}] of your open PRs (config.watchMine)
//   listReviewRequestedPrs() optional: [{id,repo,createdAt}] awaiting your review (config.watchReviewRequests)

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
// The identity is interpolated into the `az repos pr list` command below (unlike decodePr,
// where `me` is only used for in-JS comparison). It comes from trusted local config, but
// guard it anyway so a stray quote or shell metachar can't break out of the quoted argument.
// Blacklist (not whitelist) so international names / apostrophes / emails still pass.
function assertSafeIdentity(who) {
  if (/["`$\\;&|<>%^!\r\n]/.test(String(who))) throw new Error("config.me contains characters unsafe for a shell argument");
}

// Decode Azure's reviewer votes into the neutral approval / block shape. Pure and exported so
// the vote arithmetic is unit-tested without touching `az`. Azure votes: 10 = approved, 5 =
// approved with suggestions, 0 = no vote, -5 = waiting for author, -10 = rejected. A container
// reviewer is a team/group, not a person, and never counts. Crucially your OWN approval counts
// toward the bar — on a PR you reviewed, your vote is a real approval — which is why a colleague's
// PR you approved reads 2/2, not 1/2. Your own -5/-10 is dropped from the blockers, though: your
// own "waiting"/"rejected" is not "someone else is waiting on you".
function tallyVotes(reviewers, me) {
  const people = (reviewers || []).filter((r) => !r.isContainer);
  const approvers = people.filter((r) => r.vote === 10 || r.vote === 5);
  const blockers = people.filter((r) => (r.vote === -5 || r.vote === -10) && (!me || r.name !== me));
  return {
    approvals: approvers.length,
    approvalNames: approvers.map((r) => r.name),
    changesRequested: blockers.length > 0,
    blockerNames: blockers.map((r) => r.name),
  };
}

// True while a PR is still awaiting MY review — I'm a reviewer but my vote is still 0. Azure keeps
// you in a PR's reviewer set after you vote (unlike GitHub, which drops the review request the
// moment you review), so the raw `--reviewer` listing includes PRs you've already voted on. This
// is the filter that makes "awaiting my review" mean what it says, and lets the core clear the
// reviewer card the moment you vote. No reviewer entry at all defaults to true (never silently
// drop a review request). Pure and exported for unit tests.
function awaitingMyReview(row, me) {
  const mine = (row.reviewers || []).find((r) => r.name === me);
  return !mine || !mine.vote; // no entry, or vote 0 = not yet reviewed
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
  const { approvals, approvalNames, changesRequested, blockerNames } = tallyVotes(reviewers, ME);

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
  const ci_passed = ci === "passed";
  // a draft or an outstanding "changes requested" is never "ready to merge"
  const ready = !isDraft && !changesRequested && approvals >= 1 && ci_passed && openComments === 0;

  return {
    prStatus, mergeStatus, mergeable: mergeStatus === "succeeded",
    isDraft, createdAt, title, branch, target,
    buildRaw, ci,
    approvals, approvalNames,
    changesRequested, blockerNames,
    openComments, threads: threadInfo, ready,
  };
}

// Optional: every open PR I authored, as [{ id, repo, createdAt }] — powers "watch all my
// PRs" (config.watchMine) with zero manual registration. createdAt lets the core skip stale
// PRs before paying for a per-PR decode.
async function listMyOpenPrs() {
  return rowsToPrs(await listByIdentity("creator"));
}

// Optional: every open PR still awaiting MY review, as [{ id, repo, createdAt }] — powers "watch
// PRs awaiting my review" (config.watchReviewRequests). Unlike GitHub, Azure does NOT drop you
// from a PR's reviewer set when you vote — you stay a reviewer with your vote recorded — so the
// raw `--reviewer` listing keeps returning PRs you've already reviewed. We pull each PR's reviewer
// votes and keep only the ones where my vote is still 0; that is what lets the core clear the
// reviewer card once I act. Identity is compared in JS (like decodePr), never in the query.
async function listReviewRequestedPrs() {
  if (!ME) throw new Error("config.me must be set to your Azure display name to use reviewer auto-discovery");
  assertSafeIdentity(ME);
  const rows = await az(
    `repos pr list --reviewer "${ME}" --status active --query "[].{id:pullRequestId, repo:repository.name, createdAt:creationDate, reviewers:reviewers[].{name:displayName, vote:vote}}" -o json`
  );
  return rowsToPrs((rows || []).filter((r) => awaitingMyReview(r, ME)));
}

// List active PRs filtered by my identity in the given role (powers listMyOpenPrs via
// "creator"; the reviewer listing has its own vote-aware query above). `me` is the same display
// name Azure shows; az resolves it to the account (`@me` is NOT supported by `az repos pr
// list`). Relies on the CLI's configured org/project defaults, exactly like decodePr's calls.
function listByIdentity(role) {
  if (!ME) throw new Error(`config.me must be set to your Azure display name to use ${role} auto-discovery`);
  assertSafeIdentity(ME);
  return az(`repos pr list --${role} "${ME}" --status active --query "[].{id:pullRequestId, repo:repository.name, createdAt:creationDate}" -o json`);
}

// Shared shaping for the two list calls → the neutral [{ id, repo, createdAt }] contract.
function rowsToPrs(rows) {
  return (rows || []).map((r) => ({ id: r.id, repo: r.repo || "", createdAt: r.createdAt || "" })).filter((r) => r.repo);
}

module.exports = { me: ME, prUrl, decodePr, listMyOpenPrs, listReviewRequestedPrs, assertSafeId, assertSafeRepo, tallyVotes, awaitingMyReview };
