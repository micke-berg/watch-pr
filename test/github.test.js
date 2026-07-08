// GitHub adapter: CI-status derivation + PR-state mapping (pure, no network).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const gh = require("../providers/github.js");

test("deriveCi: empty/absent rollup -> none", () => {
  assert.equal(gh.deriveCi([]).ci, "none");
  assert.equal(gh.deriveCi(null).ci, "none");
});

test("deriveCi: all success -> passed", () => {
  assert.equal(gh.deriveCi([{ status: "COMPLETED", conclusion: "SUCCESS" }]).ci, "passed");
});

test("deriveCi: any failure wins, even mixed with a pending check", () => {
  const r = gh.deriveCi([
    { status: "COMPLETED", conclusion: "FAILURE" },
    { status: "IN_PROGRESS", conclusion: null },
  ]);
  assert.equal(r.ci, "failed");
});

test("deriveCi: pending with no failure -> running", () => {
  assert.equal(gh.deriveCi([{ status: "IN_PROGRESS", conclusion: null }]).ci, "running");
  assert.equal(gh.deriveCi([{ status: "QUEUED", conclusion: null }]).ci, "running");
});

test("deriveCi: StatusContext .state is read too (not just CheckRun .status)", () => {
  assert.equal(gh.deriveCi([{ __typename: "StatusContext", state: "FAILURE" }]).ci, "failed");
  assert.equal(gh.deriveCi([{ __typename: "StatusContext", state: "PENDING" }]).ci, "running");
  assert.equal(gh.deriveCi([{ __typename: "StatusContext", state: "SUCCESS" }]).ci, "passed");
});

test("deriveCi: NEUTRAL/SKIPPED count as passing", () => {
  const r = gh.deriveCi([
    { status: "COMPLETED", conclusion: "SKIPPED" },
    { status: "COMPLETED", conclusion: "NEUTRAL" },
  ]);
  assert.equal(r.ci, "passed");
});

test("mapPrStatus: OPEN/MERGED/CLOSED/unknown", () => {
  assert.equal(gh.mapPrStatus("OPEN"), "active");
  assert.equal(gh.mapPrStatus("MERGED"), "completed");
  assert.equal(gh.mapPrStatus("CLOSED"), "abandoned");
  assert.equal(gh.mapPrStatus(undefined), "active");
});

test("prUrl builds a github.com pull URL", () => {
  assert.equal(gh.prUrl("owner/repo", 42), "https://github.com/owner/repo/pull/42");
});
