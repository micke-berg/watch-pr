// ─────────────────────────────────────────────────────────────────────────────
// watch-pr dashboard. Visual design imported from Claude Design (PR Watch.dc.html),
// ported to vanilla JS and wired to the live feed: state.json (per-PR `display`
// blocks written by check.js) + the server's /status, /check, /dismiss and
// /clear-done endpoints. Renders sample data when no server is reachable,
// so this same file doubles as a self-contained preview.
//
// Colour lives entirely in CSS custom properties (see app.css): :root is the dark
// theme, [data-theme="light"] the light theme. Flat colours are var(--x); the status
// tones are raw "L C H" triplets consumed by col()/cola() below so they can carry
// per-call alpha. The pre-paint theme bootstrap is inline in index.html's <head> to
// avoid a flash; theme selection + persistence is at the bottom of this script.
// ─────────────────────────────────────────────────────────────────────────────

// ── design tokens ────────────────────────────────────────────────────────────
const MONO  = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

// status tones -> colour. col()/cola() resolve against the active theme's raw "L C H"
// custom property, so the same call renders correctly in both themes.
const FILL = new Set(["crit", "warn", "go"]); // tones drawn as a solid chip vs an outline
const col  = (t) => `oklch(var(--${t}))`;
const cola = (t, a) => `oklch(var(--${t}) / ${a})`;
// whether the light theme is active — drives the theme-dependent shadows/alpha the design
// only applies on a light ground (elevation shadows that would be wrong on dark).
function isLight() { return currentTheme() === "light"; }

// design status model — rank drives sort + "needs you"; tone drives colour.
const statusMeta = {
  ci_failed:         { rank: 1,  label: "CI FAILED",         tone: "crit"    },
  conflicts:         { rank: 2,  label: "MERGE CONFLICTS",   tone: "crit"    },
  review_requested:  { rank: 3,  label: "REVIEW REQUESTED",  tone: "warn"    }, // a PR waiting on YOUR review
  changes_requested: { rank: 4,  label: "CHANGES REQUESTED", tone: "warn"    },
  ready:             { rank: 5,  label: "READY TO MERGE",    tone: "go"      },
  comments:          { rank: 6,  label: "OPEN COMMENTS",     tone: "warn"    },
  waiting_ci:        { rank: 7,  label: "WAITING ON CI",     tone: "active"  },
  needs_approval:    { rank: 8,  label: "NEEDS APPROVAL",    tone: "neutral" },
  in_review:         { rank: 9,  label: "IN REVIEW",         tone: "neutral" },
  draft:             { rank: 10, label: "DRAFT",             tone: "dim"     },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function titleFromBranch(branch) {
  // Strip a leading JIRA-style ticket key (e.g. "ABC-123-"), host- and team-neutral —
  // matches the same derivation in check.js. No hardcoded project prefix.
  return (branch || "").replace(/^[A-Za-z]+-\d+[-_]/, "").replace(/[-_]+/g, " ").trim() || branch || "(no title)";
}
function agoSec(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}
function agoShort(iso) {
  const s = agoSec(iso);
  if (s == null) return "—";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function mmss(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
// our display.ci -> design ci word
function mapCi(ci) {
  if (ci === "queued") return "running";
  if (ci === "passed" || ci === "failed" || ci === "running") return ci;
  return "none";
}
// decide the single most important status (design keys), mirroring check.js priority
function statusOf(d) {
  if (d.ci === "failed") return "ci_failed";
  if (d.mergeable === false) return "conflicts";
  if (d.changesRequested) return "changes_requested";
  if (d.ready) return "ready";
  if ((d.openComments || 0) > 0) return "comments";
  if (d.isDraft) return "draft";
  if (d.ci === "queued" || d.ci === "running") return "waiting_ci";
  if ((d.approvals || 0) < 1) return "needs_approval";
  return "in_review";
}

// ── normalise a state.json entry -> the view models the design expects ───────
function activeVM(e) {
  const d = e.display || {};
  return {
    id: e.id,
    title: d.title || titleFromBranch(e.branch),
    base: d.target || e.targetBranch || e.target || "—",
    opened: d.createdAt ? agoShort(d.createdAt) + " ago" : "—",
    ci: mapCi(d.ci),
    approvals: d.approvals || 0,
    approvalsRequired: 2,
    approvalNames: d.approvalNames || [],
    openComments: d.openComments || 0,
    mergeable: d.mergeable === false ? "conflicts" : "clean",
    isDraft: !!d.isDraft,
    // A reviewer-role card is on the board because your review was requested, so that is its
    // status until you review it (at which point discovery drops it), regardless of the PR's
    // own CI/approval state — those are the author's to act on, not yours.
    status: e.role === "reviewer" ? "review_requested" : statusOf(d),
    url: d.url || "#",
    prStatus: d.prStatus || "active",
    repo: e.repository || "",
    role: e.role || "author",
  };
}
function doneVM(e) {
  const d = e.display || {};
  const merged = (d.prStatus || e.prStatus) === "completed";
  return {
    id: e.id,
    title: d.title || titleFromBranch(e.branch),
    outcome: merged ? "merged" : "abandoned",
    when: (merged ? "merged " : "abandoned ") + agoShort(e.doneAt || d.updatedAt) + " ago",
    url: d.url || "#",
    repo: e.repository || "",
  };
}
const isDoneEntry = (e) => {
  const ps = (e.display && e.display.prStatus) || e.prStatus;
  return ps === "completed" || ps === "abandoned";
};

// ── sample data (fallback when no server / opened as a bare file) ─────────────
const SAMPLE_PRS = [
  { id:4821, title:"Fix token refresh race in the auth interceptor", base:"main", opened:"3h ago", ci:"failed", approvals:1, approvalsRequired:2, approvalNames:["A. Ruiz"], openComments:2, mergeable:"clean", isDraft:false, status:"ci_failed", url:"#", prStatus:"active" },
  { id:4790, title:"Migrate billing service to gRPC transport", base:"release/24.3", opened:"1d ago", ci:"passed", approvals:2, approvalsRequired:2, approvalNames:["A. Ruiz","K. Osei"], openComments:1, mergeable:"conflicts", isDraft:false, status:"conflicts", url:"#", prStatus:"active" },
  { id:4856, title:"Tighten rate limits on the public API gateway", base:"main", opened:"1h ago", ci:"passed", approvals:0, approvalsRequired:2, approvalNames:[], openComments:0, mergeable:"clean", isDraft:false, status:"review_requested", url:"#", prStatus:"active", role:"reviewer" },
  { id:4835, title:"Redesign empty states across the dashboard", base:"main", opened:"5h ago", ci:"passed", approvals:1, approvalsRequired:2, approvalNames:["M. Devi"], openComments:4, mergeable:"clean", isDraft:false, status:"changes_requested", url:"#", prStatus:"active" },
  { id:4802, title:"Add a retry budget to the search gateway", base:"main", opened:"2d ago", ci:"passed", approvals:2, approvalsRequired:2, approvalNames:["A. Ruiz","J. Park"], openComments:0, mergeable:"clean", isDraft:false, status:"ready", url:"#", prStatus:"active" },
  { id:4840, title:"Cache warmup for feature-flag evaluation", base:"main", opened:"6h ago", ci:"passed", approvals:1, approvalsRequired:2, approvalNames:["K. Osei"], openComments:3, mergeable:"clean", isDraft:false, status:"comments", url:"#", prStatus:"active" },
  { id:4849, title:"Bump OpenTelemetry SDK to 1.32", base:"main", opened:"42m ago", ci:"running", approvals:0, approvalsRequired:2, approvalNames:[], openComments:0, mergeable:"clean", isDraft:false, status:"waiting_ci", url:"#", prStatus:"active" },
  { id:4812, title:"Extract notification templates into the CMS", base:"main", opened:"1d ago", ci:"passed", approvals:0, approvalsRequired:2, approvalNames:[], openComments:0, mergeable:"clean", isDraft:false, status:"needs_approval", url:"#", prStatus:"active" },
  { id:4860, title:"Rework the onboarding checklist flow", base:"main", opened:"15m ago", ci:"running", approvals:0, approvalsRequired:2, approvalNames:[], openComments:0, mergeable:"clean", isDraft:true, status:"draft", url:"#", prStatus:"active" },
];
const SAMPLE_DONE = [
  { id:4777, title:"Enforce idempotency keys on the payments API", outcome:"merged", when:"merged 2h ago", url:"#" },
  { id:4761, title:"Upgrade CI runners to the arm64 fleet", outcome:"merged", when:"merged 1d ago", url:"#" },
  { id:4753, title:"Spike: edge caching for static assets", outcome:"abandoned", when:"abandoned 1d ago", url:"#" },
];

// ── runtime state ────────────────────────────────────────────────────────────
let latest = null;         // parsed state.json, or "error"
let everLoaded = false;    // have we ever successfully read real state?
let pollAlive = null;      // /status payload, or null
let checking = false;      // /check request in flight
// presentation config (overridden by the server's /config; defaults keep the standalone
// file looking right). Attribution + approval thresholds live here so nothing is hardcoded.
let CFG = { builtBy: "Micke Berg", builtByUrl: "https://mickeberg.com", approvalsRequired: 1, approvalsPreferred: 2, defaultRepository: "" };

// ── card rendering ───────────────────────────────────────────────────────────
function cardHtml(pr) {
  const meta = statusMeta[pr.status];
  const tone = meta.tone;
  const fill = FILL.has(tone);
  const c = col(tone);
  const light = isLight();

  const chipCommon = `flex-shrink:0;font-family:${MONO};font-size:11.5px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:999px;padding:8px 14px;white-space:nowrap;`;
  const chipStyle = fill
    ? chipCommon + `background:${c};color:var(--chip-text);`
        + (tone === "crit"
            ? `box-shadow:0 0 22px ${cola("crit", light ? 0.35 : 0.5)};`
            : (light ? `box-shadow:0 6px 16px -6px ${cola(tone, 0.5)};` : ""))
    : chipCommon + `background:${cola(tone, light ? 0.10 : 0.12)};color:${c};border:1px solid ${cola(tone, 0.4)};`;

  const accentStyle = `width:5px;align-self:stretch;border-radius:6px;background:${c};flex-shrink:0;`
    + (tone === "crit" ? `box-shadow:0 0 20px ${cola("crit", 0.6)};` : (fill ? `box-shadow:0 0 12px ${cola(tone, light ? 0.45 : 0.35)};` : ""));

  const cardStyle = `display:flex;gap:18px;padding:18px 20px;border-radius:16px;box-sizing:border-box;background:var(--panel);border:1px solid ${fill ? cola(tone, light ? 0.28 : 0.34) : "var(--border)"};box-shadow:var(--card-shadow);opacity:${pr.isDraft ? 0.72 : 1};`;

  const valBase = `font-family:${MONO};font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;`;

  const ciColor = pr.ci === "failed" ? col("crit") : pr.ci === "running" ? col("active") : pr.ci === "none" ? "var(--t-mute)" : "var(--green)";
  const ciGlyph = pr.ci === "failed" ? "✕" : pr.ci === "running" ? "↻" : pr.ci === "none" ? "–" : "✓";
  const ciSpin = pr.ci === "running" ? "display:inline-block;animation:spin 1.1s linear infinite;" : "display:inline-block;";
  const ciWord = pr.ci === "none" ? "—" : pr.ci;
  const ciSub = pr.ci === "passed" ? "all checks green" : pr.ci === "running" ? "in progress" : pr.ci === "none" ? "no build policy" : "checks failing";

  // Approval bar is configurable (approvalsRequired / approvalsPreferred). Show the absolute
  // count + a ✓ once required is met; the sub-line teaches the bar when there are none yet.
  const req = CFG.approvalsRequired, pref = CFG.approvalsPreferred;
  const apprMet = pr.approvals >= req;
  const apprColor = apprMet ? "var(--green)" : "var(--t-mute)";
  const apprValueTxt = pr.approvals + (apprMet ? " ✓" : "");
  const apprNames = pr.approvals === 0
    ? (req + " required · " + pref + " preferred")
    : (pr.approvalNames.length ? esc(pr.approvalNames.join(", ")) : "approved");

  const comColor = pr.openComments > 0 ? col("warn") : "var(--faint)";
  const comSub = pr.openComments > 0 ? "unresolved" : "none open";

  const mergeColor = pr.mergeable === "conflicts" ? col("crit") : "var(--t-mute)";
  const mergeGlyph = pr.mergeable === "conflicts" ? "✕" : "✓";
  const mergeSub = pr.mergeable === "conflicts" ? "rebase needed" : "no conflicts";

  return `
  <article style="${cardStyle}">
    <div style="${accentStyle}"></div>
    <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:15px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
        <div style="min-width:0; flex:1;">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
            <span style="font-family:${MONO}; font-size:12.5px; color: var(--t-mute); letter-spacing:0.05em;">#${pr.id}</span>
            ${pr.isDraft ? `<span style="font-family:${MONO}; font-size:9.5px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color: oklch(var(--draft)); border:1px solid oklch(var(--draft) / 0.4); border-radius:5px; padding:2px 7px;">Draft</span>` : ""}
          </div>
          <a class="title" href="${esc(pr.url)}" target="_blank" rel="noopener" style="display:inline-block; font-size: clamp(16px,1.5vw,19px); font-weight:600; line-height:1.3; color: var(--title); text-wrap:pretty;">${esc(pr.title)}</a>
        </div>
        <span style="${chipStyle}">${meta.label}</span>
      </div>

      <div style="display:flex; align-items:center; gap:14px; font-family:${MONO}; font-size:11px; letter-spacing:0.08em; color: var(--t-dim); text-transform:uppercase; flex-wrap:wrap;">
        <span>Base&nbsp;&nbsp;<span style="color: var(--t-mid);">${esc(pr.base)}</span></span>
        <span style="opacity:0.45;">·</span>
        <span>Opened&nbsp;&nbsp;<span style="color: var(--t-mid);">${esc(pr.opened)}</span></span>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(128px,1fr)); gap:16px; border-top:1px solid var(--divider); padding-top:15px;">
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">CI / Build</span>
          <span style="${valBase} color:${ciColor};"><span style="${ciSpin}">${ciGlyph}</span>${ciWord}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint);">${ciSub}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">Approvals</span>
          <span style="${valBase} color:${apprColor};">${apprValueTxt}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${apprNames}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">Comments</span>
          <span style="${valBase} color:${comColor};">${pr.openComments}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint);">${comSub}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:5px; min-width:0;">
          <span style="font-family:${MONO}; font-size:9px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">Mergeable</span>
          <span style="${valBase} color:${mergeColor};"><span>${mergeGlyph}</span>${pr.mergeable}</span>
          <span style="font-family:${MONO}; font-size:10.5px; color: var(--faint);">${mergeSub}</span>
        </div>
      </div>
    </div>
  </article>`;
}

// ── hero band ────────────────────────────────────────────────────────────────
function heroHtml(prs) {
  const needYou = prs.filter((pr) => statusMeta[pr.status].rank <= 6).length;
  const anyCrit = prs.some((pr) => statusMeta[pr.status].tone === "crit");
  const heroTone = needYou > 0 ? (anyCrit ? "crit" : "warn") : "go";
  const cnt = (st) => prs.filter((pr) => pr.status === st).length;
  const light = isLight();

  const segs = [];
  if (cnt("ci_failed")) segs.push(cnt("ci_failed") + " CI FAILING");
  if (cnt("conflicts")) segs.push(cnt("conflicts") + " CONFLICT" + (cnt("conflicts") > 1 ? "S" : ""));
  if (cnt("review_requested")) segs.push(cnt("review_requested") + " TO REVIEW");
  if (cnt("changes_requested")) segs.push(cnt("changes_requested") + " CHANGES REQ");
  if (cnt("ready")) segs.push(cnt("ready") + " READY");
  if (cnt("comments")) segs.push(cnt("comments") + " W/ COMMENTS");
  const breakdown = segs.join("     ·     ");

  const bandStyle = `display:flex; align-items:center; justify-content:space-between; gap:24px; flex-wrap:wrap; border-radius:20px; padding: clamp(22px,3vw,34px); background:${cola(heroTone, light ? 0.10 : 0.07)}; border:1px solid ${cola(heroTone, light ? 0.30 : 0.24)};`
    + (light ? `box-shadow:0 1px 2px oklch(0.45 0.03 262 / 0.05), 0 22px 48px -20px ${cola(heroTone, 0.35)};` : "");

  const left = needYou > 0
    ? `<span style="color:${col(heroTone)}; font-size: clamp(64px,11vw,150px); font-weight:800; line-height:0.82; letter-spacing:-0.04em;">${needYou}</span>
       <div style="display:flex; flex-direction:column; gap:9px;">
         <span style="font-family:${MONO}; font-size: clamp(16px,2vw,22px); font-weight:700; letter-spacing:0.22em; text-transform:uppercase; color: var(--title);">Need you</span>
         <span style="font-family:${MONO}; font-size:12px; letter-spacing:0.08em; color: var(--t-mute);">${breakdown}</span>
       </div>`
    : `<span style="color:${col("go")}; font-size: clamp(50px,8vw,104px); line-height:0.9;">✓</span>
       <div style="display:flex; flex-direction:column; gap:9px;">
         <span style="font-family:${MONO}; font-size: clamp(20px,3vw,30px); font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color: var(--title);">All clear</span>
         <span style="font-family:${MONO}; font-size:12px; letter-spacing:0.08em; color: var(--t-mute);">Nothing needs you right now</span>
       </div>`;

  const statReview = prs.filter((pr) => ["in_review", "needs_approval"].includes(pr.status)).length;
  const statDraft = prs.filter((pr) => pr.isDraft).length;
  const stat = (v, l) => `<div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px;"><span style="font-family:${MONO}; font-size:26px; font-weight:700; color: var(--t-strong);">${v}</span><span style="font-family:${MONO}; font-size:9.5px; letter-spacing:0.18em; text-transform:uppercase; color: var(--label);">${l}</span></div>`;

  return { needYou, html: `<section style="${bandStyle}">
      <div style="display:flex; align-items:center; gap:24px; min-width:0;">${left}</div>
      <div style="display:flex; gap:30px;">${stat(prs.length, "Open")}${stat(statReview, "Reviewing")}${stat(statDraft, "Drafts")}</div>
    </section>` };
}

// ── done strip ───────────────────────────────────────────────────────────────
function doneSectionHtml(done) {
  const rowHtml = (d) => {
    const merged = d.outcome === "merged";
    const oStyle = merged
      ? `color: oklch(var(--purple)); border:1px solid oklch(var(--purple) / 0.4); background: oklch(var(--purple) / 0.12);`
      : `color:var(--t-mute); border:1px solid ${cola("dim", 0.4)}; background:${cola("dim", 0.12)};`;
    return `<div style="display:flex; align-items:center; gap:14px; padding:12px 16px; border-radius:12px; background: var(--panel-2); border:1px solid var(--border-soft);">
      <span style="flex-shrink:0; font-family:${MONO}; font-size:9.5px; font-weight:700; letter-spacing:0.14em; border-radius:6px; padding:4px 9px; ${oStyle}">${merged ? "MERGED" : "ABANDONED"}</span>
      <span style="flex-shrink:0; font-family:${MONO}; font-size:12px; color: var(--t-dim);">#${d.id}</span>
      <a href="${esc(d.url)}" target="_blank" rel="noopener" style="flex:1; min-width:0; font-size:14px; color: var(--t-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(d.title)}</a>
      <span style="flex-shrink:0; font-family:${MONO}; font-size:10.5px; color: var(--faint); letter-spacing:0.06em;">${esc(d.when)}</span>
      <button onclick="dismiss('${d.id}', '${d.repo || ""}')" title="Remove from dashboard" aria-label="Remove #${d.id} from dashboard" style="flex-shrink:0; width:29px; height:29px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:transparent; border:1px solid var(--border); color: var(--t-dim); cursor:pointer; font-size:12px;">✕</button>
    </div>`;
  };
  const body = done.length
    ? `<div style="display:flex; flex-direction:column; gap:8px;">${done.map(rowHtml).join("")}</div>`
    : `<div style="font-family:${MONO}; font-size:12px; color: var(--fainter); padding:15px 16px; border:1px dashed var(--border-soft); border-radius:12px;">No completed pull requests</div>`;
  return `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <div style="display:flex; align-items:center; gap:12px;">
        <span style="font-family:${MONO}; font-size:11px; letter-spacing:0.24em; text-transform:uppercase; color: var(--t-dim);">Done</span>
        <span style="font-family:${MONO}; font-size:11px; color: var(--fainter);">${done.length}</span>
      </div>
      <button onclick="clearDone()" style="font-family:${MONO}; font-size:10.5px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color: var(--t-quiet); background:transparent; border:1px solid var(--border); border-radius:9px; padding:8px 13px; cursor:pointer;">Clear all</button>
    </div>
    ${body}`;
}

// ── top-level render ─────────────────────────────────────────────────────────
function render() {
  let prs, done, isSample;
  if (!latest || latest === "error") {
    prs = SAMPLE_PRS.slice();
    done = SAMPLE_DONE.slice();
    isSample = true;
  } else {
    const list = latest.watching || [];
    prs = list.filter((e) => !isDoneEntry(e)).map(activeVM);
    done = list.filter(isDoneEntry).map(doneVM);
    isSample = false;
  }
  prs.sort((a, b) => statusMeta[a.status].rank - statusMeta[b.status].rank || a.id - b.id);

  const hero = heroHtml(prs);
  document.getElementById("hero").innerHTML = hero.html;
  document.getElementById("cards").innerHTML = prs.map(cardHtml).join("");
  document.getElementById("doneSection").innerHTML = doneSectionHtml(done);
  // The favicon carries the 👀 / red-dot status, so the title stays plain text + count —
  // no emoji here, or the tab shows the eyes twice (favicon image + title emoji).
  document.title = hero.needYou ? `watch-pr (${hero.needYou})` : "watch-pr";
  setFavicon(hero.needYou > 0);
  setAppBadge(hero.needYou);

  updateMeta(isSample);
}

// App-icon badge for when watch-pr is INSTALLED as an app (Edge/Chrome "Install" → a pinned
// taskbar icon on Windows, the home screen on iOS/Android). Shows the needs-you count on the
// icon and clears at zero. A no-op in a normal browser tab and where unsupported (e.g. Safari's
// macOS Dock), so it never errors — the tab favicon stays the indicator there.
function setAppBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge && navigator.setAppBadge(n).catch(() => {});
    else navigator.clearAppBadge && navigator.clearAppBadge().catch(() => {});
  } catch (e) { /* Badging API unsupported — fine */ }
}

// Ambient awareness: the favicon carries a red notification dot whenever something needs
// you, so a pinned tab tells you at a glance without switching to it (pairs with the tab
// title above). Cleared back to plain 👀 when nothing does. The dot's ring follows the
// theme so it reads on both a light and a dark tab strip.
function setFavicon(alert) {
  const link = document.querySelector("link[rel='icon']");
  if (!link) return;
  const stroke = isLight() ? "#eef0f4" : "#141117";
  const eyes = "<text y='.9em' font-size='90'>👀</text>";
  const dot = alert ? "<circle cx='80' cy='22' r='22' fill='#ff453a' stroke='" + stroke + "' stroke-width='7'/>" : "";
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" + eyes + dot + "</svg>";
  const href = "data:image/svg+xml," + encodeURIComponent(svg);
  if (link.href !== href) link.href = href; // only touch the DOM when it actually changes
}

// header freshness, liveness dots, footer label + check button — cheap, runs every 1s
function setDot(id, alive) {
  const el = document.getElementById(id);
  if (!el) return;
  const size = id === "headDot" ? "9px" : "8px";
  el.style.cssText = `width:${size}; height:${size}; border-radius:50%; background:${alive ? col("go") : "var(--t-mute)"}; box-shadow:${alive ? `0 0 10px ${cola("go", 0.8)}` : "none"}; animation:${alive ? "blink 1.8s ease-in-out infinite" : "none"};`;
}
function updateMeta(isSample) {
  if (isSample === undefined) isSample = (!latest || latest === "error");
  const alive = !!(pollAlive && pollAlive.alive);
  setDot("headDot", alive && !isSample);
  setDot("footDot", alive && !isSample);

  // freshness
  const fresh = document.getElementById("freshText");
  if (checking) fresh.textContent = "checking…";
  else if (isSample) fresh.textContent = "sample data";
  else {
    let newest = "";
    (latest.watching || []).forEach((e) => {
      const u = (e.display && e.display.updatedAt) || e.lastTickAt;
      if (u && u > newest) newest = u;
    });
    fresh.textContent = newest ? "updated " + agoShort(newest) + " ago" : "—";
  }

  // footer label
  const foot = document.getElementById("footLabel");
  if (isSample) foot.textContent = "STATIC PREVIEW   ·   SAMPLE DATA";
  else if (alive) {
    if (pollAlive.active && pollAlive.nextPollAt) {
      const rem = Math.max(0, Math.floor((new Date(pollAlive.nextPollAt).getTime() - Date.now()) / 1000));
      foot.textContent = "LIVE   ·   NEXT POLL " + mmss(rem);
    } else {
      foot.textContent = "LIVE   ·   IDLE";
    }
  } else {
    foot.textContent = "VIEWER ONLY   ·   START SERVER.JS FOR LIVE UPDATES";
  }

  // check button
  const btn = document.getElementById("checkBtn");
  const spin = checking ? "display:inline-block;animation:spin 0.9s linear infinite;" : "display:inline-block;";
  btn.innerHTML = `<span style="${spin}">↻</span>${checking ? "CHECKING" : "CHECK NOW"}`;
  btn.disabled = checking;

  // footer attribution (config-driven)
  const built = document.getElementById("footBuilt");
  if (built) {
    if (!CFG.builtBy) built.textContent = "";
    else if (CFG.builtByUrl) built.innerHTML = `<a href="${esc(CFG.builtByUrl)}" target="_blank" rel="noopener" style="color:inherit;">built by ${esc(CFG.builtBy)} ↗</a>`;
    else built.textContent = "built by " + CFG.builtBy;
  }
}

// ── actions ──────────────────────────────────────────────────────────────────
async function checkNow() {
  if (checking) return;
  checking = true;
  updateMeta();
  try {
    const res = await fetch("/check", { method: "POST", cache: "no-store" });
    const data = await res.json();
    if (data && data.watching) { latest = data; everLoaded = true; }
  } catch (e) { /* ignore */ }
  checking = false;
  render();
}
async function dismiss(id, repo) {
  const q = "/dismiss?id=" + encodeURIComponent(id) + (repo ? "&repo=" + encodeURIComponent(repo) : "");
  try { await fetch(q, { method: "POST", cache: "no-store" }); } catch (e) {}
  tick();
}
async function clearDone() {
  try { await fetch("/clear-done", { method: "POST", cache: "no-store" }); } catch (e) {}
  tick();
}
// "Watch a PR" — add any PR by id (yours or anyone's), monitored exactly like the rest.
function toggleAdd(show) {
  const bar = document.getElementById("addBar");
  const on = show === undefined ? bar.style.display === "none" : show;
  bar.style.display = on ? "flex" : "none";
  document.getElementById("addErr").textContent = "";
  if (on) {
    document.getElementById("addRepo").placeholder = "repo (default: " + (CFG.defaultRepository || "—") + ")";
    document.getElementById("addId").value = "";
    document.getElementById("addRepo").value = "";
    document.getElementById("addId").focus();
  }
}
async function submitAdd() {
  const id = document.getElementById("addId").value.trim();
  const repo = document.getElementById("addRepo").value.trim();
  const err = document.getElementById("addErr");
  if (!/^\d+$/.test(id)) { err.style.color = col("crit"); err.textContent = "enter a numeric PR id"; return; }
  err.style.color = "var(--t-mute)"; err.textContent = "adding…";
  try {
    const res = await fetch("/watch?id=" + encodeURIComponent(id) + (repo ? "&repo=" + encodeURIComponent(repo) : ""), { method: "POST", cache: "no-store" });
    const data = await res.json();
    if (data && data.ok) { toggleAdd(false); tick(); }
    else { err.style.color = col("crit"); err.textContent = (data && data.error) || ("HTTP " + res.status); }
  } catch (e) {
    err.style.color = col("crit"); err.textContent = "request failed — is the server running?";
  }
}

// ── theme (light / dark) ─────────────────────────────────────────────────────
// Selection precedence: an explicit stored choice wins; otherwise follow the OS. The
// toggle pins a choice to localStorage; while unpinned we track OS changes live. The
// flat palette is pure CSS (see app.css); JS only sets <html data-theme>, keeps the
// theme-color meta + favicon in sync, and re-renders so the theme-dependent shadows
// (which need a tone colour + alpha) recompute.
const THEME_KEY = "prwatch-theme";
const mqLight = window.matchMedia("(prefers-color-scheme: light)");
function storedTheme() {
  try { const v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : null; } catch (e) { return null; }
}
function currentTheme() { return storedTheme() || (mqLight.matches ? "light" : "dark"); }
function applyTheme() {
  const t = currentTheme();
  document.documentElement.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#f1f1f4" : "#131118");
  syncThemeBtn(t);
  render(); // recompute theme-dependent shadows/alpha + favicon
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme();
}
function syncThemeBtn(t) {
  const b = document.getElementById("themeBtn");
  if (!b) return;
  const light = (t || currentTheme()) === "light";
  const label = light ? "Switch to dark mode" : "Switch to light mode";
  b.textContent = light ? "☾" : "☀";
  b.title = label;
  b.setAttribute("aria-label", label);
}
mqLight.addEventListener("change", () => { if (!storedTheme()) applyTheme(); });

// ── polling loops ────────────────────────────────────────────────────────────
async function tick() {
  try {
    const res = await fetch("state.json?_=" + Date.now(), { cache: "no-store" });
    if (res.ok) { latest = await res.json(); everLoaded = true; }
    else if (!everLoaded) latest = "error";
  } catch (e) {
    if (!everLoaded) latest = "error";
  }
  render();
}
async function pollStatusTick() {
  try {
    const res = await fetch("/status?_=" + Date.now(), { cache: "no-store" });
    pollAlive = res.ok ? await res.json() : null;
  } catch (e) {
    pollAlive = null;
  }
  updateMeta();
}
async function loadConfig() {
  try {
    const res = await fetch("/config?_=" + Date.now(), { cache: "no-store" });
    if (res.ok) CFG = Object.assign(CFG, await res.json());
  } catch (e) { /* keep defaults */ }
  render();
}

document.getElementById("checkBtn").addEventListener("click", checkNow);
document.getElementById("themeBtn").addEventListener("click", toggleTheme);
document.getElementById("addBtn").addEventListener("click", () => toggleAdd(true));
document.getElementById("addId").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });

applyTheme();  // set data-theme + meta/favicon/toggle, then first render
loadConfig();
tick();
pollStatusTick();
setInterval(tick, 3000);             // re-fetch state.json
setInterval(pollStatusTick, 5000);   // re-check the resident poller
setInterval(() => updateMeta(), 1000); // tick freshness + poll countdown
