// Azure adapter: the shell-injection input validation (the trust boundary before `az`).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const az = require("../providers/azure.js");

test("assertSafeId accepts numeric ids, rejects everything else", () => {
  az.assertSafeId(123);
  az.assertSafeId("42");
  assert.throws(() => az.assertSafeId("1; calc"));
  assert.throws(() => az.assertSafeId("abc"));
  assert.throws(() => az.assertSafeId(""));
});

test("assertSafeRepo accepts normal repo names", () => {
  az.assertSafeRepo("frontend-monorepo");
  az.assertSafeRepo("owner/repo");
  az.assertSafeRepo("My Repo.Name_1");
});

test("assertSafeRepo rejects shell metacharacters", () => {
  for (const bad of ["x;calc", "a && b", "a`b`", "a|b", "a$(x)", "a>b", 'a"b', "a\nb"]) {
    assert.throws(() => az.assertSafeRepo(bad), /invalid repository/, `should reject ${JSON.stringify(bad)}`);
  }
});

// tallyVotes: the approval/block arithmetic. The key case is that YOUR OWN approval counts —
// on a colleague's PR you reviewed, your vote is a real approval, so it must read 2/2 not 1/2.
test("tallyVotes: my own approval counts toward the bar", () => {
  const t = az.tallyVotes([{ name: "Me", vote: 10 }, { name: "Alex", vote: 10 }], "Me");
  assert.equal(t.approvals, 2);
  assert.deepEqual(t.approvalNames.sort(), ["Alex", "Me"]);
  assert.equal(t.changesRequested, false);
});

test("tallyVotes: containers never count; approved-with-suggestions (5) counts", () => {
  const t = az.tallyVotes([
    { name: "Team X", vote: 10, isContainer: true },
    { name: "Alex", vote: 5 },
  ], "Me");
  assert.equal(t.approvals, 1);
  assert.deepEqual(t.approvalNames, ["Alex"]);
});

test("tallyVotes: a blocking vote flags changes requested, but never your own", () => {
  const other = az.tallyVotes([{ name: "Alex", vote: -10 }], "Me");
  assert.equal(other.changesRequested, true);
  assert.deepEqual(other.blockerNames, ["Alex"]);
  const mine = az.tallyVotes([{ name: "Me", vote: -5 }], "Me");
  assert.equal(mine.changesRequested, false); // your own "waiting" is not someone waiting on you
});

// awaitingMyReview: Azure keeps you a reviewer after you vote, so the raw --reviewer list must
// be filtered to PRs where your vote is still 0 — otherwise a PR you approved sticks on the board.
test("awaitingMyReview: keep unreviewed PRs, drop the ones I've already voted on", () => {
  assert.equal(az.awaitingMyReview({ reviewers: [{ name: "Me", vote: 0 }, { name: "Alex", vote: 10 }] }, "Me"), true);
  assert.equal(az.awaitingMyReview({ reviewers: [{ name: "Me", vote: 10 }] }, "Me"), false); // approved -> not awaiting
  assert.equal(az.awaitingMyReview({ reviewers: [{ name: "Me", vote: -5 }] }, "Me"), false);  // waiting -> acted
  assert.equal(az.awaitingMyReview({ reviewers: [{ name: "Alex", vote: 0 }] }, "Me"), true);  // no entry -> keep (defensive)
});
