# watch-pr — a local, read-only PR dashboard + watcher

[![CI](https://github.com/micke-berg/watch-pr/actions/workflows/ci.yml/badge.svg)](https://github.com/micke-berg/watch-pr/actions/workflows/ci.yml)

A personal command center for your open pull requests. It runs entirely on your machine,
polls each watched PR, and shows one glanceable dashboard — so you can tell at a glance
whether anything needs you, without living in the PR web UI. It fires a desktop (and
optional phone) notification only when something actually needs action.

It is **read-only** against your PR host: it never comments, votes, sets auto-complete, or
merges. The only thing it writes is a small local state file.

Works with **Azure DevOps** or **GitHub**, on **Windows, macOS, or Linux** — the same core,
behind a small provider adapter and an OS-aware notifier. Zero runtime dependencies: pure
Node plus your host's own CLI (`az` / `gh`).

## What you get

- A live dashboard at `http://localhost:7878` — one card per PR (CI, approvals, unresolved
  comments, mergeable), sorted most-urgent-first, with a "needs you" counter.
- **Ambient awareness** — the browser tab shows `🔴 watch-pr (N)` and the favicon carries a red
  dot whenever something needs you, so a pinned tab tells you at a glance without switching to it.
  Both clear back to plain 👀 when nothing does.
- A resident poller that keeps it fresh and fires notifications with no editor/agent running.
- Merged/abandoned PRs auto-tidy into a "Done" strip and expire after 24h.
- **＋ Watch PR** — add any PR by id; monitored just like the rest.
- **Watch all my PRs** (optional) — flip on `watchMine` and every open PR you authored, across
  every repo, is discovered and watched automatically. A staleness cutoff keeps old
  experiments off the board. *(GitHub only for now.)*

## How it works (the short version)

- **The OS is auto-detected** at runtime (Node's `process.platform`). There is no flag to
  set and nothing to accept — the notifier picks Windows toast / macOS `osascript` /
  Linux `notify-send` by itself. `npm start` is the same command everywhere.
- **The provider is one config line** (`"provider": "azure" | "github"`). The dashboard,
  poller, and notifications never learn which host they're talking to.
- **Auth lives in the host CLI**, not here: you run `az login` or `gh auth login` once.
  watch-pr holds no tokens.
- The **only** OS-specific setup is the optional "always-on at login" step (below), because
  adding something to your login items should be a deliberate choice — not automatic.

## Quickstart

GitHub, on macOS or Linux (Windows: same, but launch with `dashboard.cmd`). Needs
[Node.js 18+](https://nodejs.org) and the [GitHub CLI](https://cli.github.com):

```sh
gh auth login                                     # once, if you haven't already
git clone https://github.com/micke-berg/watch-pr
cd watch-pr
cp config.example.json config.json                # then set "defaultRepository": "owner/repo"
npm start                                          # dashboard → http://localhost:7878
```

Add PRs with the dashboard's **＋ Watch PR** button, or set `"watchMine": true` in
`config.json` to auto-watch every open PR you authored. Azure DevOps, always-on-at-login,
phone push, and the full list of settings are in [Setup](#setup) and below.

> Using an AI coding agent? This README is written to be read top-to-bottom by one — point
> it at the repo and the steps above are all it needs (you'll still run `gh auth login`
> yourself, since that's an interactive browser flow).

## Requirements

- **Node.js 18+**
- Your host's CLI, authenticated once:
  - **Azure DevOps:** `az` with the **azure-devops** extension → `az login`
  - **GitHub:** `gh` → `gh auth login`

## Setup

1. Clone/copy this repo anywhere on your machine. There are no dependencies to install —
   it runs on Node's standard library alone.
2. Copy `config.example.json` → `config.json` and set at least `provider` and
   `defaultRepository`:

   **GitHub** (`"provider": "github"`) — repos are `owner/repo`:

   | key | what |
   | --- | --- |
   | `provider` | `"github"` |
   | `defaultRepository` | `owner/repo` used when a watched PR doesn't specify one |
   | `me` | your GitHub login; leave empty to auto-resolve via `gh api user` |
   | `ghCliPath` | optional; defaults to `gh` (`gh.exe` on Windows) on PATH |

   **Azure DevOps** (`"provider": "azure"`) — repos are just the repo name:

   | key | what |
   | --- | --- |
   | `provider` | `"azure"` |
   | `organization` / `project` | your Azure DevOps org URL + project |
   | `defaultRepository` | repo used when a watched PR doesn't specify one |
   | `me` | your reviewer display name (so your own comments never ping you) |
   | `azCliPath` | path to `az` (defaults to the standard Windows install / `az` on PATH) |

   Shared (both providers):

   | key | what |
   | --- | --- |
   | `approvalsRequired` | approvals that make a PR mergeable (the green bar). Set to your team's policy |
   | `approvalsPreferred` | soft target that fires the one-off "ready to merge" nudge — independent of the above |
   | `watchMine` | `true` to auto-watch every open PR you authored across all repos (GitHub only). Default `false` |
   | `watchMineMaxAgeDays` | with `watchMine` on, skip PRs older than this many days (`0` = no limit). Default `30` |
   | `ntfyTopic` / `ntfyServer` | optional phone push (see Notifications) |
   | `port` | dashboard port (default 7878) |
   | `claudeExe` / `mainRepoDir` | optional — enables the one-click merge-conflict explainer |
   | `builtBy` / `builtByUrl` | footer attribution |

3. Start it:
   ```sh
   npm start           # = node server.js  (all OSes)
   ```
   then open `http://localhost:7878` — or use `dashboard.cmd` (Windows) / `dashboard.sh` (macOS/Linux).

## Always-on (optional, one-time per OS)

Keep it running from every login. An empty watch list makes zero network calls, so it's idle-cheap.

- **Windows:** put a shortcut to `pr-watch-service.vbs` in your Startup folder
  (`Win+R` → `shell:startup`). Runs hidden.
- **macOS:** copy `macos/com.watchpr.plist.example` to
  `~/Library/LaunchAgents/com.watchpr.plist`, fill in your `node` path and the repo path, then
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.watchpr.plist` (to stop:
  `launchctl bootout gui/$(id -u) …`). Two things launchd gets wrong by default, because it
  does **not** load your shell's environment:
  - **It won't find `gh`/`az` on your `PATH`.** Set `ghCliPath` (or `azCliPath`) to the absolute
    path in `config.json` — e.g. `which gh` → `/usr/local/bin/gh` — or the dashboard will just
    sit empty. The plist template also sets a `PATH` covering the common locations.
  - **Point `node` at its real binary**, not a version-manager shim: `node -e "console.log(process.execPath)"`.
    Running `node` directly (rather than via a shell) is also why the agent shows up as
    `com.watchpr` in `launchctl list` instead of an anonymous `sh`. Note that an `nvm` path is
    version-pinned — if you upgrade Node, update the plist.
- **Linux:** a systemd `--user` service running `node server.js`, or just run `npm start`
  under your usual session manager. (Same `PATH` caveat as macOS — set `ghCliPath`/`azCliPath`
  absolute, or give the unit a `PATH` that includes them.)

## Notifications

- **Desktop** is automatic and needs no setup: Windows toast, macOS notification, Linux
  `notify-send`. On macOS the *first* notification may trigger the system's own
  "allow notifications?" prompt — that's macOS, granted once.
- **Phone (optional)** via [ntfy](https://ntfy.sh): set `ntfyTopic` to a long private
  string and subscribe the ntfy app to that topic. Works identically on every OS (a plain
  HTTPS POST). Notifications are **edge-triggered** — each fires once, only for
  action-needed events: CI failed, changes requested, a blocking reviewer comment, the
  approval target reached, and merged.

## Adding PRs

- Click **＋ Watch PR** on the dashboard and enter a PR id (+ optional repo).
- Or set `"watchMine": true` to auto-watch every open PR you authored across all repos —
  no manual adding. New PRs are picked up on the poll cadence; `watchMineMaxAgeDays`
  (default 30) keeps stale ones off the board. Manually added PRs are never age-filtered.
  *(GitHub only — the Azure adapter doesn't list your PRs yet.)*
- Or edit `state.json` directly.

## Files

| file | role |
| --- | --- |
| `index.html` | the dashboard (pure presentation; reads `state.json` + the endpoints) |
| `check.js` | provider-agnostic poll + decode core + the notify/tidy/add-PR loop |
| `providers/azure.js`, `providers/github.js` | the host adapters (the only host-specific code) |
| `notify.js` / `notify.ps1` | cross-platform notifier (OS-detected) + the Windows toast helper |
| `server.js` | static server + resident poller + endpoints |
| `config.js` / `config.json` | settings (copy from `config.example.json`) |
| `state.json` | the watch list + per-PR snapshot the dashboard renders |
| `pr-watch-service.vbs` / `dashboard.cmd` / `dashboard.sh` / `macos/…plist` | launchers |

The dashboard is deliberately a single self-contained `index.html` — inline CSS/JS, no
build step and no front-end dependencies — so it stays zero-install and auditable in one
file. That constraint is a feature, not a shortcut.

Endpoints (all local): `/status`, `/config`, `POST /check`, `POST /watch?id=&repo=`,
`POST /dismiss?id=&repo=`, `POST /clear-done`, `POST /analyze-conflict?id=&repo=`.

## The provider seam

Everything above a small **neutral contract** is host-agnostic. An adapter only implements:

```text
provider.me                       // your identity (own comments never ping you)
provider.prUrl(repo, id)          // web URL for a PR
provider.decodePr(id, repo)       // -> the neutral decoded shape (status, ci, approvals, threads, …)
provider.listMyOpenPrs?()         // optional: [{ id, repo, createdAt }] — powers watchMine
```

`decodePr` returns a fixed shape (prStatus, mergeable, isDraft, ci, approvals,
changesRequested, openComments, threads, ready, …). The core turns that into the card the
dashboard renders and the edge-triggered notifications — and never learns which host it
came from. Adding another host (GitLab, Bitbucket, …) is a new file under `providers/`,
nothing else.

## Safety

- **Read-only against your PR host** — it only ever reads. It never writes to, votes on, or
  merges a PR. The `✕` / "Clear all" buttons only prune your local list.
- **Local only** — the server binds to `127.0.0.1`. It also rejects requests whose `Host`
  isn't a localhost name (blocks DNS-rebinding) and cross-origin requests to its
  state-changing endpoints (blocks a random web page from driving it via CSRF).
- **No secrets stored** — authentication is delegated to `az` / `gh`; watch-pr holds no
  tokens. `config.json` and `state.json` are gitignored.
- **Optional phone push leaves your machine** — if you set `ntfyTopic`, PR titles/ids are
  POSTed to your ntfy server (default `ntfy.sh`). Leave it empty to keep everything local,
  or self-host ntfy via `ntfyServer`.
- **The conflict explainer is opt-in** — `/analyze-conflict` is disabled unless you set
  `claudeExe`, and when enabled it runs a headless assistant scoped to read-only git.

## Tests

```sh
npm test        # = node --test  (Node's built-in runner, no dependencies)
```

Covers the CI-status derivation, the edge-triggered notification logic, the input
validation, and the server's security guards. CI runs the suite on Windows, macOS, and
Linux across Node 18 / 20 / 22.

## Credits

Built by [Micke Berg](https://mickeberg.com).

## License

MIT.
