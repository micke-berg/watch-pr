// Server security guards: DNS-rebinding, CSRF, and static path safety (pure; the module
// only starts a socket when run directly, so requiring it here has no side effects).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const srv = require("../server.js");

test("hostAllowed: localhost forms pass, everything else fails", () => {
  assert.equal(srv.hostAllowed({ headers: { host: "localhost:7878" } }), true);
  assert.equal(srv.hostAllowed({ headers: { host: "127.0.0.1:7878" } }), true);
  assert.equal(srv.hostAllowed({ headers: { host: "[::1]" } }), true);
  assert.equal(srv.hostAllowed({ headers: { host: "evil.example" } }), false);
  assert.equal(srv.hostAllowed({ headers: {} }), false); // missing Host
});

test("csrfSafe: POST that is same-origin / none / header-less (curl) is allowed", () => {
  assert.equal(srv.csrfSafe({ method: "POST", headers: {} }), true);
  assert.equal(srv.csrfSafe({ method: "POST", headers: { "sec-fetch-site": "same-origin" } }), true);
  assert.equal(srv.csrfSafe({ method: "POST", headers: { "sec-fetch-site": "none" } }), true);
  assert.equal(srv.csrfSafe({ method: "POST", headers: { origin: "http://localhost:7878" } }), true);
});

test("csrfSafe: GET (sub-resource), cross-site, and hostile origin are blocked", () => {
  assert.equal(srv.csrfSafe({ method: "GET", headers: {} }), false); // <img>/<script>
  assert.equal(srv.csrfSafe({ method: "POST", headers: { "sec-fetch-site": "cross-site" } }), false);
  assert.equal(srv.csrfSafe({ method: "POST", headers: { origin: "http://evil.example" } }), false);
});

test("staticFileFor: real files served, secrets + traversal rejected", () => {
  assert.equal(srv.staticFileFor("/index.html").status, 200);
  assert.equal(srv.staticFileFor("/").status, 200);
  assert.equal(srv.staticFileFor("/state.json").status, 200); // dashboard data feed
  assert.equal(srv.staticFileFor("/config.json").status, 404); // secret: never served
  assert.equal(srv.staticFileFor("/../../etc/passwd").status, 403); // traversal
});
