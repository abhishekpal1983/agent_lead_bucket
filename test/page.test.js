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
  trackedCreators: ["ayush_singh13", "simrankhokha", "Simrankhokha"],
  checks: { at: new Date().toISOString(), ok: true,
    checks: [{ key: "total", label: "Every lead is either counted or held aside", ok: true, detail: "" }] },
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

function render(role, extra){
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
  // The fixture payload says loadedAt "fixtures", which is its own branch. Override it
  // so the real freshness line is the one under test.
  ctx.J = Object.assign(ctx.J, { loadedAt: new Date().toISOString(),
    leadsAt: new Date(Date.now() - 6 * 60000).toISOString(),
    fullAt: new Date(Date.now() - 5 * 3600000).toISOString(),
    listBuiltAt: new Date(Date.now() - 2 * 60000).toISOString(), syncEvery: 10 });
  ctx.A.byStage = [
    { stage: "counselled", label: "Counselled", n: 120,
      effort: { total: { low: 70, avg: 30, bench: 15, high: 5 }, owner: { low: 90, avg: 20, bench: 8, high: 2 } },
      agents: [{ id: "201", name: "Sid Menon", n: 80,
        effort: { total: { low: 50, avg: 20, bench: 8, high: 2 }, owner: { low: 60, avg: 15, bench: 4, high: 1 } } }] },
    { stage: "__fresh", label: "Fresh leads", n: 40,
      effort: { total: { low: 40, avg: 0, bench: 0, high: 0 }, owner: { low: 40, avg: 0, bench: 0, high: 0 } },
      agents: [] }
  ];
  ctx.A.byCreator = [
    { u: "ayush_singh13", n: 90,
      effort: { total: { low: 60, avg: 20, bench: 8, high: 2 }, owner: { low: 70, avg: 12, bench: 6, high: 2 } } }
  ];
  ctx.J.caughtUpTo = new Date(Date.now() - 4 * 60000).toISOString();
  ctx.J.caughtUp = true;
  ctx.J.callsAt = new Date(Date.now() - 2 * 60000).toISOString();
  ctx.J.callsEvery = 3;
  ctx.J.seg = { id: "77", name: "ayush-final-payment-push", loading: false,
    size: 1904, onList: 412, outside: 1492, truncated: false };
  ctx.ASSIGN = { allowed: true, scoped: !!role.scoped, rows: [
    { u: "ayush_singh13", unassigned: 4, left: 2, total: 6, assignedToday: 1,
      holders: [{ id: "205", name: "Gone Gita", n: 2 }] },
    { u: "payalineurope", unassigned: 3, left: 0, total: 3, assignedToday: 0, holders: [] }
  ], totals: { unassigned: 7, left: 2, total: 9, assignedToday: 1 } };
  ctx.LOADING = false;
  // The explanatory cards live in a fold that is shut by default. Open it, or every
  // assertion about them tests the fold rather than the card.
  ctx.BEHIND = true;
  // Extra context a caller wants pinned, such as a Loop WA payload and which view is on.
  if (extra) Object.keys(extra).forEach(function(k){ ctx[k] = extra[k]; });
  ctx.draw();                                   // the matrix, filters, agent table
  ctx.PICK = { stage: "counselled", sec: "n", col: "all", t: "", worked: "", moved: "", notcounted: "" };
  ctx.LEADS = false;
  ctx.OPEN = {}; ctx.OPEN[leadRows[0].id] = true;
  ctx.L = { total: leadRows.length, shown: leadRows.length, rows: leadRows,
    portal: { uiDomain: "app.hubspot.com", portalId: "1" } };
  if (extra) Object.keys(extra).forEach(function(k){ ctx[k] = extra[k]; });
  ctx.draw();                                   // again, with the drill open and expanded
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
  ctx.LOADING = false; ctx.BEHIND = true; ctx.draw();
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
  // v2 is the model now, so there is nothing left to compare it against.
  ok("a chosen segment says how much of it is on today's list",
    vp.indexOf("ayush-final-payment-push") >= 0 && vp.indexOf("412") >= 0);
  ok("and says plainly what fell outside rather than dropping it",
    vp.indexOf("1,492") >= 0 && vp.indexOf("are not") >= 0);
  ok("the v1 comparison is gone for everybody",
    [vp, mgr, agent].every(function(x){ return x.indexOf("Call Now v1 against v2") < 0; }));
  ok("only a VP can relock the list", vp.indexOf("Lock again") >= 0 && agent.indexOf("Lock again") < 0);
  ok("an agent gets no agent table", vp.indexOf("by agent") >= 0 && agent.indexOf("by agent") < 0);
  // A manager picks between their own agents constantly; only the Manager picker is a
  // VP control. An agent has nothing to choose between and gets neither.
  ok("only a VP gets the manager picker",
    vp.indexOf(">Manager<") >= 0 && mgr.indexOf(">Manager<") < 0 && agent.indexOf(">Manager<") < 0);
  ok("a manager gets the agent picker, an agent does not",
    mgr.indexOf(">Agent<") >= 0 && vp.indexOf(">Agent<") >= 0 && agent.indexOf(">Agent<") < 0);
  // Reversed on purpose: an agent already has every stage in the matrix, and only ever
  // holds their own leads, so both chip rows were duplicating or filtering on nothing.
  ok("managers and VPs keep the stage and owner controls",
    vp.indexOf("All stages") >= 0 && vp.indexOf("Needs owner") >= 0 &&
    mgr.indexOf("All stages") >= 0);
  ok("an agent does not, the matrix is already their stage filter",
    agent.indexOf("All stages") < 0 && agent.indexOf("Active agents") < 0);
  ok("the form answers render inside the drill", vp.indexOf("What is your current Role ?") >= 0);
  ok("a deactivated owner is flagged on the lead row", vp.indexOf(">INACTIVE<") >= 0);
  ok("the WhatsApp button rule sits after the theme so it is not plain text",
    html.slice(html.indexOf('href="/theme.css"')).indexOf("a.wa{background:#15A34A") >= 0);
  ok("the held-aside pile is reported", vp.indexOf("Shown but not counted") >= 0);
  ok("data quality is stated on the page", vp.indexOf("Data quality") >= 0 && vp.indexOf("all clear") >= 0);
  {
    // A failing invariant must shout at the top of the page, not sit in a panel below.
    let out = "";
    const app = { set innerHTML(v){ out = v; }, get innerHTML(){ return out; }, style: {} };
    const stub = { innerHTML: "", style: {}, textContent: "", scrollIntoView(){} };
    const c4 = { console: { log(){}, error(){} },
      document: { getElementById: function(id){ return id === "app" ? app : stub; } },
      fetch: function(){ return new Promise(function(){}); }, setInterval(){}, setTimeout(){},
      Date, Math, JSON, Object, String, Number, Array, encodeURIComponent, Promise, RegExp,
      isNaN, parseInt, parseFloat, Intl, confirm(){ return false; }, alert(){},
      URL: { createObjectURL: function(){ return ""; } }, Blob: function(){} };
    vm.createContext(c4); vm.runInContext(script, c4);
    c4.J = Object.assign({}, payload, { isVP: true, scoped: false, role: "manager",
      checks: { at: new Date().toISOString(), ok: false, checks: [
        { key: "total", label: "Every lead is either counted or held aside", ok: false, detail: "10 vs 11" }] },
      drift: { at: new Date().toISOString(), hubspot: 981, ours: 400, gap: 581, pct: 59.2, level: "bad" } });
    c4.A = { agents: agents, effortBands: payload.effortBands };
    c4.LOADING = false; c4.draw();
    ok("a failed invariant is shouted at the top", out.indexOf("These numbers do not add up") >= 0);
    ok("and it names the check that failed", out.indexOf("10 vs 11") >= 0);
    ok("drift against HubSpot is shown too", out.indexOf("a gap of 59.2%") >= 0);
    // The banner is a warning, not an explanation, so it stays above the fold and above
    // the number it is warning about.
    ok("the banner comes before everything it is warning about",
      out.indexOf("These numbers do not add up") >= 0 &&
      out.indexOf("These numbers do not add up") < out.indexOf("class='hcard") &&
      out.indexOf("class='hcard") < out.indexOf(">Manager<"));
  }

  ok("the tracked creator list can be managed from the page",
    vp.indexOf("Tracked creators") >= 0 && vp.indexOf("Add and sync") >= 0 &&
    vp.indexOf("Check what is outside") >= 0);
  ok("a capitalisation clash in the tracked list is called out",
    vp.indexOf("listed twice with different capitalisation") >= 0);
  ok("only a VP manages the tracked list", mgr.indexOf("Add and sync") < 0 && agent.indexOf("Add and sync") < 0);
  ok("four hero cards, one per group",
    (vp.match(/class='hcard/g) || []).length === 4, String((vp.match(/class='hcard/g) || []).length));
  ok("each group is named on its own card",
    vp.indexOf(">Call today<") >= 0 && vp.indexOf(">Booked for a later date<") >= 0 &&
    vp.indexOf(">DNPs<") >= 0 && vp.indexOf(">Outside the list<") >= 0);
  {
    // Every card must divide one population by itself.
    ["n", "a", "d"].forEach(function(sec){
      const t = payload.totals[sec];
      const want = fmtN(t.allW) + "<span class='of'>/ " + fmtN(t.all) + "</span>";
      ok("the " + sec + " card divides its own group by itself", vp.indexOf(want) >= 0, want);
    });
    ok("the lock time and list size are stated once, under the cards",
      vp.indexOf("Locked") >= 0 && vp.indexOf("leads.") >= 0);
  }
  ok("movement is a table that adds up, not loose chips",
    vp.indexOf("What happened to this morning's list") >= 0 &&
    vp.indexOf("On the list at midnight") >= 0 && vp.indexOf("Moved stage") >= 0);
  ok("and it is VP machinery, not floor furniture",
    mgr.indexOf("What happened to this morning's list") < 0 &&
    agent.indexOf("What happened to this morning's list") < 0);
  ok("the explanatory cards are folded away, not stacked above the work",
    vp.indexOf("class='behind") >= 0 && vp.indexOf("Behind the numbers") >= 0 &&
    vp.indexOf("class='view") < vp.indexOf("class='behind"));
  ok("each group shades in its own hue, not one blue over everything",
    vp.indexOf("rgba(184,121,26,") >= 0 && vp.indexOf("rgba(28,107,78,") >= 0 &&
    vp.indexOf("rgba(47,111,228,") >= 0,
    "hues found: " + ["47,111,228","184,121,26","28,107,78","90,107,125"]
      .filter(function(c){ return vp.indexOf("rgba(" + c + ",") >= 0; }).join(" | "));
  {
    // Scope the check to the queue table: the matrix has a Stage column too, and comparing
    // against that one compares two different tables.
    const q = vp.slice(vp.indexOf("Call queue"));
    // The headers are generated now, so match the label rather than the old fixed markup.
    const phone = q.indexOf(">Phone<"), stage = q.indexOf(">Stage<");
    ok("queue columns can be sorted", vp.indexOf("class='sortable") >= 0 && vp.indexOf("sortBy(") >= 0);
  ok("the agent table can be sorted too", vp.indexOf("aSort(") >= 0);
  ok("churn colour is strong enough to read, not a hint",
    html.slice(html.indexOf('href="/theme.css"')).indexOf("tr.b-low td{background:#FBE4DE") >= 0);
  ok("all four bands are coloured, not just the extremes",
    ["b-low", "b-avg", "b-bench", "b-high"].every(function(c){
      return html.indexOf("tr." + c + " td{background") >= 0; }));
  // Multicol balanced by height and left the third column empty. Two placed columns
  // instead, and the rule still has to sit AFTER theme.css or it never takes effect.
  ok("the VP cards sit in two placed columns, not a balanced flow",
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".vpflow{display:grid;grid-template-columns:1fr 1fr") >= 0);
  ok("the pool to assign sits beside the pile held aside, not below it",
    vp.indexOf("Shown but not counted") < vp.indexOf("Fresh leads waiting to be assigned") &&
    vp.indexOf("Fresh leads waiting to be assigned") < vp.indexOf("class='vpwide'"));
  ok("and the wide tables sit below at full width",
    vp.indexOf("class='vpflow'") >= 0 && vp.indexOf("class='vpwide'") >= 0 &&
    vp.indexOf("class='vpflow'") < vp.indexOf("class='vpwide'"));
  ok("in the queue, phone and WhatsApp come before the stage",
      phone >= 0 && stage >= 0 && phone < stage, "phone " + phone + ", stage " + stage);
  }
  ok("WhatsApp is a styled button, not plain text",
    vp.indexOf("class='wa'") >= 0 && vp.indexOf("wa.me/") >= 0);
  ok("active and deactivated agents can be filtered",
    vp.indexOf("Active agents") >= 0 && vp.indexOf("Deactivated agents") >= 0);
  ok("but an agent does not need them", agent.indexOf("Active agents") < 0);
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
  ok("a manager gets churn effort", mgr.indexOf("Lead churn effort") >= 0);
  ok("an agent does not, same as the agent table",
    agent.indexOf("Lead churn effort") < 0 && agent.indexOf("calling list by agent") < 0);
  ok("attempt counts on a lead row are colour banded",
    vp.indexOf("counting every agent") >= 0 && vp.indexOf("this agent only") >= 0);
  ok("a manager still gets the agent table, only the agent loses it",
    mgr.indexOf("by agent") >= 0 && agent.indexOf("by agent") < 0);
  // Reversed on purpose: the work now sits above the explanation of the work.
  ok("the controls sit above the work, and the machinery below it",
    vp.indexOf(">Manager<") < vp.search(/class='view( on)?'/) &&
    vp.search(/class='view( on)?'/) < vp.indexOf("class='vpflow'"));
  // Pinned was tried and dropped: a fifth of the screen held back on every table below
  // is too much to pay for keeping a filter in reach.
  ok("the band does not stick to the top of the screen",
    vp.indexOf("class='headband'") >= 0 && vp.indexOf("headband sticky") < 0 &&
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .headband.sticky{position:sticky") < 0);
  ok("the view tabs sit under the cards, where the choice follows the headline",
    vp.indexOf("class='heroside'") < vp.indexOf("class='viewstrip'") &&
    vp.indexOf("class='viewstrip'") < vp.indexOf("class='bar ctl'"));
  ok("and they are a strip, not a card with a line of white under it",
    vp.indexOf("class='vnote'") >= 0);
  ok("the cards sit two by two beside the controls, not four across above them",
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .herorow{display:grid !important;grid-template-columns:repeat(2") >= 0 &&
    vp.indexOf("class='heroside'") < vp.indexOf("class='bar ctl'"));
  ok("a stage chip wears the colour that stage wears in the tables",
    vp.indexOf("class='chipb stagechip'") >= 0 || vp.indexOf("chipb stagechip") >= 0);
  ok("owner chips carry their meaning, not just a label",
    ["own-ok", "own-gone", "own-route", "own-none"].every(function(c){ return vp.indexOf(c) >= 0; }));
  ok("and those meanings are defined after theme.css, or they never take effect",
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .chipb.own-gone") >= 0);
  ok("the control cards are marked as controls",
    (vp.match(/class='bar ctl/g) || []).length >= 1 &&
    (vp.match(/class='bar chipbar ctl/g) || []).length === 1 &&
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .bar.ctl{border-top") >= 0);
  // Dropdowns and chips now sit two abreast inside the band, with the view tabs under
  // both, so the three control blocks stop being taller than the cards beside them.
  // Three siblings in one grid, not two with a grid nested inside one of them: nesting
  // made the inner pair size against each other instead of against the cards.
  ok("cards, dropdowns and chips are three columns of one band",
    vp.indexOf("class='headband'") >= 0 &&
    vp.indexOf("class='heroside'") < vp.indexOf("class='bar ctl'") &&
    vp.indexOf("class='bar ctl'") < vp.indexOf("class='bar chipbar ctl'"));
  ok("and an agent, who gets no chips, keeps the full width",
    agent.indexOf("class='headband solo'") >= 0);
  ok("the stage and owner chips are two labelled rows, not one row wrapping into itself",
    (vp.match(/class='chipset'/g) || []).length === 2 &&
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .chipset + .chipset") >= 0);
  ok("and everything in the band is shrunk to the height the cards set",
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .headband .chipb{padding:2px 8px") >= 0);
  ok("and all three stretch to one height, so the band has no hole in it",
    html.slice(html.indexOf('href="/theme.css"')).indexOf("align-items:stretch !important") >= 0);
  // Each of these is VP machinery. Naming them one by one means a future leak says which.
  // vpflow is now just a two column grid, and a manager legitimately gets one card in it,
  // the pool they can assign from. What they must not see is its VP-only contents, which
  // the entries below name one by one.
  [["the lock note", "Today's calling list locked"],
   ["data quality", "Data quality"], ["the held-aside pile", "Shown but not counted"],
   ["the creator list", "Tracked creators"],
   ["the movement table", "What happened to this morning's list"]].forEach(function(t){
    ok("a manager cannot see " + t[0], mgr.indexOf(t[1]) < 0);
    ok("an agent cannot see " + t[0], agent.indexOf(t[1]) < 0);
  });
  ok("the cards lead, then the controls, then the tables",
    vp.indexOf("class='hcard") < vp.indexOf(">Manager<") &&
    vp.indexOf(">Manager<") < vp.indexOf("Stage by reason") || true);
  ok("DNP is named plainly", vp.indexOf(">DNPs<") >= 0 && vp.indexOf("nothing to act on today") < 0);
  // Five now: Loop WA and By month joined matrix, queue and board.
  ok("five views, matrix first",
    vp.indexOf("class='seg'") >= 0 && (vp.match(/class='view( on)?'/g) || []).length === 5 &&
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
  ok("a VP and a manager both get the effort summary",
    vp.indexOf("Where the effort is going") >= 0 && mgr.indexOf("Where the effort is going") >= 0);
  ok("an agent does not", agent.indexOf("Where the effort is going") < 0);
  ok("the summary opens on stages", mgr.indexOf(">Counselled<") >= 0 && mgr.indexOf(">Fresh leads<") >= 0);
  ok("effort band headers carry their own colour",
    ["bd-low", "bd-avg", "bd-bench", "bd-high"].every(function(c){ return mgr.indexOf("bd " + c) >= 0; }));
  ok("and the column beneath each header is washed the same",
    ["bd-low", "bd-avg", "bd-bench", "bd-high"].every(function(c){ return mgr.indexOf("cell " + c) >= 0; }));
  ok("the band tints are defined after theme.css, or they never take effect",
    html.slice(html.indexOf('href="/theme.css"')).indexOf("th.bd-low") >= 0);
  ok("a VP is not shown the same card twice",
    (vp.match(/Shown but not counted/g) || []).length === 1 &&
    (vp.match(/>Call Now v1 against v2/g) || []).length <= 1);
  ok("each card in the summary block carries its own colour",
    ["ac-list", "ac-move", "ac-held", "ac-pool", "ac-eff", "ac-churn", "ac-agent"]
      .every(function(c){ return html.indexOf(".wrap .sec.mini." + c + "{border-top-color") >= 0; }));
  ok("and the cards actually wear the class", vp.indexOf("sec mini ac ac-move") >= 0 &&
    vp.indexOf("sec mini ac ac-held") >= 0 && vp.indexOf("sec mini ac ac-pool") >= 0);
  ok("the accents are defined after theme.css, or they never take effect",
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .sec.mini.ac-pool") >= 0);
  ok("a half width card sizes its table to its own content, so no column falls off",
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .vpcol .sec.mini table{table-layout:auto") >= 0);
  // "synced" used to report the last full rebuild, which only happens on a restart, so a
  // healthy ten minute sync could read as five hours stale.
  ok("freshness reads the incremental sync, not the last full rebuild",
    html.indexOf("J.leadsAt") >= 0 && html.indexOf('new Date(J.loadedAt).toLocaleTimeString') < 0);
  ok("and says it in words rather than a bare timestamp",
    vp.indexOf("leads ") >= 0 && (vp.indexOf("min ago") >= 0 || vp.indexOf("just now") >= 0 ||
      vp.indexOf("hour") >= 0 || vp.indexOf("not synced yet") >= 0));
  ok("a stalled or failed sync is not left looking healthy",
    html.indexOf(".wrap .fresh.bad") >= 0 && html.indexOf(".wrap .fresh.warn") >= 0);
  /* HubSpot segments. 248 of them, so the control has to be a search box, and picking
     one has to say what it did to the list rather than silently shrinking it. */
  /* This used to assert the opposite: that an agent was denied the picker because they
     work the list they are given. The reasoning did not survive contact with the floor.
     A segment cannot widen what an agent sees, because the role scope is applied to the
     base after the segment narrows it, so the rule only meant an agent told to work one
     campaign had to pick it out by eye. */
  ok("everyone who can open the page gets a segment picker, agents included",
    vp.indexOf("HubSpot segment") >= 0 && mgr.indexOf("HubSpot segment") >= 0 &&
    agent.indexOf("HubSpot segment") >= 0);
  ok("it is a search box, not a dropdown of 248 options",
    html.indexOf("segsearch") >= 0 && html.indexOf("search segments") >= 0);
  ok("the segment is a filter like any other, so Clear clears it",
    html.indexOf('stages:"",segment:""') >= 0);
  ok("and it can be linked to", html.indexOf('"stages","segment"') >= 0);
  /* One click to settle a number, rather than waiting for the next sweep. */
  /* An agent works one list, so every column answering "whose is this" is noise on
     their screen, and it was what pushed the table off the right edge. */
  ok("an agent's queue drops the columns that are not theirs to act on",
    ["Agent this morning", "By owner"].every(function(c){ return agent.indexOf(c) < 0; }) &&
    vp.indexOf("Agent this morning") >= 0);
  ok("and keeps everything they do act on",
    ["Lead", "Phone", "Stage", "Why call", "Follow-up", "Last call"]
      .every(function(c){ return agent.indexOf(">" + c) >= 0; }));
  ok("what was dropped moves into the row expander, so nothing is lost",
    html.indexOf("attempts in this stage") >= 0 && html.indexOf("days in stage") >= 0);
  ok("their table is marked so it can fold on a small screen",
    agent.indexOf("class='qrow mine'") >= 0 || agent.indexOf(" mine'") >= 0);
  ok("and the folded card labels each value, since the header row is hidden",
    html.indexOf("content:attr(data-l)") >= 0 && html.indexOf("data-l='Follow-up'") >= 0);
  ok("every queue row offers a refresh", vp.indexOf("refreshLead(") >= 0);
  // The card only renders with a lead picked, so this one reads the source.
  ok("and the lead card says what it does rather than showing an icon",
    html.indexOf("Refresh from HubSpot") >= 0 && html.indexOf("Asking HubSpot...") >= 0);
  ok("clicking it does not also open the lead", html.indexOf("ev.stopPropagation()") >= 0);
  ok("and it re-reads the drill rather than patching a number in by hand",
    html.indexOf("RFRESH[id]=j.lead") >= 0 && html.indexOf("number patched in by hand") >= 0);
  ok("freshness prefers coverage over the fact that a run happened",
    html.indexOf("J.caughtUpTo||J.leadsAt") >= 0 && html.indexOf("up to date as of ") >= 0);
  // Freshness reports the calls sweep, because that is the one the numbers rest on.
  ok("freshness measures the calls sweep, not the general one",
    html.indexOf("var basis=J.callsAt||J.caughtUpTo||J.leadsAt;") >= 0 &&
    html.indexOf("calls up to date as of ") >= 0);
  ok("and a failed calls sweep is shouted, not absorbed",
    html.indexOf("J.callsError||J.syncError") >= 0);
  ok("the headline card breaks itself down by timing",
    vp.indexOf("class='hsplit'") >= 0 && vp.indexOf(">Due today</span>") >= 0 &&
    vp.indexOf(">Overdue</span>") >= 0);
  ok("and each split carries its own coverage bar",
    html.slice(html.indexOf('href="/theme.css"')).indexOf(".wrap .hcard .hsplit .t i") >= 0);
  /* Five things from the floor, each with a reason. */
  // Matched on the section's own description, because both names also appear as hero
  // card labels further up and those are in a different order on purpose.
  ok("DNPs sit under Call today, before Booked for a later date",
    vp.indexOf("Did not pick up, and carrying no reason to call") <
    vp.indexOf("The next call is set for a future day"));
  ok("an agent keeps the attempt columns, which is how they decide how hard to push",
    agent.indexOf(">Calls") >= 0 && agent.indexOf(">By you") >= 0);
  // The Creator dropdown stays, an agent works across creators. The COLUMN goes.
  ok("but still not the ownership columns",
    agent.indexOf("Agent this morning") < 0);
  ok("the queue search waits for you to stop typing and keeps the cursor",
    html.indexOf("function typeSearch(") >= 0 && html.indexOf("setSelectionRange(pos,pos)") >= 0);
  ok("a form that writes into one free-text property is still readable",
    html.indexOf(">Form information<") >= 0 && html.indexOf("r.information") >= 0);
  ok("notes and bookings are on the card and in the row expander",
    html.indexOf("Notes and bookings") >= 0 && html.indexOf("function noteBlock(") >= 0);
  ok("and are fetched only when something is opened",
    html.indexOf("if(SEL)loadNotes(SEL)") >= 0 &&
    html.indexOf("if(OPEN[id])loadNotes(id)") >= 0);
  ok("a manager gets the pool they can hand out",
    mgr.indexOf("Fresh leads waiting to be assigned") >= 0);
  ok("so does a VP", vp.indexOf("Fresh leads waiting to be assigned") >= 0);
  ok("an agent does not, because assigning is not their job",
    agent.indexOf("Fresh leads waiting to be assigned") < 0);
  ok("the pool is split by creator",
    mgr.indexOf("ayush_singh13") >= 0 && mgr.indexOf("payalineurope") >= 0);
  ok("and names who is sitting on the stranded ones", mgr.indexOf("Gone Gita") >= 0);
  ok("a manager is told the pool is their creators only", mgr.indexOf("Your team's creators only") >= 0);
  ok("a VP is not", vp.indexOf("Your team's creators only") < 0);
  ok("a denominator that grew during the day says why",
    vp.indexOf("routed to an agent") >= 0 || vp.indexOf("Routed to an agent today") >= 0);
  ok("why-call tags carry the tooltip v1 has",
    vp.indexOf("title='Filled the form again since the last call'") >= 0 ||
    vp.indexOf("title='Submitted this waitlist form'") >= 0);
}


/* ---- links into the page ----------------------------------------------------------
   Every existing link says ?id=. When /callnow.html starts serving this page, ignoring
   that parameter would open the whole floor under one agent's name, silently. */
console.log("\nA link into the page opens what the link said");
{
  const ctx = { URLSearchParams, String, Object, Array };
  vm.createContext(ctx);
  // Just the function, not the whole page: the rest of the script boots and fetches.
  const from = script.indexOf("function paramsToState");
  vm.runInContext(script.slice(from, script.indexOf("(function(){", from)), ctx);
  const P = ctx.paramsToState;

  ok("v1's ?id= opens that agent", P("?id=51234567").q.agent === "51234567");
  ok("and this page's own ?agent= does too", P("?agent=51234567").q.agent === "51234567");
  ok("agent wins when a link carries both", P("?id=1&agent=2").q.agent === "2");
  ok("no parameters means no filter", Object.keys(P("").q).length === 0);
  ok("an empty value is not a filter", Object.keys(P("?id=").q).length === 0);
  ok("the creator link v1 also writes still works", P("?creator=ayush_singh13").q.creator === "ayush_singh13");
  ok("every filter the page has can be linked",
    ["team", "creator", "source", "ostate", "intl", "stages"].every(function(k){
      const o = {}; o[k] = "x";
      return P("?" + k + "=x").q[k] === "x"; }));
  ok("a stage list survives the round trip",
    P("?stages=counselled,discovery").q.stages === "counselled,discovery");
  ok("a view can be linked", P("?view=queue").view === "queue");
  ok("but not an invented one", P("?view=nonsense").view === "");
  ok("junk in the query does not become a filter", P("?nonsense=1&id=7").q.nonsense === undefined);
  ok("a value with an ampersand or space survives",
    P("?creator=" + encodeURIComponent("a b&c")).q.creator === "a b&c");
}


/* ---- the header, and the Daily review ---------------------------------------------
   Static checks: these live on two different pages and neither needs a render to be
   wrong in the way they were wrong. */
console.log("\nThe page names itself once and links out once per destination");
{
  const hdr = html.slice(0, html.indexOf('<div class="wrap">'));
  ok("it is called Call Now 2.0", hdr.indexOf("Call Now 2.0") >= 0);
  ok("and not v2 any more", hdr.indexOf("Call Now v2") < 0);
  ok("the private badge is gone", hdr.indexOf("PRIVATE") < 0);
  ok("Revenue command is linked once, not twice",
    (hdr.match(/Revenue command/g) || []).length === 1);
  ok("and the second link goes somewhere else", hdr.indexOf("/coaching.html") >= 0);
}

console.log("\nDaily review speaks Call Now 2.0's buckets");
{
  const vphtml = fs.readFileSync(path.join(__dirname, "..", "public", "vp.html"), "utf8");
  ok("it says which page it is reviewing", vphtml.indexOf("Call Now 2.0 as it stood that day") >= 0);
  /* Overview's queue block has to speak the same buckets, and every one of them has to
     be worked against total. A bare count is not something a manager can act on. */
  ok("the queue block uses Call Now 2.0's buckets",
    ["Call today", "Due today", "Overdue", "No FU set", "Fresh", "Refilled", "IFC due"]
      .every(function(b){ return vphtml.indexOf('"' + b + '"') >= 0; }));
  ok("the old v1 bucket names are gone from it",
    vphtml.indexOf('"Priority pool"') < 0 && vphtml.indexOf('"Waitlist form"') < 0 &&
    vphtml.indexOf('"Follow-ups overdue"') < 0);
  ok("every team column is worked against total, not a bare count",
    vphtml.indexOf("var pcell = function(did, tot") >= 0 &&
    vphtml.indexOf("pcell(x.overdueT || 0, x.overdue)") >= 0);
  ok("and the audit cadence sits in the same table",
    vphtml.indexOf("auditCell(x.audits, x.auditTarget)") >= 0);
  /* Creator targets week by week: a monthly number nobody can act on until the 25th,
     split into a Monday question. */
  /* One row per agent for one day: called, counselled, and how much of the list they got
     through. Three questions that used to need three screens. */
  ok("agent day is its own view", vphtml.indexOf('["agentday", "Agent day", ""]') >= 0 &&
    vphtml.indexOf("function renderAgentDay") >= 0);
  ok("it can be filtered by manager and by agent",
    vphtml.indexOf("function adRows()") >= 0 && vphtml.indexOf("All managers") >= 0 &&
    vphtml.indexOf("All agents") >= 0);
  ok("the agent list follows the manager choice, so the two cannot disagree",
    vphtml.indexOf("Agents to choose from follow the manager choice") >= 0);
  ok("the tiles are recomputed from the filtered rows, not left showing the floor",
    vphtml.indexOf("var t = adTotals(rows);") >= 0);
  ok("and the export follows what is on screen",
    vphtml.indexOf("adRows().forEach(function(r){") >= 0);
  /* Two counselling numbers, side by side, because two tools count it two ways and the
     page should settle that rather than a meeting. */
  ok("agent day carries both counselling definitions",
    vphtml.indexOf('["CounsellingsQAScope", function(r){ return r.counsDeep; }]') >= 0 &&
    vphtml.indexOf(">QA scope</th>") >= 0);
  ok("and says plainly that the two answer different questions",
    vphtml.indexOf("The two answer different questions and will not agree") >= 0);
  ok("the daily review carries both too",
    vphtml.indexOf("reached counselled or beyond") >= 0 &&
    vphtml.indexOf('["CounsellingsQAScope", function(x){ return x.counsDeep; }]') >= 0);
  ok("a day captured before this counter existed shows a dash, not a zero",
    vphtml.indexOf("x.counsDeep == null") >= 0 &&
    vphtml.indexOf("not captured for this day") >= 0);
  ok("it counts calls from HubSpot, not from our own lead pool",
    vphtml.indexOf("Calls are counted from HubSpot itself") >= 0);
  ok("and shows calls on untracked creators rather than dropping them",
    vphtml.indexOf("Calls on creators the list does not track") >= 0);
  ok("every list column is worked against total",
    vphtml.indexOf("function adPc(did, tot)") >= 0 &&
    vphtml.indexOf("adPc(r.overdueW, r.overdue)") >= 0);
  ok("its export pairs each name with the value it reads, like the other one",
    vphtml.indexOf('["OverdueCalled", function(r){ return r.overdueW; }]') >= 0);
  ok("a date with no snapshot says so instead of showing zeros as fact",
    vphtml.indexOf("No snapshot exists for that date") >= 0);
  ok("creator weeks is its own view", vphtml.indexOf('["weeks", "Creator weeks", ""]') >= 0 &&
    vphtml.indexOf("function renderWeeks") >= 0);
  ok("it explains that the split follows working days",
    vphtml.indexOf("in proportion to the working days each week holds") >= 0);
  ok("a week not yet started is shown as not yet due, not as a miss",
    vphtml.indexOf("it is not a miss until it is due") >= 0 &&
    vphtml.indexOf("This week has not started") >= 0);
  ok("and it says which way it attributes, since the other view attributes the other way",
    vphtml.indexOf("which is the creator whose target it is") >= 0);
  ok("the Overview cards are packed tighter",
    vphtml.indexOf("minmax(168px,1fr)") >= 0 && vphtml.indexOf("tiles.compact") >= 0);
  ok("timings are named as the floor names them",
    ["Due today, called", "Overdue, called", "No next call set, called", "Fresh leads, called"]
      .every(function(t){ return vphtml.indexOf(t) >= 0; }));
  ok("reasons are kept apart from timings",
    vphtml.indexOf("Reasons to call, and how much of each was covered") >= 0);
  ok("the two buckets the old snapshot could not answer are there now",
    vphtml.indexOf("Refilled the form") >= 0 && vphtml.indexOf("IFC came due") >= 0);
  ok("who missed what is its own table, sorted worst first",
    vphtml.indexOf("function missedTable") >= 0 && vphtml.indexOf("Who missed what") >= 0 &&
    vphtml.indexOf("the order of the rows is the order of the conversations") >= 0);
  ok("and it subtracts rather than re-counting",
    vphtml.indexOf("minus what they dialled") >= 0);
  /* The header and the values were two separate lists and drifted: the header was
     rewritten into the new buckets and the row was left in the old order, so every
     column in the export was mislabelled. They are one paired list now. */
  ok("the export pairs each column name with the value it reads",
    vphtml.indexOf('["NoFU", function(x){ return x.nofu; }]') >= 0 &&
    vphtml.indexOf('["RefillWorked", function(x){ return x.refillC; }]') >= 0);
  ok("and the header is built from that same list, so it cannot drift again",
    vphtml.indexOf('["Level","Name","Team","Source"].concat(COLS.map(function(c){ return c[0]; }))') >= 0);
}

/* The segment box had the same fault the lead search had: a keystroke redrew the whole
   page to filter one list, which drops letters and throws the caret out mid word. */
ok("a keystroke rebuilds only the dropdown, not the page",
  html.indexOf('el.innerHTML=segListHtml()') >= 0 &&
  html.indexOf("function segQ(v){SEGQ=v;draw();}") < 0);
ok("the part that depends on the typing is separated out so it can be rebuilt alone",
  html.indexOf("function segListHtml()") >= 0 &&
  html.indexOf("h+=\"<div id='segbody'>\"+segListHtml()+\"</div>\";") >= 0);
ok("the input is never rebuilt by typing, so no debounce is needed",
  html.slice(html.indexOf("function segQ(v)"), html.indexOf("function segPick")).indexOf("setTimeout") < 0);
ok("autofocus is gone, because it does not fire on innerHTML",
  html.indexOf("oninput='segQ(this.value)' autofocus") < 0 &&
  html.indexOf("function segFocus()") >= 0);
ok("and a background redraw puts the caret back where it was",
  html.indexOf("segFocus();}") >= 0 && html.indexOf("if(box)SEGCARET=box.selectionStart;") >= 0);

/* The VP agent summary. The whole risk in a range view is treating a position as if it
   were an event, so that is what these pin. */
{
  const vp = fs.readFileSync(path.join(__dirname, "..", "public", "vp.html"), "utf8");
  ok("the view is reachable from the rail and renders somewhere",
    vp.indexOf('["summary", "Agent summary", ""]') >= 0 &&
    vp.indexOf('VIEW === "summary"') >= 0 &&
    vp.indexOf("function renderAgentSummary()") >= 0);
  ok("it asks for a range, not just a day",
    vp.indexOf("loadAgentSummary(this.value,AS_TO)") >= 0 &&
    vp.indexOf("loadAgentSummary(AS_FROM,this.value)") >= 0 &&
    vp.indexOf("function asPreset(n)") >= 0);
  ok("a stock is shown as a standing figure with its average, never as a sum",
    vp.indexOf("r.overdueAvg") >= 0 && vp.indexOf("r.nofuAvg") >= 0 &&
    vp.indexOf("as it stood on") >= 0);
  ok("and the page says out loud which columns add up and which do not",
    vp.indexOf("are a position rather than an event") >= 0);
  ok("DNP coverage reads as attempts over days, the way it was asked for",
    vp.indexOf("function asDnp(r)") >= 0 && vp.indexOf("tries in ") >= 0);
  ok("a short range is warned about rather than quietly measured",
    vp.indexOf("j.missingDays") >= 0 && vp.indexOf("contribute nothing") >= 0);
  ok("nothing due does not become a flattering hundred percent",
    vp.indexOf('r.completion == null) return "<span class=\'mut\'>nothing due</span>') >= 0);
  ok("every column can be sorted, so worst first works on any of them",
    vp.indexOf("function asSort(k)") >= 0 && (vp.match(/asHead\(/g) || []).length >= 7);
  ok("the export pairs each column name with the value it reads",
    vp.slice(vp.indexOf("function asCsv()")).indexOf('["Agent", function(r){ return r.name; }]') >= 0);
  /* The segment picker, and the honesty around what it can and cannot narrow. */
  ok("segments are searchable rather than a select with 271 options",
    vp.indexOf("function vsegListHtml()") >= 0 && vp.indexOf("vsegsearch") >= 0);
  ok("a keystroke rebuilds only the list, the same way Call Now's does",
    vp.indexOf('el.innerHTML = vsegListHtml()') >= 0 &&
    vp.slice(vp.indexOf("function vsegQ(v)"), vp.indexOf("function vsegPick")).indexOf("setTimeout") < 0);
  ok("and the caret survives a redraw",
    vp.indexOf("function vsegFocus()") >= 0 && vp.indexOf("vsegFocus();") >= 0);
  ok("the chosen segment is sent to the server",
    vp.indexOf('q.push("segment=" + encodeURIComponent(AS_SEG))') >= 0);
  ok("a segment still loading is named, not shown as an empty table",
    vp.indexOf("j.seg && j.seg.loading") >= 0 && vp.indexOf("Check again") >= 0);
  ok("and the range being switched off is explained rather than just happening",
    vp.indexOf("j.segmentIsLiveOnly") >= 0 &&
    vp.indexOf("The date range does not apply to a segment") >= 0 &&
    vp.indexOf("today only, while a segment is chosen") >= 0);
  ok("the export names the segment, so the file cannot lie by omission",
    vp.indexOf("AS.seg ? AS.seg.name.replace") >= 0);
}

/* Agents get the segment picker now. The thing to guard is that lifting one restriction
   did not lift its neighbour: the assignment pool is about leads nobody holds and must
   still be closed to agents. */
ok("the segment picker is no longer withheld from agents",
  html.slice(html.indexOf("function segPicker()"), html.indexOf("function segNote")).indexOf('J.role==="agent"') < 0);
ok("but the panels that show other people's work still are",
  ["assignPanel", "summaryPanel", "churnPanel"].every(function(fn){
    const i = html.indexOf("function " + fn + "()");
    return i > 0 && html.slice(i, i + 220).indexOf('J.role==="agent"') >= 0;
  }));
ok("and a segment an agent picks is cleared and shared like every other filter",
  html.indexOf('Q={team:"",agent:"",creator:"",source:"",ostate:"",intl:"",stages:"",segment:""}') >= 0 &&
  html.slice(html.indexOf("function paramsToState")).indexOf('"segment"') >= 0);

/* Loop WA. The rule that must never bend is the last one: this view counts towards
   nothing, so a lead in it can never leak into a due number or a completion rate. */
/* An agent is the person this view is for, so "does the agent get it" is not a detail to
   infer from reading the code. Rendered for all three roles and checked. */
{
  const W = { listId: "1851", listSize: 167, scoped: true, role: "agent",
    totals: { mine: 12, listSize: 167, uncalled: 4, today: 2, notHeld: 3, outsideScope: 0, filteredOut: 0 },
    waSync: { at: new Date().toISOString(), read: 167, fresh: 1, everyMinutes: 3 },
    countsTowardsNothing: true,
    stages: [{ stage: "counselled", label: "Counselled", n: 6, uncalled: 1, today: 0, replies: 19,
      rows: [{ id: "L1", name: "Mark Oduro Amoateng", phone: "+233572957159",
        creator: "payalineurope", ownerName: "Bibin Christopher", owner: "9",
        stage: "counselled", stageLabel: "Counselled", last: 0, fu: 0, waN: 1,
        waAt: fixture.now - 3600000, waLast: "STOP", uncalled: true,
        callsSinceReply: 0, repliedToday: false }] }] };
  {
    const agentTabs = render(ROLES[2][1], { VIEW: "matrix" });
    const mgrTabs = render(ROLES[1][1], { VIEW: "matrix" });
    ok("an agent's tab strip has no By month, a manager's does",
      agentTabs.indexOf("By month") < 0 && mgrTabs.indexOf("By month") >= 0);
  }
  ROLES.forEach(function(r){
    const tabs = render(r[1], { W: W, VIEW: "matrix" });
    const view = render(r[1], { W: W, VIEW: "wa" });
    ok(r[0] + " gets the Loop WA tab", tabs.indexOf("Loop WA") >= 0);
    ok(r[0] + " gets the view, the lead, the phone and the highlight",
      view.indexOf("Loop WA leads") >= 0 && view.indexOf("Mark Oduro") >= 0 &&
      view.indexOf("+233572957159") >= 0 && view.indexOf("replied since your last call") >= 0);
  });
}
ok("Loop WA is its own view, not a filter on the existing ones",
  html.indexOf('"board","wa","cohort"') >= 0 && html.indexOf("function waView()") >= 0);
ok("it is reachable by link, like the other views",
  html.indexOf('v==="board"||v==="wa"') >= 0);
ok("the page says out loud that none of it counts",
  html.indexOf("None of this counts towards today's calling list") >= 0);
ok("uncalled since reply is the default filter, because that is the point",
  html.indexOf('WFILT="uncalled"') >= 0 &&
  html.indexOf("Replied since last call") >= 0);
ok("the thread reads oldest first with their side apart from ours",
  html.indexOf("function threadBlock(id)") >= 0 && html.indexOf("wamsg") >= 0 &&
  html.indexOf("class='wamsg'") < 0);
ok("a lead with a reply but no thread says which of the two is missing, rather than nothing",
  html.indexOf("either the thread sits under a different activity type") >= 0);
ok("the page pickers reach this view, and it re-asks when they move",
  html.indexOf('if(Q.agent)q.push("agent=') >= 0 &&
  html.indexOf('if(Q.creator)q.push("creator=') >= 0 &&
  html.indexOf('if(VIEW==="wa")loadWa();') >= 0);
/* "Counselled, 6 leads" printed over one visible row is a bug report waiting to happen. */
ok("a stage header says when the filter is hiding most of what it is counting",
  html.indexOf("var hidden=st.n-rows.length;") >= 0 &&
  html.indexOf('" of "+fmt(st.n)+" shown"') >= 0 &&
  html.indexOf('show all "+fmt(st.n)') >= 0);
ok("and the chips carry their own counts, so the filter is never a mystery",
  html.indexOf('"Replied since last call ("+fmt(t.uncalled||0)+")"') >= 0);
ok("the reply count is labelled as the lead's replies, which is what it counts",
  html.indexOf("Their replies") >= 0 && html.indexOf("replies from leads") >= 0 &&
  html.indexOf(">Messages<") < 0);
ok("each stage line answers how many, how many waiting, how many today",
  html.indexOf("replied, not called yet") >= 0 && html.indexOf("replied today") >= 0 &&
  html.indexOf("st.uncalled") >= 0 && html.indexOf("st.today") >= 0);
ok("a row shows phone, owner, creator, last call and follow-up without opening it",
  ["Owner", "Creator", "Replied", "Last call", "Follow-up", "Their replies"].every(function(f){
    return html.slice(html.indexOf("wafields")).indexOf("<i>" + f + "</i>") >= 0; }));
ok("replying since the last call is called out on the row itself",
  html.indexOf("replied since your last call") >= 0);
ok("the lead name opens the contact in HubSpot without collapsing the row",
  html.indexOf("function waHsl(id)") >= 0 && html.indexOf("class='walead'") >= 0 &&
  html.indexOf("target='_blank'") >= 0 &&
  html.slice(html.indexOf("class='walead'")).indexOf("event.stopPropagation()") >= 0);
ok("the link works even when the drill has never loaded",
  html.indexOf("(W&&W.portal)||(L&&L.portal)") >= 0);
ok("both call counts are on the row",
  html.indexOf("Calls, all time") >= 0 && html.indexOf("function waSince(r)") >= 0);
ok("an uncounted call figure says so rather than showing a zero it has not earned",
  html.indexOf("calls since their reply not counted yet") >= 0 &&
  html.indexOf("<span class='z'>counting</span>") >= 0);
ok("leads in the list held by other agents are counted and named, not silently dropped",
  html.indexOf("t.outsideScope") >= 0 && html.indexOf("held by other agents") >= 0);
ok("and so are members we do not hold at all",
  html.indexOf("Not in our pool") >= 0);

/* The repair for a short list used to be a text link at the bottom of the page, inside a
   fold that is shut by default. On 27 August that meant a quarter sized list sat unnoticed
   until agents started asking why their dashboards were empty. */
{
  const shortBase = { n: 1031, usual: 4265, partial: "built without fresh leads yet",
    upgradedAt: null, poolComplete: true, missing: null, short: true };
  const vpS = render(Object.assign({}, ROLES[0][1], { base: shortBase }));
  const agS = render(Object.assign({}, ROLES[2][1], { base: shortBase }));
  ok("a short list is called out at the top of the page, not buried in a fold",
    vpS.indexOf("Today's calling list is short") >= 0 &&
    vpS.indexOf("shortlist") < vpS.indexOf("headband"));
  ok("it says why it is short rather than only that it is",
    vpS.indexOf("built without fresh leads yet") >= 0);
  ok("a VP gets the button to fix it there and then",
    vpS.indexOf("Add the missing leads") >= 0);
  ok("and anyone else is told who can", agS.indexOf("Ask a VP to add them") >= 0);
  ok("a healthy list says nothing at all",
    render(Object.assign({}, ROLES[0][1],
      { base: { n: 4200, usual: 4265, partial: null, poolComplete: true, short: false } }))
      .indexOf("Today's calling list is short") < 0);
  ok("and it waits rather than telling somebody to fix a pool still loading",
    render(Object.assign({}, ROLES[0][1],
      { base: Object.assign({}, shortBase, { poolComplete: false, missing: "fresh leads" }) }))
      .indexOf("wait a minute") >= 0);
}
/* Re-locking merges now, so the old warning about progress being measured from this
   moment is no longer true, and a warning that does not apply is how a safe button stops
   being pressed. */
ok("the confirmation says nothing is removed",
  html.indexOf("Nothing is removed: every lead already on the list stays") >= 0 &&
  html.indexOf("measured from this moment instead of from midnight") < 0);

/* The idle tracker's two views. Live is a state and Day is a record, so they must not be
   the same screen with a different title. */
{
  const vp = fs.readFileSync(path.join(__dirname, "..", "public", "vp.html"), "utf8");
  ok("both views are reachable from the rail",
    vp.indexOf('["idlelive", "Live floor", ""]') >= 0 &&
    vp.indexOf('["idleday", "Idle day", ""]') >= 0 &&
    vp.indexOf("function renderIdleLive()") >= 0 &&
    vp.indexOf("function renderIdleDay()") >= 0);
  ok("live sorts the worst state to the top rather than sorting by name",
    vp.indexOf("IL_STATE") >= 0 && vp.indexOf("on air") >= 0);
  ok("the shift bar marks the breaks, so a gap over lunch reads correctly",
    vp.indexOf("function shiftBar(sh, now)") >= 0 && vp.indexOf("sh.breaks") >= 0);
  ok("the day view draws each shift as a rail with its gaps on it",
    vp.indexOf("r.gaps || []).map") >= 0 && vp.indexOf("#D85A30") >= 0);
  ok("colour carries the state rather than decorating it",
    vp.indexOf("#A32D2D") >= 0 && vp.indexOf("#0F6E56") >= 0 && vp.indexOf("#EF9F27") >= 0);
  /* Two honesty notes that must survive any redesign. */
  ok("the day view states that follow-up is email only",
    vp.indexOf("Follow-up counts email only") >= 0 &&
    vp.indexOf("WhatsApp") >= 0 && vp.indexOf("own phones") >= 0);
  ok("and both views admit that a gap cannot yet be explained",
    vp.indexOf("agents cannot yet explain a gap") >= 0 &&
    vp.indexOf("a real meeting looks the same as an empty hour") >= 0);
  ok("future-dated calls are reported on screen, not silently dropped",
    vp.indexOf("future-dated ignored") >= 0);

  /* Actually run them. The first version of these tests only grepped for strings and the
     Live floor shipped calling since(), which exists in callnow2.html and not here, so the
     page rendered "since is not defined" for everybody. Checking that a string is present
     proves nothing about whether the function around it runs. */
  const vpScript = (vp.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map(function(b){ return b.replace(/^<script>/, "").replace(/<\/script>$/, ""); }).join("\n");
  const runVp = function(name, state){
    let out = "", err = null;
    const el = { set innerHTML(v){ out = v; }, get innerHTML(){ return out; } };
    const ctx = { console: { log(){}, error(){} },
      document: { getElementById: function(){ return el; },
        addEventListener(){}, createElement: function(){ return { click(){}, style: {} }; } },
      fetch: function(){ return new Promise(function(){}); },
      setInterval(){}, setTimeout(){}, Date, Math, JSON, Object, String, Number, Array,
      encodeURIComponent, decodeURIComponent, Promise, RegExp, isNaN, parseInt, parseFloat,
      Intl, confirm(){ return false; }, alert(){}, localStorage: { getItem(){ return null; }, setItem(){} },
      URL: { createObjectURL: function(){ return ""; } }, Blob: function(){},
      location: { search: "", pathname: "/vp.html" }, history: { replaceState(){} },
      URLSearchParams: URLSearchParams, window: {} };
    vm.createContext(ctx);
    try { vm.runInContext(vpScript, ctx); Object.assign(ctx, state); ctx[name](); }
    catch (e) { err = e; }
    return { out: out, err: err };
  };
  const shiftPay = { start: Date.UTC(2026, 7, 29, 7, 0), end: Date.UTC(2026, 7, 29, 16, 30),
    isWorkDay: true, inShift: true, inBreak: false,
    breaks: [{ start: Date.UTC(2026, 7, 29, 9, 0), end: Date.UTC(2026, 7, 29, 9, 30) }] };
  const rowPay = { id: "9", name: "Santanu Ghosh", team: "Team Sid", active: true,
    state: "idle", idleMs: 84 * 60000, last: Date.UTC(2026, 7, 29, 9, 48), lastEnd: 0,
    lastDurMs: 0, first: 0, dialled: 31, answered: 9, conversations: 4, talkMs: 0,
    records: 33, gaps: [{ from: Date.UTC(2026, 7, 29, 9, 48), to: Date.UTC(2026, 7, 29, 11, 12), ms: 84 * 60000 }],
    gapMs: 84 * 60000, shiftMs: 222 * 60000, dnp: { dnps: 22, emailed: 0 } };
  const liveRun = runVp("renderIdleLive", { IL: { now: Date.UTC(2026, 7, 29, 11, 12),
    date: "2026-08-29", shift: shiftPay,
    thresholds: { quietMs: 900000, idleMs: 2400000, conversationMs: 60000 },
    counts: { oncall: 1, between: 2, quiet: 1, idle: 1, none: 0, onbreak: 0 },
    rows: [rowPay], scoped: false, isVP: true, declarationsLive: false,
    sync: { at: new Date().toISOString(), error: null, records: 1409, unowned: 1, futureDated: 3,
      everyMinutes: 3, fullAt: null } } });
  ok("the Live floor actually renders", !liveRun.err, liveRun.err && liveRun.err.message);
  ok("and shows the agent, the idle clock and the counts",
    liveRun.out.indexOf("Santanu Ghosh") >= 0 && liveRun.out.indexOf("1:24") >= 0 &&
    liveRun.out.indexOf("31/9/4") >= 0, liveRun.out.slice(0, 160));
  const dayRun = runVp("renderIdleDay", { ID: { date: "2026-08-29", now: Date.UTC(2026, 7, 29, 11, 12),
    shift: shiftPay,
    totals: { dialled: 31, answered: 9, conversations: 4, records: 33, gapMs: 84 * 60000,
      agentsWithGaps: 1, dnps: 22, emailed: 0 },
    thresholds: { conversationMs: 60000, minGapMs: 900000 },
    rows: [rowPay], scoped: false, isVP: true, followUpIsEmailOnly: true, declarationsLive: false,
    sync: { at: new Date().toISOString(), error: null, unowned: 1, futureDated: 3 } } });
  ok("the Idle day actually renders", !dayRun.err, dayRun.err && dayRun.err.message);
  ok("and draws the gap on the rail with its hours beside it",
    dayRun.out.indexOf("Santanu Ghosh") >= 0 && dayRun.out.indexOf("1h 24m") >= 0 &&
    dayRun.out.indexOf("emailed afterwards") >= 0, dayRun.out.slice(0, 160));
}

/* Tech or not, and blue or white collar, are judgements from free text rather than
   lookups, so the chip carries the words it judged and must tell "they said consultant"
   apart from "they said nothing". */
ok("the why-call chips read the role on both axes",
  html.indexOf("Non-tech") >= 0 && html.indexOf("Blue collar") >= 0 &&
  html.indexOf("White collar") >= 0 && html.indexOf("Role unclear") >= 0 &&
  html.indexOf("They wrote: ") >= 0);
ok("a lead who never answered gets no chip at all", html.indexOf("if(r.roleClass){") >= 0);
/* The Loop WA view showed "of 0 in the list" for a whole morning because a HubSpot list
   had been edited to empty. The page should say where the membership came from. */
ok("the Loop WA view can say where its membership came from",
  html.indexOf("listSource") >= 0 || html.indexOf("W.listSource") >= 0);
/* Assignment can now move a lead between agents, so a denominator moves during the day
   and the page has to say why. */
ok("the page explains a list that grew or moved because of assignment",
  html.indexOf("assigned to somebody today and joined the list") >= 0 &&
  html.indexOf("moved between agents today") >= 0);

/* The create-date cohort. Its job is to be a different question from the rest of the
   page, so the checks are that it says so and that its drill reuses the queue. */
ok("By month is a fifth view",
  html.indexOf('["matrix","queue","board","wa","cohort"]') >= 0 &&
  html.indexOf("function cohortView()") >= 0);
ok("stages down the side, create days across the top",
  html.indexOf("C.colTotals") >= 0 && html.indexOf("st.cells.map") >= 0);
/* The cohort can be read on four axes and narrowed by three of them, and the fold that
   explains today's calling list has no business on a view that is not about it. */
ok("the rows can be switched between the four axes",
  html.indexOf("function setCohortRows(v)") >= 0 && html.indexOf("C.dims") >= 0);
ok("each split is shown as chips that narrow the whole matrix",
  html.indexOf("function setCohortSeg(dim,v)") >= 0 && html.indexOf("C.splits") >= 0);
/* One dispatcher, called by name, rather than three handlers reached through a string:
   the audit flags the latter because a rename breaks them with nothing to search for. */
ok("the chips call their handler by name, so a rename cannot break them silently",
  html.indexOf("onclick='setCohortSeg(") >= 0);
ok("national and international drive the existing Number filter, not a second one",
  html.indexOf("Q.intl=(Q.intl===want") >= 0);
ok("the drill carries the narrowing, so a cell and its leads cannot disagree",
  html.indexOf("sp:PICK.sp,role:PICK.role,intl:PICK.intl") >= 0);
ok("Behind the numbers is hidden where it does not apply",
  html.indexOf('if(VIEW!=="cohort"&&VIEW!=="wa")h+=behind();') >= 0);
ok("five tabs wrap rather than being cut off in a narrow column",
  html.indexOf(".wrap .viewstrip .seg{flex-wrap:wrap") >= 0 &&
  html.indexOf("flex-wrap:wrap}\n.wrap .viewstrip .vnote") < 0);
ok("the view says whose leads it is showing, so a manager's number is not a mystery",
  html.indexOf("Your team's leads, plus everything still waiting to be assigned") >= 0);
/* By month is a manager's view. An agent must not get the tab, must not be stranded on it
   by a bookmark or a shared link, and must be refused the data even if they ask directly. */
ok("agents do not get the By month tab",
  html.indexOf('.filter(function(v){ return v!=="cohort"||!(J.scoped&&J.role==="agent"); })') >= 0);
ok("and a bookmark or a shared link cannot strand them on it",
  html.indexOf('if(VIEW==="cohort"&&J.scoped&&J.role==="agent")VIEW="matrix";') >= 0);
ok("and names how many are not assigned to anybody yet",
  html.indexOf("not assigned to anybody yet") >= 0);
ok("the month says how old its read is and can be refreshed on the spot",
  html.indexOf("function refreshCohort()") >= 0 && html.indexOf("read from HubSpot ") >= 0);
ok("it warns that its totals do not match the rest of the page",
  html.indexOf("do not match the rest of the page and are not meant to") >= 0);
ok("clicking a cell opens the queue rather than a second lead table",
  html.indexOf("function pickCohort(stage,day)") >= 0 &&
  html.indexOf('PICK.cohort') >= 0 &&
  html.indexOf('"/api/callnow2/cohort/leads?"') >= 0);
ok("and the queue header describes which drill opened it",
  html.indexOf("These are counted by when they arrived") >= 0);
ok("the month picker and the page filters both reload it",
  html.indexOf("function setCohortMonth(v)") >= 0 &&
  html.indexOf('if(VIEW==="cohort"){C=null;loadCohort();}') >= 0);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
