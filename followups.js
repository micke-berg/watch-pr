// followups.js — what to do next when one of YOUR PRs needs you.
//
//   CI went red    -> a report with the failing step and the relevant log lines
//   PR completed   -> a report with the local cleanup on offer (worktree + local branch)
//
// Both end in one desktop notification that opens the report when clicked. Nothing here
// fixes code or deletes anything: the report lists the commands, and they run only when you
// ask for them in a session. Remote branches are never part of the cleanup.
//
// Dry run against a real PR (prints the notification and the report, writes and notifies nothing):
//   node followups.js --dry-run ci <prId> [repo]
//   node followups.js --dry-run merged <prId> [repo]
// Add --toast to also show the notification for real (still writes no report).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const config = require("./config.js");

const REPORTS = path.join(__dirname, "reports");

function writeReport(name, text) {
  fs.mkdirSync(REPORTS, { recursive: true });
  const file = path.join(REPORTS, name);
  fs.writeFileSync(file, text);
  return file;
}

// ── CI went red ─────────────────────────────────────────────────────────────────

function ciFailedNote(pr, details) {
  const id = pr.id;
  const title = (pr.display && pr.display.title) || pr.title || "";
  const firstError = details.issues[0] || (details.logLines || []).find((l) => l && l !== "...") || "";
  const report = [
    `# CI failed: PR ${id}`,
    "",
    `- PR: ${title}`,
    `- Link: ${pr.display ? pr.display.url : ""}`,
    `- Pipeline: ${details.pipeline || "(unknown)"} (build ${details.buildId})`,
    `- Failing step: ${details.step}`,
    `- Build log: ${details.buildUrl}`,
    "",
    "## What the pipeline reported",
    "",
    ...(details.issues.length ? details.issues.map((i) => `- ${i}`) : ["- (no error messages attached to the step)"]),
    "",
    "## Relevant log lines",
    "",
    "```",
    ...(details.logLines.length ? details.logLines : ["(log not available)"]),
    "```",
    "",
    "## Next step",
    "",
    `Say "fix PR ${id}" in a Claude session. It reads this report, proposes a fix and changes nothing until you agree.`,
    "",
  ].join("\n");
  return {
    reportName: `pr-${id}-ci-${details.buildId}.md`,
    report,
    title: `CI failed: PR ${id}`,
    message: `${details.step} failed${details.pipeline ? ` (${details.pipeline})` : ""}. ${firstError.slice(0, 140)}\nSay "fix PR ${id}" in a Claude session.`,
  };
}

// ── PR completed: what is left locally ──────────────────────────────────────────

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function tryGit(cwd, args) {
  try { return git(cwd, args); } catch (e) { return null; }
}
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Main clones under config.localRepoRoots whose origin is this PR's repository.
function mainReposFor(repo) {
  const out = [];
  for (const root of config.localRepoRoots || []) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      // a worktree has a .git FILE; only main clones have a .git directory
      try { if (!fs.statSync(path.join(dir, ".git")).isDirectory()) continue; } catch (err) { continue; }
      const url = tryGit(dir, ["remote", "get-url", "origin"]) || "";
      const name = url.replace(/\.git$/, "").split(/[/:]/).pop();
      if (name && name.toLowerCase() === String(repo).toLowerCase()) out.push(dir);
    }
  }
  return out;
}

function worktreesOf(mainDir) {
  const raw = tryGit(mainDir, ["worktree", "list", "--porcelain"]) || "";
  return raw.split(/\r?\n\r?\n/).map((block) => {
    const wt = {};
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) wt.path = path.normalize(line.slice(9));
      if (line.startsWith("branch ")) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    return wt;
  }).filter((w) => w.path);
}

// Node processes started from inside the worktree (dev servers left running). Windows only;
// elsewhere this returns nothing rather than guessing.
function serversIn(dir) {
  if (process.platform !== "win32") return [];
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const list = [].concat(JSON.parse(raw || "[]"));
    const needle = path.resolve(dir).toLowerCase();
    return list.filter((p) => String(p.CommandLine || "").toLowerCase().replace(/\//g, "\\").includes(needle))
      .map((p) => ({ pid: p.ProcessId, cmd: String(p.CommandLine).slice(0, 160) }));
  } catch (e) { return []; }
}

function findLocal(pr) {
  const branch = pr.branch || (pr.display && pr.display.branch) || "";
  const found = [];
  if (!branch) return found;
  for (const mainDir of mainReposFor(pr.repository)) {
    const hasBranch = tryGit(mainDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
    const wt = worktreesOf(mainDir).find((w) => w.branch === branch);
    if (!hasBranch && !wt) continue;
    const entry = { mainDir, branch, target: pr.targetBranch || "", hasBranch, worktree: null, checkedOutInMain: false, dirty: 0, servers: [] };
    if (wt && samePath(wt.path, mainDir)) entry.checkedOutInMain = true;
    else if (wt) {
      entry.worktree = wt.path;
      const status = tryGit(wt.path, ["status", "--porcelain"]);
      entry.dirty = status === null ? -1 : status.split(/\r?\n/).filter(Boolean).length;
      entry.servers = serversIn(wt.path);
    }
    found.push(entry);
  }
  return found;
}

const bashPath = (p) => p.replace(/\\/g, "/");

// The same steps /cleanup-worktrees takes, for exactly this PR's worktree and branch.
function cleanupCommands(e) {
  const cmds = [];
  e.servers.forEach((s) => cmds.push(`powershell "Stop-Process -Id ${s.pid} -Force"   # dev server in the worktree`));
  if (e.worktree) {
    cmds.push(`git -C "${bashPath(e.mainDir)}" worktree remove "${bashPath(e.worktree)}"`);
    cmds.push(`# if that fails on Windows (Filename too long / locked node_modules):`);
    cmds.push(`#   cmd //c "rmdir /s /q ${e.worktree}"`);
    cmds.push(`#   git -C "${bashPath(e.mainDir)}" worktree prune`);
  }
  if (e.checkedOutInMain) cmds.push(`git -C "${bashPath(e.mainDir)}" switch ${e.target || "<base branch>"}   # the branch is checked out in the main clone`);
  if (e.hasBranch) {
    cmds.push(`git -C "${bashPath(e.mainDir)}" branch -d ${e.branch}`);
    cmds.push(`# if git says "not fully merged", the PR was squash-merged; the work is in the target branch, so -D is safe:`);
    cmds.push(`#   git -C "${bashPath(e.mainDir)}" branch -D ${e.branch}`);
  }
  return cmds;
}

// Worktree paths come from Windows git output; path.basename on macOS/Linux
// treats a backslash as part of the name, while the win32 variant splits on both.
function folderName(dir) {
  return path.win32.basename(dir);
}

function mergedNote(pr, local) {
  const id = pr.id;
  const title = (pr.display && pr.display.title) || pr.title || "";
  if (!local.length) {
    return { reportName: null, report: null, title: `PR ${id} merged`, message: `${title}\nNo local worktree or branch left to clean up.` };
  }
  const lines = [`# PR ${id} merged: local cleanup on offer`, "", `- PR: ${title}`, `- Link: ${pr.display ? pr.display.url : ""}`, ""];
  for (const e of local) {
    lines.push(`## ${folderName(e.mainDir)}`, "");
    lines.push(`- Local branch: ${e.hasBranch ? e.branch : "(already gone)"}`);
    lines.push(`- Worktree: ${e.worktree || (e.checkedOutInMain ? "none, the branch is checked out in the main clone" : "none")}`);
    if (e.dirty > 0) lines.push(`- WARNING: the worktree has ${e.dirty} uncommitted change(s). Removing it deletes them. Look first.`);
    if (e.dirty < 0) lines.push(`- WARNING: could not read the worktree's status. Look before removing it.`);
    if (e.servers.length) lines.push(`- Dev servers still running from it: ${e.servers.map((s) => s.pid).join(", ")}`);
    lines.push("", "Commands (Git Bash), run only after you say yes:", "", "```bash", ...cleanupCommands(e), "```", "");
  }
  lines.push("Remote branches are not touched. Nothing above has run.", "",
    `Say "clean up PR ${id}" in a Claude session to run it after your yes.`, "");
  const what = local.map((e) => [e.worktree ? `worktree ${folderName(e.worktree)}` : "", e.hasBranch ? `branch ${e.branch}` : ""].filter(Boolean).join(" + ")).join("; ");
  const warn = local.some((e) => e.dirty !== 0) ? " (has uncommitted changes)" : "";
  return {
    reportName: `pr-${id}-merged.md`,
    report: lines.join("\n"),
    title: `PR ${id} merged`,
    message: `Clean up ${what}${warn}? Say "clean up PR ${id}" in a Claude session. Nothing runs without your yes.`,
  };
}

// ── Entry points used by check.js ───────────────────────────────────────────────

// Returns {title, message, open} for the notifier. Never throws: on any failure it falls back
// to a short notification, because a missing detail must not swallow the alert itself.
async function ciFailedFollowUp(provider, pr, decoded) {
  try {
    const details = await provider.ciFailureDetails(pr.id, pr.repository, decoded);
    const note = ciFailedNote(pr, details);
    return { title: note.title, message: note.message, open: writeReport(note.reportName, note.report), buildId: details.buildId };
  } catch (e) {
    const t = (pr.display && pr.display.title) || "";
    return { title: "CI failed", message: `#${pr.id} ${t}: build rejected\nSay "fix PR ${pr.id}" in a Claude session.` };
  }
}

function mergedFollowUp(pr) {
  try {
    const note = mergedNote(pr, findLocal(pr));
    return { title: note.title, message: note.message, open: note.reportName ? writeReport(note.reportName, note.report) : undefined };
  } catch (e) {
    return { title: "PR merged", message: `#${pr.id} ${(pr.display && pr.display.title) || ""}: merged` };
  }
}

module.exports = { ciFailedFollowUp, mergedFollowUp, ciFailedNote, mergedNote, cleanupCommands, findLocal };

// ── Dry-run CLI ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const [kind, id, repoArg] = args.filter((a) => !a.startsWith("--"));
  if (!args.includes("--dry-run") || !["ci", "merged"].includes(kind) || !/^\d+$/.test(id || "")) {
    console.error("usage: node followups.js --dry-run ci|merged <prId> [repo] [--toast]");
    process.exit(2);
  }
  const PROVIDERS = { azure: "./providers/azure.js", github: "./providers/github.js" };
  const provider = require(PROVIDERS[config.provider] || PROVIDERS.azure);
  (async () => {
    const repo = repoArg || config.defaultRepository;
    const d = await provider.decodePr(Number(id), repo);
    const pr = { id: Number(id), repository: repo, branch: d.branch, targetBranch: d.target, title: d.title, display: { title: d.title, url: provider.prUrl(repo, id) } };
    console.log(`PR ${id} (${repo}): status=${d.prStatus} ci=${d.ci} branch=${d.branch}`);
    let note;
    if (kind === "ci") {
      if (typeof provider.ciFailureDetails !== "function") throw new Error("this provider cannot read build logs");
      note = ciFailedNote(pr, await provider.ciFailureDetails(pr.id, repo, d));
    } else {
      note = mergedNote(pr, findLocal(pr));
    }
    console.log("\n--- notification ---\n" + note.title + "\n" + note.message);
    console.log("\n--- report (" + (note.reportName || "none") + ", not written in dry run) ---\n" + (note.report || "(no report: nothing local)"));
    if (args.includes("--toast")) require("./notify.js").notify("[dry run] " + note.title, note.message);
  })().catch((e) => { console.error("dry run failed: " + e.message); process.exit(1); });
}
