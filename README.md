# watch-pr — a local, read-only PR dashboard + watcher

A personal command center for your open pull requests. It runs entirely on your machine,
polls each watched PR, and shows one glanceable dashboard — so you can tell at a glance
whether anything needs you, without living in the PR web UI. It fires a desktop (and
optional phone) notification only when something actually needs action.

It is **read-only** against your PR host: it never comments, votes, sets auto-complete, or
merges. The only thing it writes is a small local state file.

## What you get

- A live dashboard at `http://localhost:7878` — one card per PR (CI, approvals, unresolved
  comments, mergeable), sorted most-urgent-first, with a "needs you" counter.
- A resident poller that keeps it fresh and fires notifications with no editor/agent running.
- Merged/abandoned PRs auto-tidy into a "Done" strip and expire after 24h.
- **＋ Watch PR** — add any PR by id; monitored just like the rest.

## Requirements

- **Node.js 18+**
- **Azure CLI** (`az`) with the **azure-devops** extension, logged in (`az login`), and
  org/project defaults set:
  ```
  az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>
  ```
- **Windows** (current build — see Portability). Notifications go through a PowerShell script.

## Setup

1. Copy the `pr-watch/` folder anywhere on your machine.
2. Copy `config.example.json` → `config.json` and fill it in:

   | key | what |
   |-----|------|
   | `azCliPath` | full path to `az.cmd` |
   | `organization` / `project` | your Azure DevOps org URL + project |
   | `defaultRepository` | repo used when a watched PR doesn't specify one |
   | `me` | your reviewer display name (so your own comments never ping you) |
   | `notifyPs1` | path to a desktop/phone notify script; leave default or empty to disable |
   | `claudeExe` | optional — enables the one-click merge-conflict explainer; empty disables it |
   | `mainRepoDir` | a local clone, used as a fallback git dir for the analyzer |
   | `builtBy` / `builtByUrl` | footer attribution |
   | `approvalsRequired` / `approvalsPreferred` | your team's approval bar |

3. Start it:
   ```
   node server.js
   ```
   then open `http://localhost:7878` (or double-click `dashboard.cmd`).

## Always-on (optional)

To keep it running from every login, put a shortcut to `pr-watch-service.vbs` in your
Startup folder (`Win+R` → `shell:startup`). It runs hidden and is idle-cheap — an empty
watch list makes zero network calls.

## Adding PRs

- Click **＋ Watch PR** on the dashboard and enter a PR id (+ optional repo).
- Or edit `state.json` directly.
- If you use the companion Claude Code skills, new PRs auto-register when created.

## Files

| file | role |
|------|------|
| `index.html` | the dashboard (pure presentation; reads `state.json` + the endpoints) |
| `check.js` | poll + decode core (talks to Azure, decodes votes / threads / CI) |
| `server.js` | static server + resident poller + endpoints |
| `config.js` / `config.json` | settings (copy from `config.example.json`) |
| `state.json` | the watch list + per-PR snapshot the dashboard renders |
| `pr-watch-service.vbs` / `dashboard.cmd` | launchers |

Endpoints (all local): `/status`, `/config`, `POST /check`, `POST /watch?id=&repo=`,
`POST /dismiss?id=`, `POST /clear-done`, `POST /analyze-conflict?id=`.

## Safety

Read-only against your PR host — it only ever reads (`az repos pr show`, policy list,
pullRequestThreads GET). It never writes to, votes on, or merges a PR. The `✕` / "Clear all"
buttons only prune your local list.

## Portability (roadmap)

The dashboard, resident poller, state contract, and the tidy / add-PR logic are host- and
OS-agnostic. Only two pieces are specific:

- the **provider adapter** — `check.js`, currently Azure DevOps via the `az` CLI;
- the **OS shim** — notifications + launcher, currently Windows (PowerShell + a Startup `.vbs`).

A **GitHub** adapter (the `gh` CLI — arguably simpler, since GitHub exposes `reviewDecision`
and `statusCheckRollup` directly) and a **macOS** shim (a `launchd` LaunchAgent + `osascript`
notifications, with the same cross-platform ntfy phone push) are a clean extraction behind
that same neutral state shape — not a rewrite.
