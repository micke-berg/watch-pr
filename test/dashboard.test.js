// Dashboard view modes: which data the page renders, and what it is allowed to write to
// the OS. app.js is a browser script, so it runs here in a vm with the handful of globals
// it touches; the assertions are on the rendered HTML and the recorded setAppBadge calls.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

const LIVE_STATE = {
  watching: [
    { id: 1, repository: "r", branch: "feature/AB-1-fix-thing", display: {
      title: "Fix thing", url: "#", target: "develop", prStatus: "active", isDraft: false,
      ci: "passed", approvals: 0, approvalNames: [], changesRequested: false, blockerNames: [],
      openComments: 2, mergeable: true, ready: false, updatedAt: new Date().toISOString() } },
    { id: 2, repository: "r", branch: "feature/AB-2-done-thing", display: {
      title: "Done thing", url: "#", target: "develop", prStatus: "completed", isDraft: false,
      ci: "passed", approvals: 1, approvalNames: ["R."], changesRequested: false, blockerNames: [],
      openComments: 0, mergeable: true, ready: true, updatedAt: new Date().toISOString() } },
  ],
};

function boot({ search = "", fetchImpl = () => new Promise(() => {}) } = {}) {
  const badge = [];
  const fetched = [];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, innerHTML: "", textContent: "", href: "", disabled: false,
      style: { cssText: "" }, addEventListener() {}, setAttribute() {}, focus() {}, value: "", placeholder: "" });
    return els.get(id);
  };
  const ctx = {
    console,
    document: {
      title: "watch-pr",
      getElementById: el,
      querySelector: () => el("__favicon"),
      documentElement: { setAttribute() {}, getAttribute: () => "dark" },
      addEventListener() {},
    },
    navigator: {
      setAppBadge: (n) => { badge.push(n); return Promise.resolve(); },
      clearAppBadge: () => { badge.push("clear"); return Promise.resolve(); },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search, host: "127.0.0.1:7878" },
    fetch: (u, opts) => { fetched.push(String(u).split("?")[0]); return fetchImpl(u, opts); },
    setInterval: () => 0,
    setTimeout,
    URL, URLSearchParams,
  };
  ctx.window = ctx;
  ctx.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const html = (id) => el(id).innerHTML;
  const settled = new Promise((r) => setTimeout(r, 60));
  return { ctx, badge, fetched, html, el, settled };
}

const liveFetch = (u) => u.startsWith("state.json")
  ? Promise.resolve({ ok: true, json: async () => LIVE_STATE })
  : Promise.resolve({ ok: true, json: async () => ({ alive: true, active: true }) });

test("live data drives the cards, the title and the app badge", async () => {
  const app = boot({ fetchImpl: liveFetch });
  await app.settled;
  assert.match(app.html("cards"), /Fix thing/);
  assert.match(app.html("doneSection"), /Done thing/);
  assert.equal(app.ctx.document.title, "watch-pr (1)");
  assert.deepEqual(app.badge, [1]);
});

test("an unreachable server renders an offline notice, never sample PRs", async () => {
  const app = boot({ fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) });
  await app.settled;
  assert.match(app.html("hero"), /No connection/);
  assert.equal(app.html("cards"), "");
  assert.doesNotMatch(app.html("hero") + app.html("cards"), /4821/); // a sample PR id
  assert.deepEqual(app.badge, []);
  assert.equal(app.ctx.document.title, "watch-pr");
});

test("the first paint, before any data lands, shows no counts at all", async () => {
  const app = boot(); // fetch never resolves
  await app.settled;
  assert.match(app.html("hero"), /Connecting/);
  assert.doesNotMatch(app.html("hero") + app.html("cards"), /4821/);
  assert.deepEqual(app.badge, []);
  assert.equal(app.ctx.document.title, "watch-pr");
});

test("?demo=1 renders the sample data, labelled, and stays off the OS and the server", async () => {
  const app = boot({ search: "?demo=1", fetchImpl: liveFetch });
  await app.settled;
  assert.match(app.html("hero"), /Demo/);
  assert.match(app.html("cards"), /4821/); // sample PRs are the point of demo mode
  assert.deepEqual(app.badge, []);         // ...but the icon badge stays out of it
  assert.equal(app.ctx.document.title, "watch-pr");
  assert.deepEqual(app.fetched, []);       // no polling, no /config
});

test("demo mode cannot mutate real state", async () => {
  const app = boot({ search: "?demo=1", fetchImpl: liveFetch });
  await app.settled;
  await app.ctx.clearDone();
  await app.ctx.dismiss(4821, "r");
  await app.ctx.checkNow();
  assert.deepEqual(app.fetched, []);
  assert.equal(app.el("checkBtn").disabled, true);
});
