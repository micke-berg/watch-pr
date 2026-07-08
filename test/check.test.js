// Core: branch-title derivation, the edge-triggered notification logic, and tidy/expiry.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const check = require("../check.js");

test("titleFromBranch strips a JIRA-style key, leaves plain branches alone", () => {
  assert.equal(check.titleFromBranch("TIP-18340-Fix-Header"), "Fix Header");
  assert.equal(check.titleFromBranch("ABC-1-add_widget"), "add widget");
  assert.equal(check.titleFromBranch("my-feature-branch"), "my feature branch");
  assert.equal(check.titleFromBranch(""), "(no title)");
});

// A neutral decoded shape with sensible defaults; override per test.
const decoded = (over = {}) => Object.assign({
  prStatus: "active", mergeStatus: "succeeded", mergeable: true, isDraft: false,
  createdAt: "", title: "t", branch: "b", target: "main", buildRaw: "SUCCESS", ci: "passed",
  approvals: 0, approvalNames: [], changesRequested: false, blockerNames: [],
  openComments: 0, threads: [], ready: false,
}, over);
const NOW = "2026-07-08T00:00:00.000Z";

test("diffLoop: CI failure fires exactly once (guarded by lastCi)", () => {
  const pr = { lastCi: "passed", lastBuildStatus: "SUCCESS" };
  const first = check.diffLoop(pr, decoded({ ci: "failed", buildRaw: "FAILURE" }), NOW);
  assert.equal(first.actionNeeded.ciFailed, true);
  const second = check.diffLoop(first.nextLoop, decoded({ ci: "failed", buildRaw: "FAILURE" }), NOW);
  assert.equal(second.actionNeeded.ciFailed, false);
});

test("diffLoop: reaching the preferred approval target fires once", () => {
  // default approvalsPreferred is 2
  const pr = { lastApprovalCount: 1, readyNotified: false };
  const r = check.diffLoop(pr, decoded({ approvals: 2 }), NOW);
  assert.equal(r.actionNeeded.twoApprovals, true);
  assert.equal(r.nextLoop.readyNotified, true);
  const again = check.diffLoop(r.nextLoop, decoded({ approvals: 2 }), NOW);
  assert.equal(again.actionNeeded.twoApprovals, false);
});

test("diffLoop: merge notifies once and flips phase to done", () => {
  const r = check.diffLoop({ mergeNotified: false }, decoded({ prStatus: "completed" }), NOW);
  assert.equal(r.actionNeeded.merged, true);
  assert.equal(r.phase, "done");
  const again = check.diffLoop(r.nextLoop, decoded({ prStatus: "completed" }), NOW);
  assert.equal(again.actionNeeded.merged, false);
});

test("diffLoop: a steady tick reports no changes and no notifications", () => {
  const pr = {
    lastApprovalCount: 1, lastBuildStatus: "SUCCESS", lastCi: "passed", lastMergeStatus: "succeeded",
    lastChangesRequested: false, seenThreads: {}, readyNotified: false, mergeNotified: false,
  };
  const r = check.diffLoop(pr, decoded({ approvals: 1 }), NOW);
  assert.equal(r.hasChanges, false);
  assert.equal(Object.values(r.actionNeeded).some(Boolean), false);
});

test("pruneDone: drops long-finished cards, keeps active + recent", () => {
  const h = (n) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
  const state = { watching: [
    { id: 1, phase: "review" },
    { id: 2, phase: "done", doneAt: h(48) }, // older than the 24h default -> dropped
    { id: 3, phase: "done", doneAt: h(1) },  // recent -> kept
  ] };
  check.pruneDone(state);
  assert.deepEqual(state.watching.map((p) => p.id).sort(), [1, 3]);
});
