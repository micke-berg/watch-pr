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

![The watch-pr dashboard: a "needs you" counter over one card per PR, each showing CI, approvals, comments, and mergeability, sorted most-urgent-first (sample data shown).](docs/dashboard.png)

## What you get

- A live dashboard at `http://localhost:7878` — one card per PR (CI, approvals, unresolved
  comments, mergeable), sorted most-urgent-first, with a "needs you" counter.
- **Ambient awareness** — the favicon carries a red dot whenever something needs you (and the tab
  title shows the count, `watch-pr (N)`), so a pinned tab tells you at a glance without switching to
  it. The favicon clears back to plain 👀 when nothing does.
- **Light and dark theme** — follows your OS by default, with a ☀/☾ toggle in the header that
  remembers your choice (per browser). Dark is the original look, unchanged; light is a full
  re-theme, not a washed-out dark. The favicon dot and the status tones stay legible in both.
- A resident poller that keeps it fresh and fires notifications with no editor/agent running.
- Merged/abandoned PRs auto-tidy into a "Done" strip and expire after 24h.
- **＋ Watch PR** — add any PR by id; monitored just like the rest.
- **Watch all my PRs** (optional) — flip on `watchMine` and every open PR you authored is
  discovered and watched automatically. A staleness cutoff keeps old experiments off the board.
  *(GitHub spans every repo you can see; Azure covers your configured project.)*
- **Watch PRs awaiting my review** (optional) — flip on `watchReviewRequests` and every open PR
  where your review was requested shows up as a **review requested** card, and clears itself the
  moment you review it. So the other half of "what needs me" is on the board too, not just your
  own PRs. *(Works on both providers.)*

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
   | `watchMine` | `true` to auto-watch every open PR you authored (GitHub: all repos; Azure: your project). Default `false` |
   | `watchMineMaxAgeDays` | with `watchMine` on, skip PRs older than this many days (`0` = no limit). Default `30` |
   | `watchReviewRequests` | `true` to auto-watch every open PR awaiting your review; each card clears once you review it. Default `false` |
   | `ntfyTopic` / `ntfyServer` | optional phone push (see Notifications) |
   | `port` | dashboard port (default 7878) |
   | `claudeExe` / `mainRepoDir` | optional — enables the one-click merge-conflict explainer |
   | `builtBy` / `builtByUrl` | footer attribution |

3. Start it:
   ```sh
   npm start           # = node server.js  (all OSes)
   ```
   then open `http://localhost:7878` — or use `dashboard.cmd` (Windows) / `dashboard.sh` (macOS/Linux).

   **Pin it as an app** (optional):
   - **Windows / Linux (Edge or Chrome):** click the **Install** icon in the address bar. You get
     a real app window (no browser chrome), pinnable to the taskbar, and a **red count badge** on
     the icon when PRs need you — it clears when nothing does.
   - **macOS (Safari):** **File → Add to Dock** gives a one-click launcher with its own icon.
     (Safari's Dock icon is static — no live badge there; the browser-tab favicon is the live
     indicator on macOS.)

   Either way, the always-on **server keeps running in the background** — the app is just a
   nicer front door to it, so notifications still fire whether or not the window is open.

## Always-on (optional, one-time per OS)

Keep it running from every login. An empty watch list makes zero network calls, so it's idle-cheap.

- **Windows:** put a shortcut to `pr-watch-service.vbs` in your Startup folder
  (`Win+R` → `shell:startup`). Runs hidden. It launches `node` from your `PATH`; if your
  login `PATH` doesn't include node, set the absolute path at the top of the `.vbs`.
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
- **Linux:** copy `linux/watch-pr.service.example` to `~/.config/systemd/user/watch-pr.service`,
  fill in your `node` + repo paths, then `systemctl --user enable --now watch-pr.service`. (Same
  `PATH` caveat as macOS — set `ghCliPath`/`azCliPath` absolute, or give the unit a `PATH`.)

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
  *(GitHub spans every repo you can see; Azure covers your configured project.)*
- Or set `"watchReviewRequests": true` to auto-watch every open PR waiting on your review.
  Each one shows a **review requested** card and clears itself once you've reviewed it.
  *(Works on both providers.)*
- Or edit `state.json` directly.

## Fits an agentic workflow

The board is driven by a tiny local endpoint, so any automation that knows a PR just opened
can drop it there instantly — a git hook, a CI step, or your coding agent's post-PR hook:

```sh
curl -X POST "http://localhost:7878/watch?id=$PR_ID&repo=$OWNER_REPO"
```

An agent opens the PR, the hook adds it, and the resident poller keeps it fresh (≈5 min while
CI runs, ≈25 min in review) — so you never break focus to go check. (`watchMine` /
`watchReviewRequests` already auto-discover on a cadence; the hook just makes a brand-new PR
show up the instant it's created.)

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
| `pr-watch-service.vbs` / `dashboard.cmd` / `dashboard.sh` / `macos/…plist` / `linux/…service` | launchers |

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
provider.listReviewRequestedPrs?()// optional: [{ id, repo, createdAt }] — powers watchReviewRequests
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
