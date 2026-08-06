"use strict";
/* Renders the real page script against a realistic payload, as each role, with the drill
   open. `node --check` cannot see a function that a patch deleted, and the endpoint test
   never runs the browser code at all. This is the gap that let "srcLabel is not defined"
   and "sources is not defined" both reach production. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const CN2 = require("../lib/cn2");
const fixture = require("../fixtures/make.js");

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}

const fmtN = function(n){ return (n||0).toLocaleString('en-IN'); };
const html = fs.readFileSync(path.join(__dirname, "..", "public", "callnow2.html"), "utf8");

/* theme.css loads after the page's own styles and sets its rules with !important, so any
   density rule written before that link silently loses. This is not a detail: it is why a
   whole round of "make the rows tighter" looked like it had never shipped. */
console.log("\nDensity rules have to come after the shared theme");
{
  const themeAt = html.indexOf('href="/theme.css"');
  ok("the theme is linked", themeAt > 0);
  const after = html.slice(themeAt);
  [["compact header cells", "table th{padding:5px"],
   ["compact body cells", "table td{padding:4px"],
   ["table type scaled to the rows", "table{font-size:12.5px"],
   ["the navy total row stays legible", "tr.tot.grand td,.wrap tr.tot.grand td b{color:#fff"],
   ["tables scroll", ".tw{max-height"],
   ["two column header blocks", ".top{display:grid"]].forEach(function(r){
    ok(r[0] + " is defined after the theme", after.indexOf(r[1]) >= 0, r[1]);
  });
  const before = html.slice(0, themeAt);
  ok("and the theme cannot override them",
    after.indexOf("!important") > 0 && before.indexOf(".tw{max-height:56vh}") < 0);
}
const script = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map(function(b){ return b.replace(/^<script>/, "").replace(/<\/script>$/, ""); }).join("\n");

// Build a payload with the same shape the endpoint returns.
const STAGES = ["counselled", "program_pitched", "dnp_did_not_pick", "__fresh", "IFC"];
const day = CN2.dayBoundsFor(fixture.now);
const base = {}, live = {};
fixture.rows.forEach(function(r){
  if (STAGES.indexOf(r.stage) < 0) return;
  if (r.counted === undefined) r.counted = true;
  live[r.id] = r;
  base[r.id] = CN2.pack(CN2.classify(r, day, { work: CN2.workDaySet(), scoreMin: 6 }));
});
const agg = CN2.aggregate(base, live, day, STAGES);
const payload = {
  stages: STAGES.map(function(s){ return { stage: s, label: s, n: agg.sections.n[s], a: agg.sections.a[s], d: agg.sections.d[s] }; }),
  totals: agg.totals, excluded: agg.excluded, movement: agg.movement,
  offBase: { leads: 3 }, timing: CN2.TIMING, columns: CN2.COLUMNS,
  frozen: true, frozenAt: new Date(fixture.now).toISOString(), freezeHour: "00:05",
  workDays: "1,2,3,4,5,6", baseSize: Object.keys(base).length, fixtures: true,
  teamOptions: fixture.teams.map(function(t){ return { id: t.id, name: t.name }; }),
  agentOptions: fixture.agents.map(function(a){ return { id: a.id, name: a.name, n: 5 }; }),
  creatorOptions: [{ u: "ayush_singh13", n: 40 }],
  sourceOptions: [{ u: "forms", n: 12 }, { u: "digital product", n: 8 }],
  stageOptions: STAGES.map(function(s){ return { stage: s, label: s }; }),
  loadedAt: "fixtures", listBuiltAt: new Date(fixture.now).toISOString(),
  effort: { total: { low: 40, avg: 12, bench: 5, high: 2 }, owner: { low: 50, avg: 6, bench: 2, high: 1 } },
  effortBands: CN2.EFFORT_BANDS.map(function(b){
    return { key: b.key, label: b.label, min: b.min, max: b.max === Infinity ? null : b.max, cls: b.cls }; })
};
const agents = Object.keys(agg.byAgent).map(function(id){
  return { id: id === "none" ? "" : id, name: "Agent " + id, team: "Team Sid", teamId: "t1",
    active: id !== "204", counted: agg.byAgent[id].counted !== false, offBase: 0,
    effort: { total: { low: 30, avg: 8, bench: 3, high: 1 },
              owner: { low: 38, avg: 3, bench: 1, high: 0 } },
    n: agg.byAgent[id].n, a: agg.byAgent[id].a, d: agg.byAgent[id].d };
});
const leadRows = Object.keys(base).slice(0, 3).map(function(id){
  const c = CN2.unpack(base[id]), r = live[id];
  return { id: id, worked: false, gone: false, name: r.name, openStage: c.stage, openTiming: c.t,
    section: c.sec, why: c.why, nowStage: c.stage, nowTiming: c.t, movedStage: false, movedFu: false,
    movedOwner: false, ownerName: r.ownerName, creator: r.creator, source: "forms", counted: c.counted,
    phone: r.phone, last: r.last, fu: r.fu, formLast: 0, calls: 1, own: 1, score: 8, intl: false,
    forms: ["Payal Waitlist"], formN: 1, formSubs: [{ form: "Payal Waitlist", at: fixture.now,
      answers: [{ q: "What is your current Role ?", a: ["Electrical Engineer"] }] }],
    bookTitle: "A course", bookType: "digital_product", bookAt: fixture.now, bookN: 1,
    convRecent: "", convFirst: "", aiSummary: "note", outcome: "Connected", whyText: "", coldReason: "",
    needsOwner: false, unassigned: false, ownerInactive: true, band: "low", bandOwner: "bench", gone: false,
    stageEntered: fixture.now - 5 * 86400000 };
});

function render(role){
  let out = "";
  const app = { set innerHTML(v){ out = v; }, get innerHTML(){ return out; }, style: {} };
  const stub = { innerHTML: "", style: {}, textContent: "", scrollIntoView(){} };
  const ctx = { console: { log(){}, error(){} },
    document: { getElementById: function(id){ return id === "app" ? app : stub; } },
    fetch: function(){ return new Promise(function(){}); },
    setInterval(){}, setTimeout(){}, Date, Math, JSON, Object, String, Number, Array,
    encodeURIComponent, Promise, RegExp, isNaN, parseInt, parseFloat, Intl,
    confirm(){ return false; }, alert(){}, URL: { createObjectURL: function(){ return ""; } },
    Blob: function(){} };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  ctx.J = Object.assign({}, payload, role);
  ctx.A = { agents: agents, effortBands: payload.effortBands };
  ctx.LOADING = false;
  ctx.draw();                                   // the matrix, filters, agent table
  ctx.PICK = { stage: "counselled", sec: "n", col: "all", t: "", worked: "", moved: "", notcounted: "" };
  ctx.LEADS = false;
  ctx.OPEN = {}; ctx.OPEN[leadRows[0].id] = true;
  ctx.L = { total: leadRows.length, shown: leadRows.length, rows: leadRows,
    portal: { uiDomain: "app.hubspot.com", portalId: "1" } };
  ctx.draw();                                   // again, with the drill open and expanded
  ctx.REC = { rows: [{ key: "overdue", label: "Overdue", v1: 100, v2: 40, delta: -60, why: "different rule" }],
    shown: { notCounted: 41, unassigned: 1 } };
  ctx.draw();                                   // and with the reconciliation panel
  return out;
}

const ROLES = [
  ["VP", { isVP: true, scoped: false, role: "manager" }],
  ["manager", { isVP: false, scoped: true, role: "manager" }],
  ["agent", { isVP: false, scoped: true, role: "agent" }]
];
console.log("\nThe page renders for every role, with the drill and the panel open");
ROLES.forEach(function(r){
  let out = "", err = null;
  try { out = render(r[1]); } catch (e) { err = e; }
  ok(r[0] + " renders without throwing", !err, err && err.message);
  if (err) return;
  ok(r[0] + " actually produced a table", out.indexOf("<table") >= 0 && out.length > 3000, String(out.length));
});

console.log("\nA section with a single stage does not repeat itself");
{
  const one = Object.assign({}, payload, { isVP: true, scoped: false, role: "manager" });
  // leave only one stage with anything in the parked group
  const solo = JSON.parse(JSON.stringify(payload.stages));
  solo.forEach(function(st, i){ if (i > 0) st.d = Object.assign({}, st.d, { all: 0 }); });
  one.stages = solo;
  let out = "";
  const app = { set innerHTML(v){ out = v; }, get innerHTML(){ return out; }, style: {} };
  const stub = { innerHTML: "", style: {}, textContent: "", scrollIntoView(){} };
  const ctx = { console: { log(){}, error(){} },
    document: { getElementById: function(id){ return id === "app" ? app : stub; } },
    fetch: function(){ return new Promise(function(){}); }, setInterval(){}, setTimeout(){},
    Date, Math, JSON, Object, String, Number, Array, encodeURIComponent, Promise, RegExp,
    isNaN, parseInt, parseFloat, Intl, confirm(){ return false; }, alert(){},
    URL: { createObjectURL: function(){ return ""; } }, Blob: function(){} };
  vm.createContext(ctx); vm.runInContext(script, ctx);
  ctx.J = one; ctx.A = { agents: agents }; ctx.LOADING = false; ctx.draw();
  const parked = out.slice(out.indexOf("DNP, nothing to act on today"));
  const subtotals = (parked.match(/tot sub/g) || []).length;
  ok("no subtotal row under a group that has only one stage in it", subtotals === 0,
    subtotals + " subtotal rows");
  ok("the grand total is still there", out.indexOf("Everything added up") >= 0);
  ok("the DNP group says which DNP leads it holds and which it does not",
    out.indexOf("The DNP leads that do carry one are counted in Call today above") >= 0);
}

console.log("\nChurn effort ordering");
{
  // Worst churn should lead, but never a parking bucket or a deactivated agent.
  const mk = function(id, name, active, counted, lowShare, pool){
    const low = Math.round(pool * lowShare), rest = pool - low;
    return { id: id, name: name, team: "Team Sid", teamId: "t1", active: active, counted: counted,
      offBase: 0, n: Object.assign(CN2.cell(), { all: pool }), a: CN2.cell(), d: CN2.cell(),
      effort: { owner: { low: low, avg: rest, bench: 0, high: 0 },
                total: { low: low, avg: rest, bench: 0, high: 0 } } };
  };
  const list = [
    mk("9", "Deactivated Dan", false, true, 0.95, 100),   // worst churn, but deactivated
    mk("8", "Parking Pete", true, false, 0.90, 100),      // worse than anyone working
    mk("1", "Sloppy Sam", true, true, 0.80, 100),
    mk("2", "Tidy Tina", true, true, 0.10, 100)
  ];
  let out = "";
  const app = { set innerHTML(v){ out = v; }, get innerHTML(){ return out; }, style: {} };
  const stub = { innerHTML: "", style: {}, textContent: "", scrollIntoView(){} };
  const ctx = { console: { log(){}, error(){} },
    document: { getElementById: function(id){ return id === "app" ? app : stub; } },
    fetch: function(){ return new Promise(function(){}); }, setInterval(){}, setTimeout(){},
    Date, Math, JSON, Object, String, Number, Array, encodeURIComponent, Promise, RegExp,
    isNaN, parseInt, parseFloat, Intl, confirm(){ return false; }, alert(){},
    URL: { createObjectURL: function(){ return ""; } }, Blob: function(){} };
  vm.createContext(ctx); vm.runInContext(script, ctx);
  ctx.J = Object.assign({}, payload, { isVP: true, scoped: false, role: "manager" });
  ctx.A = { agents: list, effortBands: payload.effortBands };
  ctx.LOADING = false; ctx.draw();
  const churn = out.slice(out.indexOf("Lead churn effort"));
  const seen = ["Sloppy Sam", "Tidy Tina", "Parking Pete", "Deactivated Dan"]
    .map(function(n){ return { n: n, at: churn.indexOf(n) }; })
    .filter(function(x){ return x.at >= 0; })
    .sort(function(a, b){ return a.at - b.at; }).map(function(x){ return x.n; });
  console.log("     order: " + seen.join("  ->  "));
  ok("worst churning working agent leads", seen[0] === "Sloppy Sam");
  ok("a parking bucket cannot head the list despite worse churn", seen.indexOf("Parking Pete") > seen.indexOf("Tidy Tina"));
  ok("a deactivated agent is last", seen[seen.length - 1] === "Deactivated Dan");
}

console.log("\nRole specific things appear only where they should");
{
  const vp = render(ROLES[0][1]), mgr = render(ROLES[1][1]), agent = render(ROLES[2][1]);
  ok("only a VP is offered the v1 comparison", vp.indexOf("Call Now v1 against v2") >= 0 &&
    mgr.indexOf("Call Now v1 against v2") < 0 && agent.indexOf("Call Now v1 against v2") < 0);
  ok("only a VP can relock the list", vp.indexOf("Lock again") >= 0 && agent.indexOf("Lock again") < 0);
  ok("an agent gets no agent table", vp.indexOf("by agent") >= 0 && agent.indexOf("by agent") < 0);
  ok("a scoped reader gets no manager or agent picker",
    vp.indexOf(">Manager<") >= 0 && agent.indexOf(">Manager<") < 0);
  ok("everyone still gets the stage and owner controls",
    agent.indexOf("All stages") >= 0 && agent.indexOf("Needs owner") >= 0);
  ok("the form answers render inside the drill", vp.indexOf("What is your current Role ?") >= 0);
  ok("a deactivated owner is flagged on the lead row", vp.indexOf(">INACTIVE<") >= 0);
  ok("the WhatsApp button rule sits after the theme so it is not plain text",
    html.slice(html.indexOf('href="/theme.css"')).indexOf("a.wa{background:#15A34A") >= 0);
  ok("the held-aside pile is reported", vp.indexOf("Shown but not counted") >= 0);
  ok("the hero carries called against the pool",
    vp.indexOf("Called today") >= 0 && vp.indexOf("% done") >= 0);
  {
    // The percentage must divide one population by itself, not two different ones.
    const t = payload.totals.n;
    const want = fmtN(t.allW) + "<span class='of'>/ " + fmtN(t.all) + "</span>";
    ok("hero numerator and denominator are both the call-today group",
      vp.indexOf(want) >= 0, want);
    ok("the footer says how big the whole list is as well",
      vp.indexOf("leads on the list") >= 0 && vp.indexOf("need a call today") >= 0);
    ok("and warns that HubSpot's own count is higher",
      vp.indexOf("HubSpot's own call count will be higher") >= 0);
  }
  ok("what changed today is chips beside the hero",
    vp.indexOf("What changed today") >= 0 && vp.indexOf("moved stage") >= 0);
  ok("each group shades in its own hue, not one blue over everything",
    vp.indexOf("rgba(184,121,26,") >= 0 && vp.indexOf("rgba(28,107,78,") >= 0 &&
    vp.indexOf("rgba(47,111,228,") >= 0,
    "hues found: " + ["47,111,228","184,121,26","28,107,78","90,107,125"]
      .filter(function(c){ return vp.indexOf("rgba(" + c + ",") >= 0; }).join(" | "));
  {
    // Scope the check to the queue table: the matrix has a Stage column too, and comparing
    // against that one compares two different tables.
    const q = vp.slice(vp.indexOf("Call queue"));
    const phone = q.indexOf("Phone"), stage = q.indexOf("<th>Stage</th>");
    ok("in the queue, phone and WhatsApp come before the stage",
      phone >= 0 && stage >= 0 && phone < stage, "phone " + phone + ", stage " + stage);
  }
  ok("WhatsApp is a styled button, not plain text",
    vp.indexOf("class='wa'") >= 0 && vp.indexOf("wa.me/") >= 0);
  ok("active and deactivated agents can be filtered",
    vp.indexOf("Active agents") >= 0 && vp.indexOf("Deactivated agents") >= 0);
  ok("an agent gets those filters too", agent.indexOf("Active agents") >= 0);
  ok("the matrix header is banded into four groups",
    vp.indexOf("Priority signals") >= 0 && vp.indexOf("New information") >= 0 &&
    vp.indexOf("Totals") >= 0 && vp.indexOf("class='grp'") >= 0);
  ok("churn effort is named and banded",
    vp.indexOf("Lead churn effort") >= 0 && vp.indexOf("Barely tried") >= 0 &&
    vp.indexOf("At benchmark") >= 0 && vp.indexOf("0 to 3") >= 0 && vp.indexOf("11+") >= 0);
  ok("churn effort is per agent, not one summary row",
    vp.indexOf("Lead churn effort") >= 0 && vp.indexOf("Agent 201") >= 0);
  ok("both readings are offered",
    vp.indexOf("By the agent who holds it") >= 0 && vp.indexOf("By anyone, in the stage") >= 0);
  ok("an agent sees their own churn effort too",
    agent.indexOf("Lead churn effort") >= 0);
  ok("attempt counts on a lead row are colour banded",
    vp.indexOf("counting every agent") >= 0 && vp.indexOf("this agent only") >= 0);
  ok("a manager still gets the agent table, only the agent loses it",
    mgr.indexOf("by agent") >= 0 && agent.indexOf("by agent") < 0);
  ok("the header blocks sit in two columns, not four stacked bars",
    vp.indexOf("class='top'") >= 0 && (vp.match(/class='topcol'/g) || []).length === 2,
    String((vp.match(/class='topcol'/g) || []).length) + " columns");
  ok("the hero leads, then the controls, then the tables",
    vp.indexOf("Called today") < vp.indexOf("Manager") &&
    vp.indexOf("Manager") < vp.indexOf("Call today"));
  ok("three views, matrix first",
    vp.indexOf("class='seg'") >= 0 && (vp.match(/class='view/g) || []).length === 3 &&
    vp.indexOf("class='view on'") >= 0);
  ok("the board is one of them", vp.indexOf("Board view") >= 0);
  // With nothing picked the queue must invite a choice, not invent one.
  {
    let out = "";
    const app = { set innerHTML(v){ out = v; }, get innerHTML(){ return out; }, style: {} };
    const stub = { innerHTML: "", style: {}, textContent: "", scrollIntoView(){} };
    const c2 = { console: { log(){}, error(){} },
      document: { getElementById: function(id){ return id === "app" ? app : stub; } },
      fetch: function(){ return new Promise(function(){}); }, setInterval(){}, setTimeout(){},
      Date, Math, JSON, Object, String, Number, Array, encodeURIComponent, Promise, RegExp,
      isNaN, parseInt, parseFloat, Intl, confirm(){ return false; }, alert(){},
      URL: { createObjectURL: function(){ return ""; } }, Blob: function(){} };
    vm.createContext(c2); vm.runInContext(script, c2);
    c2.J = Object.assign({}, payload, { isVP: true, scoped: false, role: "manager" });
    c2.A = { agents: agents, effortBands: payload.effortBands };
    c2.LOADING = false; c2.draw();
    ok("the queue waits for a pick rather than guessing",
      out.indexOf("Pick a number in the Matrix") >= 0);
    ok("and no lead card exists until a lead is picked", out.indexOf("class='now'") < 0);
  }
  ok("every table is inside a scrolling wrapper",
    (vp.match(/class='tw/g) || []).length >= 4, String((vp.match(/class='tw/g) || []).length));
  ok("why-call tags carry the tooltip v1 has",
    vp.indexOf("title='Filled the form again since the last call'") >= 0 ||
    vp.indexOf("title='Submitted this waitlist form'") >= 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
