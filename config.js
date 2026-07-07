// config.js — machine/user-specific settings for the watch-pr system, loaded by both
// check.js and server.js. Real values live in config.json (copy config.example.json →
// config.json and fill it in). Anything absent falls back to the DEFAULTS below, so a
// colleague only has to set the identity + path bits, not every knob.
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULTS = {
  azCliPath: "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd", // full path to az.cmd
  organization: "https://dev.azure.com/avardaonline", // az default org (for PR web URLs)
  project: "Online",                                   // az default project
  defaultRepository: "frontend-monorepo",              // used when a watched PR carries no repository
  me: "",                                              // your Azure display name — your own comments never ping you
  notifyPs1: path.join(os.homedir(), ".claude", "hooks", "notify.ps1"), // desktop/phone notifier
  claudeExe: "",                                       // full path to claude.exe for /analyze-conflict; empty disables it
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
