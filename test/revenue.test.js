"use strict";
/* Pins one rule: a payment follows the agent, not the creator.

   The case that broke it in production: an agent on team A books a sale for a
   creator mapped to team B. The aggregate is bucketed by the agent's team, so it
   can never reach B; the mapped-creator filter used to keep it off A. It vanished. */
const REV = require("../lib/revenue");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}
function c(o){ return Object.assign(REV.zero(), o); }
const OWNERS = { "201": { name: "Sid", email: "sid@x.com", active: true },
                 "202": { name: "Rhea", email: "rhea@x.com", active: false } };
const ownerOf = function(id){ return OWNERS[id] || {}; };

// Team A holds creator "alpha". Its agent 201 also sold 40,000 on "beta", which is
// mapped to team B.
const A = REV.teamRows({
  byCreator: {
    alpha: { "201": c({ revenue: 100000, enrolments: 2, queue: 10, touched: 3 }) },
    beta:  { "201": c({ revenue: 40000, enrolments: 1, queue: 4, touched: 1 }) }
  },
  mapped: ["alpha"],
  targetOf: function(cu){ return cu === "alpha" ? 150000 : 0; },
  ownerOf: ownerOf
});

ok("off-map revenue lands on the agent's team", A.totals.revenue === 140000, A.totals.revenue);
ok("off-map enrolments land too", A.totals.enrolments === 3, A.totals.enrolments);
ok("off-map queue lands too", A.totals.queue === 14, A.totals.queue);
ok("mapped creator keeps its own row", A.creatorRows[0].u === "alpha" && A.creatorRows[0].revenue === 100000);
ok("mapped creator row is not inflated by off-map work", A.creatorRows[0].queue === 10);
ok("one off-map row, last", A.creatorRows.length === 2 && A.creatorRows[1].offmap === true);
ok("off-map row names the creators", A.creatorRows[1].creators.join(",") === "beta");
ok("off-map row carries no target", A.creatorRows[1].target === 0);
ok("off-map row is flagged unmapped", A.creatorRows[1].mapped === false);
ok("off-map row drills to the agent", A.creatorRows[1].agents.length === 1 &&
  A.creatorRows[1].agents[0].id === "201" && A.creatorRows[1].agents[0].revenue === 40000);
ok("off-map work counts the agent as active", A.agentTouched["201"] === 1);
ok("offmap summary matches the row", A.offmap && A.offmap.revenue === 40000 && A.offmap.queue === 4);

// Team B owns the creator but did none of the work, so it gets none of the money.
const B = REV.teamRows({
  byCreator: { beta: { "202": c({ revenue: 5000, queue: 2 }) } },
  mapped: ["beta"],
  targetOf: function(){ return 300000; },
  ownerOf: ownerOf
});
ok("the mapping team gets only its own agents' revenue", B.totals.revenue === 5000, B.totals.revenue);
ok("no double count across teams", B.totals.revenue + A.totals.revenue === 145000);
ok("the mapping team keeps the creator target", B.creatorRows[0].target === 300000);
ok("no off-map row when there is nothing off map", B.offmap === null &&
  B.creatorRows.filter(function(r){ return r.offmap; }).length === 0);

// A mapped creator with no activity still gets a line, so a manager can see the zero.
const C = REV.teamRows({ byCreator: {}, mapped: ["gamma"], ownerOf: ownerOf });
ok("silent mapped creator still shows", C.creatorRows.length === 1 &&
  C.creatorRows[0].u === "gamma" && C.creatorRows[0].revenue === 0);
ok("empty team totals to zero", C.totals.revenue === 0 && C.offmap === null);

// Several off-map creators collapse into one row rather than a list of strangers.
const D = REV.teamRows({
  byCreator: {
    beta:  { "201": c({ revenue: 1000 }), "202": c({ revenue: 2000, touched: 1 }) },
    delta: { "201": c({ revenue: 3000, enrolments: 1 }) }
  },
  mapped: [],
  ownerOf: ownerOf
});
ok("many off-map creators collapse to one row", D.creatorRows.length === 1);
ok("collapsed row sums every creator and agent", D.creatorRows[0].revenue === 6000);
ok("collapsed row lists creators alphabetically", D.creatorRows[0].creators.join(",") === "beta,delta");
// 201 sold on both beta and delta, so the agent row sums across creators: 1000 + 3000.
ok("collapsed row splits by agent", D.creatorRows[0].agents.length === 2 &&
  D.creatorRows[0].agents[0].id === "201" && D.creatorRows[0].agents[0].revenue === 4000);
ok("agent identity survives the collapse", D.creatorRows[0].agents.filter(function(a){
  return a.id === "202" && a.name === "Rhea" && a.active === false; }).length === 1);

// Rows with neither money nor queue should not conjure an off-map row out of noise.
const E = REV.teamRows({ byCreator: { beta: { "201": c({ churned: 2 }) } }, mapped: ["alpha"], ownerOf: ownerOf });
ok("counters alone do not create an off-map row", E.offmap === null);

// zero()/addInto() are shared with server.js, so pin their shape too.
ok("zero has every counter", REV.KEYS.every(function(k){ return REV.zero()[k] === 0; }));
ok("addInto ignores non-numbers", (function(){
  const a = REV.zero(); REV.addInto(a, { revenue: 5, name: "x" }); return a.revenue === 5 && a.name === undefined;
})());


/* And the page actually renders it. The model can be right while the row is invisible,
   which from a manager's chair is the same bug. */
{
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "vp.html"), "utf8");
  const script = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map(function(b){ return b.replace(/^<script>/, "").replace(/<\/script>$/, ""); }).join("\n");
  const stub = { innerHTML: "", style: {}, textContent: "", value: "", scrollIntoView(){} };
  const ctx = { console: { log(){}, error(){} },
    document: { getElementById: function(){ return stub; }, querySelectorAll: function(){ return []; },
      addEventListener(){}, body: stub },
    window: {}, location: { search: "", href: "" },
    fetch: function(){ return new Promise(function(){}); }, setInterval(){}, setTimeout(){},
    Date, Math, JSON, Object, String, Number, Array, encodeURIComponent, Promise, RegExp,
    isNaN, parseInt, parseFloat, Intl, confirm(){ return false; }, alert(){},
    URL: { createObjectURL: function(){ return ""; } }, Blob: function(){},
    localStorage: { getItem: function(){ return null; }, setItem(){} },
    URLSearchParams: function(){ return { get: function(){ return ""; } }; } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  ctx.J = { month: "2026-08", isVP: true, dayOfMonth: 7, daysInMonth: 31, teams: [] };

  const row = Object.assign(REV.zero(), { u: REV.OFFMAP_LABEL, target: 0, mapped: false, offmap: true,
    creators: ["beta", "delta"], revenue: 40000, enrolments: 1, queue: 4,
    agents: [{ id: "201", name: "Sid", active: true, revenue: 40000, enrolments: 1, queue: 4 }] });
  const team = { id: "t1", creatorRows: [Object.assign(REV.zero(), { u: "alpha", target: 150000, mapped: true, agents: [] }), row] };
  const out = ctx.creatorRows(team);

  ok("the page draws the off-map row", out.indexOf(REV.OFFMAP_LABEL) >= 0);
  ok("it is marked as off map", out.indexOf("off map") >= 0 && out.indexOf("class='sub clik offmap'") >= 0);
  ok("it names the creators it covers", out.indexOf("beta, delta") >= 0);
  ok("it shows the revenue", out.indexOf(ctx.inr(40000)) >= 0);
  ok("it says where the target sits", out.indexOf("target sits with the mapped team") >= 0);
  ok("it offers no target box, because the target is not this team's",
    out.split("offmap")[1].indexOf("saveCreatorTarget") < 0);
  ok("the mapped creator above it is untouched", out.indexOf(">alpha<") >= 0);
}

console.log((fail ? "FAILED  " : "") + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
