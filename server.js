// Tiny zero-dependency static server for the watch-pr dashboard.
// Serves index.html + state.json on localhost, and exposes POST /check which
// re-polls Azure on demand by delegating to the shared check.js core.
//
// /check is READ-ONLY against Azure and (display-only mode) refreshes just each
// PR's `display` block, leaving the loop-owned fields to the Claude watch loop.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { runCheck, pruneDone, pollIfDue, registerPr } = require("./check.js");
const config = require("./config.js");
const { spawn } = require("child_process");

const PORT = process.env.PR_WATCH_PORT || config.port;
const ROOT = __dirname;
const STATE = path.join(ROOT, "state.json");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// /analyze-conflict spawns a fresh, read-only headless Claude to explain a PR's merge
// conflict. Configured via config.json (claudeExe); empty disables the feature.
const CLAUDE = config.claudeExe;
const MAIN_REPO = config.mainRepoDir; // git dir fallback when a PR's worktree is gone
const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
const analyzing = new Set(); // PR ids with an in-flight analysis

async function handleCheck(res) {
  try {
    const { state, results } = await runCheck({ loop: false });
    const errors = results.filter((r) => r.error).map((r) => `#${r.id}: ${r.error}`);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(Object.assign({}, state, errors.length ? { _checkErrors: errors } : {})));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readState() {
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
}
function writeState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}
function findWatchedPr(id) {
  return (readState().watching || []).find((p) => String(p.id) === String(id));
}

// Remove a single PR from the watch list (the per-card ✕ on the dashboard's Done strip).
function handleDismiss(res, id) {
  if (!id) return sendJson(res, 400, { ok: false, error: "missing id" });
  let state;
  try { state = readState(); }
  catch (e) { return sendJson(res, 500, { ok: false, error: "cannot read state.json: " + e.message }); }
  const before = (state.watching || []).length;
  state.watching = (state.watching || []).filter((p) => String(p.id) !== String(id));
  if (state.watching.length === before) return sendJson(res, 404, { ok: false, error: `PR ${id} is not being watched` });
  writeState(state);
  sendJson(res, 200, { ok: true, removed: 1, watching: state.watching });
}

// Add a PR to the watch list by id (the dashboard's "Watch a PR" input). Enriches from
// Azure via check.js's registerPr; read-only against Azure, writes only the local state.
async function handleWatch(res, id, repo) {
  if (!id) return sendJson(res, 400, { ok: false, error: "missing id" });
  try {
    const out = await registerPr(id, repo);
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "couldn't add PR " + id + " — " + (e.message || "not found or not accessible") });
  }
}

// Clear every finished (merged/abandoned) PR at once (the "Clear all" button).
function handleClearDone(res) {
  let state;
  try { state = readState(); }
  catch (e) { return sendJson(res, 500, { ok: false, error: "cannot read state.json: " + e.message }); }
  const before = (state.watching || []).length;
  state.watching = (state.watching || []).filter((p) => p.phase !== "done");
  writeState(state);
  sendJson(res, 200, { ok: true, removed: before - state.watching.length, watching: state.watching });
}

// The conflict-analysis "brain" lives here as a prompt on purpose. We deliberately did NOT
// make it a skill: a capable model already analyzes a conflict unaided (an eval showed a
// no-skill baseline matching it), so the value is the one-click trigger, not the knowledge.
function analyzePrompt(pr, gitdir) {
  const target = pr.target || (pr.display && pr.display.target) || "develop";
  return [
    "Investigate a git merge conflict, strictly read-only, and report how to resolve it.",
    "",
    `PR #${pr.id}: branch "${pr.branch}" merging into "${target}".`,
    `Git working directory: ${gitdir}`,
    "",
    "Steps (read-only only):",
    `1. git -C "${gitdir}" fetch origin "${target}" "${pr.branch}"`,
    `2. git -C "${gitdir}" merge-tree --write-tree --name-only "origin/${target}" "origin/${pr.branch}" — exit 1 means conflicts (first output line is the merged-tree OID, the remaining lines are the conflicting paths); exit 0 means it merges clean, so say the dashboard may be stale and stop.`,
    `3. For each conflicting file: find the merge base (git -C "${gitdir}" merge-base "origin/${target}" "origin/${pr.branch}"), see what each side changed (git -C "${gitdir}" diff <base>..origin/<ref> -- <file>) and the conflicted region (git -C "${gitdir}" show <oid>:<file>).`,
    "4. Report per file: what the target changed, what the PR changed, why they collide, a class (trivial / semantic / structural), and how to resolve it. Then give one overall strategy and the concrete commands for the user to run themselves. Call out when a rebase plus re-running a codemod beats a hand-merge.",
    "",
    "Do NOT modify any repository, branch, index, or working tree. Use only read-only git (fetch, merge-base, merge-tree, diff, show, log). Output the analysis as Markdown.",
  ].join("\n");
}

function handleAnalyze(res, id) {
  if (!id) return sendJson(res, 400, { ok: false, error: "missing id" });
  if (!CLAUDE) return sendJson(res, 501, { ok: false, error: "conflict analysis not configured (set claudeExe in config.json)" });
  let pr;
  try { pr = findWatchedPr(id); }
  catch (e) { return sendJson(res, 500, { ok: false, error: "cannot read state.json: " + e.message }); }
  if (!pr) return sendJson(res, 404, { ok: false, error: `PR ${id} is not being watched` });
  if (analyzing.has(String(id))) return sendJson(res, 409, { ok: false, error: "analysis already running for this PR" });

  const gitdir = pr.worktree && fs.existsSync(pr.worktree) ? pr.worktree : MAIN_REPO;
  analyzing.add(String(id));

  // shell:false + args array + prompt over stdin => nothing to escape, and no .cmd/shell
  // quirks. Tools are scoped to read-only git plus the read tools, nothing that writes.
  const child = spawn(CLAUDE, ["-p", "--allowedTools", "Bash(git *) Read Grep Glob", "--output-format", "text"], {
    cwd: gitdir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "", err = "";
  const timer = setTimeout(() => child.kill(), ANALYZE_TIMEOUT_MS);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => {
    clearTimeout(timer); analyzing.delete(String(id));
    if (!res.writableEnded) sendJson(res, 500, { ok: false, error: "failed to launch claude: " + e.message });
  });
  child.on("close", (code) => {
    clearTimeout(timer); analyzing.delete(String(id));
    if (res.writableEnded) return;
    if (code === 0 && out.trim()) sendJson(res, 200, { ok: true, id: String(id), markdown: out.trim() });
    else sendJson(res, 500, { ok: false, error: (err.trim() || `claude exited with code ${code}`).slice(0, 2000) });
  });
  child.stdin.write(analyzePrompt(pr, gitdir));
  child.stdin.end();
}

// ── Resident poller ─────────────────────────────────────────────────────────────
// While server.js runs, THIS process is the watcher: it polls Azure on the shared
// cadence and fires check.js's desktop/phone notifications — no Claude session needed.
// It ticks every HEARTBEAT_MS but only reaches Azure when state.nextPollAt says it is
// due (~300s while CI runs, ~1500s in review, never when the list is empty), so an idle
// tick is a tiny state.json read and nothing else. /status exposes liveness + the next
// poll time so the dashboard can show "live" instead of "viewer only".
const HEARTBEAT_MS = 60 * 1000;
const poller = { startedAt: new Date().toISOString(), lastPollAt: null, nextPollAt: null, active: 0, lastError: null };
let pollTimer = null;

async function pollTick() {
  try {
    const r = await pollIfDue();
    poller.active = r.active;
    poller.nextPollAt = r.nextPollAt || null;
    if (r.polled) poller.lastPollAt = new Date().toISOString();
    poller.lastError = null;
  } catch (e) {
    poller.lastError = e.message;
    console.error("poll tick failed:", e.message);
  } finally {
    pollTimer = setTimeout(pollTick, HEARTBEAT_MS);
  }
}

function handleStatus(res) {
  let watching = 0;
  try { watching = (readState().watching || []).length; } catch (e) { /* ignore */ }
  sendJson(res, 200, {
    alive: true, watching, active: poller.active,
    lastPollAt: poller.lastPollAt, nextPollAt: poller.nextPollAt,
    startedAt: poller.startedAt, lastError: poller.lastError,
  });
}

// Presentation-relevant config for the page (attribution + approval thresholds), so the
// dashboard stays config-driven and portable rather than hardcoding one person's values.
function handleConfig(res) {
  sendJson(res, 200, {
    builtBy: config.builtBy || "",
    builtByUrl: config.builtByUrl || "",
    approvalsRequired: config.approvalsRequired || 1,
    approvalsPreferred: config.approvalsPreferred || 2,
    defaultRepository: config.defaultRepository || "",
    doneExpireHours: config.doneExpireHours || 24,
  });
}

pollTick(); // kick immediately: does the first tidy + poll, then self-schedules

http
  .createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/status") return handleStatus(res);
    if (url === "/config") return handleConfig(res);
    if (url === "/check") return handleCheck(res);
    if (url === "/analyze-conflict") {
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      return handleAnalyze(res, q.get("id"));
    }
    if (url === "/dismiss") {
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      return handleDismiss(res, q.get("id"));
    }
    if (url === "/watch") {
      const q = new URLSearchParams(req.url.split("?")[1] || "");
      return handleWatch(res, q.get("id"), q.get("repo"));
    }
    if (url === "/clear-done") return handleClearDone(res);

    let rel = decodeURIComponent(url);
    if (rel === "/") rel = "/index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  })
  .listen(PORT, "127.0.0.1", () =>
    console.log(`watch-pr dashboard → http://localhost:${PORT}`)
  );
