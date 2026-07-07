// config.js — machine/user-specific settings for the watch-pr system, loaded by both
// check.js and server.js. Real values live in config.json (copy config.example.json →
// config.json and fill it in). Anything absent falls back to the DEFAULTS below, so a
// colleague only has to set the identity + path bits, not every knob.
const fs = require("fs");
const path = require("path");
const os = require("os");

// Defaults are generic and host-neutral — nothing organization-specific ships here.
// Real values live in config.json (copy config.example.json → config.json).
const DEFAULTS = {
  provider: "azure",                                   // which PR host to talk to: "azure" | "github"
  // --- Azure DevOps ---
  azCliPath: process.platform === "win32"              // path to the az CLI
    ? "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"
    : "az",
  organization: "",                                    // az default org, e.g. https://dev.azure.com/your-org
  project: "",                                         // az default project
  // --- GitHub ---
  ghCliPath: "",                                       // path to gh CLI; empty = "gh" (or "gh.exe" on Windows) on PATH
  // --- shared ---
  defaultRepository: "",                               // used when a watched PR carries no repository
                                                       //   azure: "repo"; github: "owner/repo"
  me: "",                                              // your identity (Azure display name / GitHub login); your own
                                                       //   comments never ping you. GitHub resolves it from gh if empty.
  notifyPs1: path.join(os.homedir(), ".claude", "hooks", "notify.ps1"), // desktop/phone notifier (Windows)
  claudeExe: "",                                       // full path to claude CLI for /analyze-conflict; empty disables it
  mainRepoDir: "",                                     // git-dir fallback when a PR's worktree is gone
  port: 7878,                                          // dashboard/server port (PR_WATCH_PORT env overrides)
  doneExpireHours: 24,                                 // merged/abandoned cards auto-drop after this
  approvalsRequired: 1,                                // approvals to be mergeable (green)
  approvalsPreferred: 2,                               // soft target shown as context
  builtBy: "",                                         // footer attribution name (empty = hidden)
  builtByUrl: "",                                      // optional link for the attribution
  cadence: { ciSeconds: 300, reviewSeconds: 1500 },    // poll cadence per phase
};

let file = {};
try {
  file = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch (e) {
  console.error("watch-pr: config.json not found — using defaults. Copy config.example.json → config.json to customise.");
}

module.exports = Object.assign({}, DEFAULTS, file, {
  cadence: Object.assign({}, DEFAULTS.cadence, file.cadence),
});
