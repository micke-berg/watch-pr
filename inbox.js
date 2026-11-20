// inbox.js — list the open PRs waiting for your review (you, or a team you belong to, is a
// reviewer and you have not voted). Read-only. Prints JSON, one object per PR.
//
//   node inbox.js            JSON array on stdout
//   node inbox.js --table    one human-readable line per PR

const config = require("./config.js");
const PROVIDERS = { azure: "./providers/azure.js", github: "./providers/github.js" };
const provider = require(PROVIDERS[config.provider] || PROVIDERS.azure);

if (typeof provider.listReviewInbox !== "function") {
  console.error(`the "${config.provider}" provider cannot list a review inbox yet`);
  process.exit(2);
}

provider.listReviewInbox()
  .then((prs) => {
    if (!process.argv.includes("--table")) return console.log(JSON.stringify(prs, null, 2));
    if (!prs.length) return console.log("(inbox empty)");
    for (const p of prs) {
      const votes = p.teamVotes.length ? `  team votes: ${p.teamVotes.map((v) => `${v.team} ${v.vote}`).join(", ")}` : "";
      console.log(`${p.id}  ${p.repo}  ${p.createdAt.slice(0, 10)}  ${p.author}  via ${p.via}  ${p.title}${votes}`);
    }
  })
  .catch((e) => { console.error("inbox failed: " + e.message); process.exit(1); });
