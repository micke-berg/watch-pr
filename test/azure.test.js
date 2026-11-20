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

test("combineBuildStatus: one red build makes the PR red, whichever policy it is", () => {
  const b = (status) => ({ name: "Build", status });
  assert.equal(az.combineBuildStatus([b("approved"), b("rejected")]), "rejected");
  assert.equal(az.combineBuildStatus([b("approved"), b("running")]), "running");
  assert.equal(az.combineBuildStatus([b("approved"), { name: "Comment requirements", status: "rejected" }]), "approved");
  assert.equal(az.combineBuildStatus([{ name: "Required reviewers", status: "approved" }]), "");
});

test("pickLogLines: real errors first, then the log's closing summary, without timestamps or colour codes", () => {
  const raw = [
    "2026-10-05T12:38:18.4727109Z ##[section]Starting: Check All",
    "2026-10-05T12:38:19.0000000Z \u001b[33mwarning\u001b[39m  'x' is defined but never used",
    "2026-10-05T12:38:20.0000000Z libs/a.tsx:2:36 - error TS6133: 'CSSProperties' is declared but its value is never read.",
    "2026-10-05T12:38:21.0000000Z Failed tasks:",
    "2026-10-05T12:38:22.0000000Z - card-module:build:production",
    "2026-10-05T12:38:23.0000000Z ##[error]Bash exited with code '1'.",
    "2026-10-05T12:38:24.0000000Z ##[section]Finishing: Check All",
  ];
  const lines = az.pickLogLines(raw, 20);
  assert.equal(lines[0], "libs/a.tsx:2:36 - error TS6133: 'CSSProperties' is declared but its value is never read.");
  assert.ok(lines.includes("- card-module:build:production"));
  assert.ok(lines.every((l) => !/^\d{4}-/.test(l) && !l.includes("\u001b") && !l.startsWith("##[section]")));
  assert.ok(!lines.slice(0, lines.indexOf("...")).some((l) => l.includes("exited with code"))); // the generic exit line is not an "error" anchor
});

test("reviewInboxFrom: PRs where I or one of my teams is asked, I have not voted, not drafts, not mine", () => {
  const team = { id: "t-fe", displayName: "[Online]\\Frontend Team", isContainer: true, vote: 0 };
  const other = { id: "t-be", displayName: "[Online]\\Backend Team", isContainer: true, vote: 0 };
  const me = (vote) => ({ id: "u-me", displayName: "Me", uniqueName: "me@corp.com", vote });
  const pr = (id, reviewers, extra) => Object.assign({ pullRequestId: id, title: "t" + id, repository: { name: "repo" }, createdBy: { displayName: "Alex" }, creationDate: "2026-10-0" + (id % 9) + "T00:00:00Z", reviewers }, extra);
  const out = az.reviewInboxFrom([
    pr(1, [team]),                                   // via my team -> in
    pr(2, [me(0)]),                                  // me directly, no vote -> in
    pr(3, [team, me(10)]),                           // I approved -> out
    pr(4, [other]),                                  // a team I'm not in -> out
    pr(5, [team], { isDraft: true }),                // draft -> out
    pr(6, [team], { createdBy: { displayName: "Me", uniqueName: "me@corp.com" } }), // my own -> out
  ], [{ id: "t-fe" }], "Me", "ME@corp.com");
  assert.deepEqual(out.map((p) => p.id), [1, 2]);
  assert.equal(out[0].via, "Frontend Team");
  assert.equal(out[1].via, "you");
});
