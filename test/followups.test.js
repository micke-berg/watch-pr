// Follow-ups for your own PRs: the CI-failure note and the merged-PR cleanup offer.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const f = require("../followups.js");

const pr = { id: 42, repository: "repo", display: { title: "Fix the thing", url: "https://host/pr/42" } };

test("ciFailedNote: names the failing step and tells you how to get a fix proposed", () => {
  const note = f.ciFailedNote(pr, { buildId: 7, pipeline: "PR checks", step: "Run tests", issues: ["error TS1: boom"], logLines: ["error TS1: boom", "...", "tail"], buildUrl: "https://host/b/7" });
  assert.equal(note.title, "CI failed: PR 42");
  assert.match(note.message, /Run tests failed \(PR checks\)\. error TS1: boom/);
  assert.match(note.message, /Say "fix PR 42" in a Claude session/);
  assert.match(note.report, /## Relevant log lines\n\n```\nerror TS1: boom\n\.\.\.\ntail\n```/);
  assert.equal(note.reportName, "pr-42-ci-7.md");
});

test("mergedNote: offers the worktree + local branch cleanup, warns about uncommitted work, never a remote command", () => {
  const entry = { mainDir: "C:\\r\\app", branch: "feat-x", target: "develop", hasBranch: true, worktree: "C:\\r\\app-x", checkedOutInMain: false, dirty: 2, servers: [{ pid: 99 }] };
  const note = f.mergedNote(pr, [entry]);
  assert.match(note.message, /Clean up worktree app-x \+ branch feat-x \(has uncommitted changes\)\?/);
  assert.match(note.report, /WARNING: the worktree has 2 uncommitted change/);
  const cmds = f.cleanupCommands(entry).join("\n");
  assert.match(cmds, /worktree remove "C:\/r\/app-x"/);
  assert.match(cmds, /branch -d feat-x/);
  assert.match(cmds, /Stop-Process -Id 99/);
  assert.doesNotMatch(cmds, /push|--delete|origin/);
});

test("mergedNote: nothing local means a plain merged notification and no report", () => {
  const note = f.mergedNote(pr, []);
  assert.equal(note.reportName, null);
  assert.match(note.message, /No local worktree or branch left to clean up/);
});
