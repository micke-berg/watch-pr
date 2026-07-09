// check.js — the deterministic poll + decode core for the watch-pr system.
//
// Provider-agnostic core. All host-specific work (talking to the PR host, decoding
// its votes / build status / comment threads) lives behind a provider adapter in
// providers/<host>.js; this file only ever sees the neutral decoded shape. That seam
// keeps the watch-pr SKILL prompt small and the dashboard and the loop from drifting.
// Both consumers call this:
//   - the dashboard server (server.js)  -> display-only refresh
//   - the watch-pr skill tick           -> full loop-field diff
//
// CLI:
//   node check.js          refresh each PR's display block, write state.json, print a human summary
//   node check.js --loop   also diff vs loop fields, update loop fields + phase, print JSON deltas
//                          (this is what the watch-pr skill runs each tick)
//
// Exports: runCheck({loop}), refreshAll(state, {loop}), decodePr(id, repo), pruneDone(state), pollIfDue()

const fs = require("fs");
const path = require("path");

const config = require("./config.js");
const { notify } = require("./notify.js"); // cross-platform desktop + optional phone push
// The provider adapter is the seam: it produces the neutral decoded shape and the PR
// web URL, and carries the "me" identity. Which adapter loads is config-driven, so the
// core stays completely host-agnostic. The map is a whitelist so config can't require
// an arbitrary path.
const PROVIDERS = { azure: "./providers/azure.js", github: "./providers/github.js" };
const provider = require(PROVIDERS[config.provider] || PROVIDERS.azure);
const ROOT = __dirname;
const STATE = path.join(ROOT, "state.json");
const ME = provider.me; // your own comments are not "a reviewer waiting on you"

// Read the local state file, tolerating first run: a fresh clone has no state.json
// (it's gitignored), so a missing file is the empty watch list, not an error. Corrupt
// JSON still throws — that's a real problem worth surfacing.
function loadState() {
  let raw;
  try { raw = fs.readFileSync(STATE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return { watching: [] }; throw e; }
  return JSON.parse(raw);
}

// The one place state is written, so every writer is atomic-shaped and consistent.
function saveState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}

// A PR's lifecycle phase from its decoded shape. Shared by registerPr (seed) and
// diffLoop (each tick) so the two can never disagree on what "done"/"ci"/"review" means.
function phaseFor(d) {
  if (d.prStatus === "completed" || d.prStatus === "abandoned") return "done";
  return (d.ci === "queued" || d.ci === "running") ? "ci" : "review";
}
const DONE_EXPIRE_MS = config.doneExpireHours * 60 * 60 * 1000; // merged/abandoned cards auto-drop after this
const APPROVALS_PREFERRED = config.approvalsPreferred || 2; // the "ready to merge" nudge target

function titleFromBranch(branch) {
  // Strip a leading JIRA-style ticket key (e.g. "ABC-123-") if present, then turn
  // separators into spaces. Host- and team-neutral: no hardcoded project prefix.
  return (branch || "").replace(/^[A-Za-z]+-\d+[-_]/, "").replace(/[-_]+/g, " ").trim() || branch || "(no title)";
}

// Deterministic notification, delegated to the cross-platform notifier (desktop toast
// per OS + optional ntfy phone push). Fire-and-forget; never disturbs the poller.
function fireNotify(title, message) {
  try { notify(title, message); } catch (e) { /* best-effort */ }
}

function buildDisplay(pr, d, nowIso) {
  return {
    title: d.title || (pr.display && pr.display.title) || pr.title || titleFromBranch(pr.branch),
    url: provider.prUrl(pr.repository, pr.id),
    target: d.target || pr.target || pr.targetBranch || (pr.display && pr.display.target) || "",
    prStatus: d.prStatus,
    isDraft: d.isDraft,
    ci: d.ci,
    approvals: d.approvals,
    approvalNames: d.approvalNames,
    changesRequested: d.changesRequested,
    blockerNames: d.blockerNames,
    openComments: d.openComments,
    mergeable: d.mergeable,
    ready: d.ready,
    createdAt: d.createdAt,
    updatedAt: nowIso,
  };
}

// Diff fresh data vs the PR's stored loop fields. Returns changes + notification hints + next loop state.
function diffLoop(pr, d, nowIso) {
  const seen = pr.seenThreads || {};
  const newComments = d.threads
    .filter((t) => t.updated && t.updated > (seen[t.id] || ""))
    .map((t) => ({ id: t.id, author: t.author, gist: t.gist, unresolved: t.unresolved }));

  const changes = {
    approvals: d.approvals !== (pr.lastApprovalCount || 0) ? { from: pr.lastApprovalCount || 0, to: d.approvals } : null,
    build: d.buildRaw !== (pr.lastBuildStatus || "") ? { from: pr.lastBuildStatus || "", to: d.buildRaw } : null,
    merge: d.mergeStatus !== (pr.lastMergeStatus || "") ? { from: pr.lastMergeStatus || "", to: d.mergeStatus } : null,
    changesRequested: d.changesRequested !== !!pr.lastChangesRequested ? { from: !!pr.lastChangesRequested, to: d.changesRequested } : null,
    newComments,
    merged: d.prStatus === "completed",
    abandoned: d.prStatus === "abandoned",
  };

  const actionNeeded = {
    // Fire once. Guard on the normalized ci (works for every provider) AND the Azure
    // buildRaw token (keeps exact parity for pre-upgrade entries that have no lastCi
    // stored yet). Each provider is carried by the term that applies to it.
    ciFailed: d.ci === "failed" && pr.lastCi !== "failed" && pr.lastBuildStatus !== "rejected",
    twoApprovals: d.approvals >= APPROVALS_PREFERRED && (pr.lastApprovalCount || 0) < APPROVALS_PREFERRED && !pr.readyNotified,
    changesRequested: d.changesRequested && !pr.lastChangesRequested,
    blockingComment: newComments.some((c) => c.unresolved && c.author && c.author !== ME),
    merged: d.prStatus === "completed" && !pr.mergeNotified,
  };

  const phase = phaseFor(d);

  const nextSeen = {};
  d.threads.forEach((t) => { if (t.updated) nextSeen[t.id] = t.updated; });

  const nextLoop = {
    phase,
    doneAt: pr.doneAt || (phase === "done" ? nowIso : ""),
    lastApprovalCount: d.approvals,
    lastBuildStatus: d.buildRaw,
    lastCi: d.ci,
    lastMergeStatus: d.mergeStatus,
    lastChangesRequested: d.changesRequested,
    seenThreads: nextSeen,
    readyNotified: pr.readyNotified || actionNeeded.twoApprovals,
    mergeNotified: pr.mergeNotified || actionNeeded.merged,
    lastTickAt: nowIso,
  };

  const hasChanges = !!(changes.approvals || changes.build || changes.merge || changes.changesRequested || newComments.length || changes.merged || changes.abandoned);
  return { changes, actionNeeded, nextLoop, phase, hasChanges };
}

// Tidy the watch list: backfill doneAt on any merged/abandoned PR that predates this
// field, then drop the ones that finished more than DONE_EXPIRE_MS ago. Returns the
// number of mutations so callers know whether to persist. Runs on every poll so the
// "Done" strip self-empties over time instead of growing without bound.
function pruneDone(state) {
  const now = Date.now();
  const list = state.watching || [];
  let changed = 0;
  state.watching = list.filter((pr) => {
    if (pr.phase !== "done") return true;
    if (!pr.doneAt) { pr.doneAt = pr.lastTickAt || new Date().toISOString(); changed++; }
    if (now - Date.parse(pr.doneAt) > DONE_EXPIRE_MS) { changed++; return false; }
    return true;
  });
  return changed;
}

async function refreshAll(state, opts) {
  const loop = !!(opts && opts.loop);
  const nowIso = new Date().toISOString();
  pruneDone(state); // drop long-finished cards before polling the rest
  const results = [];
  await Promise.all(
    (state.watching || []).map(async (pr) => {
      // A finished PR never changes again — keep its snapshot, skip the Azure round-trip.
      if (pr.phase === "done") {
        results.push({ id: pr.id, title: (pr.display && pr.display.title) || titleFromBranch(pr.branch), display: pr.display, done: true });
        return;
      }
      try {
        const d = await provider.decodePr(pr.id, pr.repository);
        pr.display = buildDisplay(pr, d, nowIso);
        if (loop) {
          const { changes, actionNeeded, nextLoop, phase, hasChanges } = diffLoop(pr, d, nowIso);
          Object.assign(pr, nextLoop);
          // Deterministic, edge-triggered notifications (each fires once; the diff guards re-firing).
          const an = actionNeeded, t = pr.display.title;
          if (an.ciFailed)          fireNotify("CI failed", `#${pr.id} ${t}: build rejected`);
          if (an.twoApprovals)      fireNotify("Ready to merge", `#${pr.id} ${t}: ${APPROVALS_PREFERRED} approvals reached`);
          if (an.changesRequested)  fireNotify("Changes requested", `#${pr.id} ${t}: a reviewer is waiting on you`);
          if (an.blockingComment)   fireNotify("Review comment", `#${pr.id} ${t}: new reviewer comment`);
          if (an.merged)            fireNotify("PR merged", `#${pr.id} ${t}: merged`);
          results.push({ id: pr.id, title: pr.display.title, phase, hasChanges, changes, actionNeeded, display: pr.display });
        } else {
          results.push({ id: pr.id, title: pr.display.title, display: pr.display });
        }
      } catch (e) {
        results.push({ id: pr.id, error: e.message });
      }
    })
  );

  let suggestedDelaySeconds = null;
  const active = (state.watching || []).filter((p) => p.phase !== "done");
  if (active.length) suggestedDelaySeconds = active.some((p) => p.phase === "ci") ? config.cadence.ciSeconds : config.cadence.reviewSeconds;

  return { state, results, suggestedDelaySeconds };
}

// Auto-discovery for "watch all my open PRs" (config.watchMine). When the provider can
// list your PRs, add any that aren't already watched — across every repo, no manual add.
// Mutates state in place (the caller persists) and returns how many were added. Fully
// best-effort: a listing or decode failure is swallowed and retried next tick, never
// sinking a poll. A no-op unless watchMine is on and the provider supports listing.
async function syncMine(state) {
  if (!config.watchMine || typeof provider.listMyOpenPrs !== "function") return 0;
  state.watching = state.watching || [];
  let mine;
  try { mine = await provider.listMyOpenPrs(); }
  catch (e) { return 0; }
  const nowIso = new Date().toISOString();
  // Skip PRs older than the cutoff so long-abandoned experiments don't clutter the board
  // (0 = no age limit). We filter on the listing's createdAt first (no decode cost); when
  // the provider omits it, we fall back to the decoded createdAt below.
  const maxAgeMs = (config.watchMineMaxAgeDays || 0) * 24 * 60 * 60 * 1000;
  const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : 0;
  const tooOld = (createdAt) => cutoff && createdAt && Date.parse(createdAt) < cutoff;
  let added = 0;
  for (const row of mine || []) {
    const repository = row.repo || config.defaultRepository;
    if (!row.id || !repository || isWatched(state, row.id, repository)) continue;
    if (tooOld(row.createdAt)) continue; // stale per the listing — never even decode it
    try {
      const d = await provider.decodePr(Number(row.id), repository);
      if (tooOld(d.createdAt)) continue; // fallback for providers whose listing has no date
      state.watching.push(makeEntry(row.id, repository, d, nowIso));
      added++;
    } catch (e) { /* skip this PR; a later tick retries it */ }
  }
  if (added) state.nextPollAt = ""; // re-evaluate cadence now that the list changed
  return added;
}

async function runCheck(opts) {
  const state = loadState();
  if (config.watchMine) await syncMine(state);
  const out = await refreshAll(state, opts);
  if (opts && opts.loop) {
    out.state.nextPollAt = out.suggestedDelaySeconds
      ? new Date(Date.now() + out.suggestedDelaySeconds * 1000).toISOString()
      : "";
  }
  saveState(out.state);
  return out;
}

// Resident-poller entry point (used by server.js). Polls Azure only when the shared
// cadence (state.nextPollAt) says it's due AND something active is being watched;
// otherwise it just expires finished cards and idles with zero Azure calls. Because
// both this and the Claude `--loop` path write nextPollAt, and check.js's notifications
// are edge-triggered (fire once), the two can run at once without double-polling or
// double-notifying.
async function pollIfDue(opts) {
  const force = !!(opts && opts.force);
  const state = loadState();
  const now = Date.now();
  const due = force || !state.nextPollAt || now >= Date.parse(state.nextPollAt);

  // Discover new PRs on the poll cadence, never on every heartbeat — so watch-all doesn't
  // turn an idle machine into a per-minute PR search. Runs only when a poll is due.
  if (due && config.watchMine) await syncMine(state);

  const active = (state.watching || []).filter((p) => p.phase !== "done");

  if (!active.length) {
    let changed = pruneDone(state) > 0;
    // With watch-all on, keep re-checking for new PRs even while the list is empty, by
    // scheduling the next discovery on the review cadence (otherwise an empty list would
    // never poll again and the first PR would never be found).
    if (due && config.watchMine) {
      state.nextPollAt = new Date(now + config.cadence.reviewSeconds * 1000).toISOString();
      changed = true;
    }
    if (changed) saveState(state);
    return { polled: false, idle: true, active: 0, nextPollAt: state.nextPollAt || "" };
  }
  if (!due) {
    return { polled: false, notDue: true, active: active.length, nextPollAt: state.nextPollAt };
  }

  const out = await refreshAll(state, { loop: true });
  out.state.nextPollAt = out.suggestedDelaySeconds
    ? new Date(now + out.suggestedDelaySeconds * 1000).toISOString()
    : "";
  saveState(out.state);
  return {
    polled: true,
    active: active.length,
    nextPollAt: out.state.nextPollAt,
    suggestedDelaySeconds: out.suggestedDelaySeconds,
    results: out.results,
  };
}

// Build a fully-seeded watch-list entry from a decoded PR. Every last-seen field is set
// to the current situation so the PR does NOT fire notifications for its existing
// CI/approval/comment state — only for future changes. Pure: no I/O, so both registerPr
// (manual add) and syncMine (auto-discovery) can share it.
function makeEntry(id, repository, d, nowIso) {
  const phase = phaseFor(d);
  const seenThreads = {};
  (d.threads || []).forEach((t) => { if (t.updated) seenThreads[t.id] = t.updated; });

  const entry = {
    id: Number(id),
    repository,
    branch: d.branch || "",
    targetBranch: d.target || "",
    worktree: "",
    title: d.title || "",
    phase,
    lastApprovalCount: d.approvals,
    lastBuildStatus: d.buildRaw,
    lastCi: d.ci,
    lastMergeStatus: d.mergeStatus,
    lastChangesRequested: d.changesRequested,
    seenThreads,
    readyNotified: d.approvals >= APPROVALS_PREFERRED, // already at preferred → don't announce
    mergeNotified: d.prStatus === "completed",
    doneAt: phase === "done" ? nowIso : "",
    lastTickAt: nowIso,
  };
  entry.display = buildDisplay(entry, d, nowIso);
  return entry;
}

// True if this id+repo is already on the watch list. id alone is not unique across repos
// (every repo numbers PRs from 1), so watch-all matches on both.
function isWatched(state, id, repository) {
  return (state.watching || []).some((p) => String(p.id) === String(id) && p.repository === repository);
}

// Add a PR to the watch list by id (the dashboard's "add PR" input; also usable for any
// manual entry point). Enriches from the host so the card renders fully right away.
// Read-only against the host; the only write is the local state file.
async function registerPr(id, repo) {
  id = String(id == null ? "" : id).trim();
  if (!/^\d+$/.test(id)) throw new Error("PR id must be a number");
  const repository = (repo && String(repo).trim()) || config.defaultRepository;

  const state = loadState();
  state.watching = state.watching || [];
  if (isWatched(state, id, repository)) {
    return { added: false, reason: "already watching", id: Number(id) };
  }

  const d = await provider.decodePr(Number(id), repository); // throws if the PR can't be read
  const entry = makeEntry(id, repository, d, new Date().toISOString());
  state.watching.push(entry);
  state.nextPollAt = ""; // let the resident poller re-evaluate cadence on its next tick
  saveState(state);
  return { added: true, id: Number(id), entry };
}

// decodePr is re-exported from the active provider so existing importers (and the
// parity harness) keep the same surface after the seam extraction. diffLoop and
// titleFromBranch are exported for unit tests (pure functions).
module.exports = { runCheck, refreshAll, decodePr: provider.decodePr, pruneDone, pollIfDue, registerPr, syncMine, diffLoop, titleFromBranch, phaseFor, isWatched };

// CLI
if (require.main === module) {
  const loop = process.argv.includes("--loop");
  runCheck({ loop })
    .then((out) => {
      if (loop) {
        console.log(JSON.stringify({ suggestedDelaySeconds: out.suggestedDelaySeconds, results: out.results }, null, 2));
      } else {
        console.log(
          out.results
            .map((r) =>
              r.error
                ? `#${r.id}: ERROR ${r.error}`
                : `#${r.id} ${r.display.title}: CI ${r.display.ci}, ${r.display.approvals}/2 approvals, ${r.display.openComments} open comments${r.display.changesRequested ? ", CHANGES REQUESTED" : ""}${r.display.isDraft ? ", draft" : ""}${r.display.ready ? ", READY" : ""}`
            )
            .join("\n") || "(nothing being watched)"
        );
      }
    })
    .catch((e) => { console.error("check failed: " + e.message); process.exit(1); });
}
