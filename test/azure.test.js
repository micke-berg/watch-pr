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
