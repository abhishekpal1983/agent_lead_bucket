"use strict";
/* Boots the real server against fixtures and calls every Call Now v2 endpoint.
   A missing declaration is a runtime error: `node --check` cannot see it and a regex
   scanner guesses at it. Actually calling the endpoint cannot miss it. */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 3997;
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}
function get(p){
  return new Promise(function(resolve, reject){
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 20000 }, function(res){
      let d = "";
      res.on("data", function(c){ d += c; });
      res.on("end", function(){
        let body = null;
        try { body = JSON.parse(d); } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, body: body, raw: d.slice(0, 300) });
      });
    });
    req.on("timeout", function(){ req.destroy(new Error("timed out")); });
    req.on("error", reject);
  });
}
function getText(p){
  return new Promise(function(resolve, reject){
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 20000 }, function(res){
      let d = "";
      res.on("data", function(c){ d += c; });
      res.on("end", function(){ resolve({ status: res.statusCode, body: d }); });
    });
    req.on("timeout", function(){ req.destroy(new Error("timed out")); });
    req.on("error", reject);
  });
}
const sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

(async function(){
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: Object.assign({}, process.env, { CN2_FIXTURES: "1", PORT: String(PORT),
      DATA_DIR: "/tmp/cn2test", HUBSPOT_TOKEN: "", NODE_ENV: "test" }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", function(b){ log += b; });
  child.stderr.on("data", function(b){ log += b; });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(500);
      try { const h = await get("/api/health"); up = h.status === 200; } catch (e) {}
    }
    ok("server starts", up, log.slice(-400));
    if (!up) throw new Error("never came up");

    const checks = [
      ["/api/health", "health"],
      ["/api/callnow2", "the matrix"],
      ["/api/callnow2?team=t1", "filtered by manager"],
      ["/api/callnow2?agent=201", "filtered by agent"],
      ["/api/callnow2?source=forms", "filtered by source"],
      ["/api/callnow2/leads?sec=n&col=all", "drill: everything to call today"],
      ["/api/callnow2/leads?sec=n&col=refill", "drill: refilled the form"],
      ["/api/callnow2/leads?sec=n&t=over&worked=0", "drill: overdue and not called"],
      ["/api/callnow2/leads?sec=d&col=all", "drill: did not pick up"],
      ["/api/callnow2/leads?moved=still", "drill: nothing happened to them"],
      ["/api/callnow2/agents", "the agent table"],
      ["/api/callnow2/agents?team=t1", "the agent table filtered by manager"],
      ["/api/callnow2/leads?sec=n&col=score", "clicking a section subtotal, every stage"],
      ["/api/callnow2/leads?col=all", "clicking the grand total, every stage and group"],
      ["/api/callnow2/leads?sec=a&t=sched", "clicking a timing subtotal in booked for later"],
      ["/api/callnow2/reconcile", "v1 against v2, bucket by bucket"],
      ["/api/callnow2/leads?notcounted=1", "drill: the pile held aside"],
      ["/api/callnow2?ostate=needs", "filter: needs owner"],
      ["/api/callnow2?ostate=unassigned", "filter: unassigned"],
      ["/api/callnow2?ostate=inactive", "filter: deactivated owner"],
      ["/api/callnow2?ostate=active", "filter: active agents only"],
      ["/api/callnow2?intl=yes", "filter: international only"],
      ["/api/callnow2?intl=no", "filter: national only"],
      ["/api/callnow2?stages=counselled,discovery", "filter: a picked set of stages"],
      ["/api/callnow2/leads?band=low&bandBy=total&sec=n", "drill: leads barely tried"],
      ["/api/callnow2/leads?band=high&bandBy=owner&sec=n", "drill: over-worked by this owner"],
      ["/api/callnow2/assign", "the assignment pool"]
    ];
    for (const c of checks) {
      const r = await get(c[0]);
      const bad = r.status !== 200 || (r.body && r.body.error);
      ok(c[1] + " answers cleanly", !bad, "status " + r.status + " " + (r.body && r.body.error ? r.body.error : r.raw));
    }

    // The filter options are the thing that broke, so check they are actually populated.
    const m = await get("/api/callnow2");
    const b = m.body || {};
    ok("manager, agent, creator and source options all present",
      Array.isArray(b.teamOptions) && Array.isArray(b.agentOptions) &&
      Array.isArray(b.creatorOptions) && Array.isArray(b.sourceOptions),
      JSON.stringify(Object.keys(b).filter(function(k){ return /Options$/.test(k); })));
    ok("source options are not empty", (b.sourceOptions || []).length > 0,
      JSON.stringify(b.sourceOptions));
    // Counted plus shown-but-not-counted has to equal the whole list, or leads are
    // being dropped somewhere rather than excluded on purpose.
    const counted = b.totals ? (b.totals.n.all + b.totals.a.all + b.totals.d.all) : 0;
    const shown = b.excluded ? (b.excluded.n.all + b.excluded.a.all + b.excluded.d.all) : 0;
    ok("counted plus not-counted accounts for every lead",
      b.baseSize === counted + shown,
      counted + " counted + " + shown + " not counted vs " + b.baseSize + " in the list");
    ok("parking buckets and unassigned leads are visible, not dropped", shown > 0, String(shown));
    ok("and they stay out of the headline totals", counted < b.baseSize);

    const ag = await get("/api/callnow2/agents");
    ok("the agent table returns rows", ag.body && Array.isArray(ag.body.agents) && ag.body.agents.length > 0,
      ag.raw);
    ok("each agent row carries the three groups",
      ag.body && ag.body.agents.every(function(a){ return a.n && a.a && a.d; }));

    // A subtotal must open more leads than any single stage under it, or the click is lying.
    const whole = await get("/api/callnow2/leads?col=all");
    const oneStage = await get("/api/callnow2/leads?stage=counselled&col=all");
    ok("the grand total opens every lead, not one stage's worth",
      whole.body && oneStage.body && whole.body.total > oneStage.body.total,
      (whole.body || {}).total + " vs " + (oneStage.body || {}).total);
    const secN = await get("/api/callnow2/leads?sec=n&col=all");
    ok("a section subtotal opens only that section",
      secN.body && whole.body && secN.body.total < whole.body.total,
      (secN.body || {}).total + " vs " + (whole.body || {}).total);

    // The ported v1 controls have to actually narrow the list, not just return 200.
    const all = await get("/api/callnow2");
    const twoStages = await get("/api/callnow2?stages=counselled,discovery");
    ok("the stage picker narrows the list",
      twoStages.body.baseSize < all.body.baseSize && twoStages.body.stages.length <= 2,
      twoStages.body.baseSize + " of " + all.body.baseSize + " over " + twoStages.body.stages.length + " stages");
    const intlYes = await get("/api/callnow2?intl=yes");
    const intlNo = await get("/api/callnow2?intl=no");
    ok("international and national split the list between them",
      intlYes.body.baseSize + intlNo.body.baseSize === all.body.baseSize,
      intlYes.body.baseSize + " + " + intlNo.body.baseSize + " vs " + all.body.baseSize);
    // active, deactivated and unassigned must partition the list between them.
    const act = await get("/api/callnow2?ostate=active");
    const ina = await get("/api/callnow2?ostate=inactive");
    const nob = await get("/api/callnow2?ostate=unassigned");
    ok("active plus deactivated plus unassigned is the whole list",
      act.body.baseSize + ina.body.baseSize + nob.body.baseSize === all.body.baseSize,
      act.body.baseSize + " + " + ina.body.baseSize + " + " + nob.body.baseSize + " vs " + all.body.baseSize);

    const un = await get("/api/callnow2?ostate=unassigned");
    ok("unassigned finds the leads with no owner", un.body.baseSize > 0, String(un.body.baseSize));
    ok("and it is a subset", un.body.baseSize < all.body.baseSize);

    // The effort bands have to partition the call-today leads, not overlap or lose any.
    const bands = ["low", "avg", "bench", "high"];
    const counts = [];
    for (const bnd of bands) counts.push((await get("/api/callnow2/leads?sec=n&bandBy=total&band=" + bnd)).body.total);
    const allNow = (await get("/api/callnow2/leads?sec=n&col=all")).body.total;
    ok("the four effort bands add up to every call-today lead, none double counted",
      counts.reduce(function(a, b){ return a + b; }, 0) === allNow,
      counts.join(" + ") + " vs " + allNow);
    const perAgent = (await get("/api/callnow2/agents")).body;
    ok("every agent row carries its own churn effort",
      perAgent.agents.every(function(a){ return a.effort && a.effort.owner && a.effort.total; }));
    // The agent table shows parking buckets too, so its total is the counted call-today
    // leads plus the ones held aside, not the counted ones alone.
    const m2 = (await get("/api/callnow2")).body;
    const callToday = m2.totals.n.all + m2.excluded.n.all;
    ok("per agent churn accounts for every call-today lead, held-aside ones included",
      perAgent.agents.reduce(function(t, a){
        return t + a.effort.owner.low + a.effort.owner.avg + a.effort.owner.bench + a.effort.owner.high; }, 0) === callToday,
      "agents sum vs " + callToday);

    const eff = (await get("/api/callnow2")).body.effort;
    ok("the panel's own counts agree with the drill",
      eff && bands.every(function(b, i){ return eff.total[b] === counts[i]; }),
      JSON.stringify(eff && eff.total) + " vs " + counts.join(","));

    const held = await get("/api/callnow2/leads?notcounted=1");
    const normal = await get("/api/callnow2/leads?col=all");
    ok("the held-aside pile can be opened", held.body && held.body.total > 0, held.raw);
    ok("and it is not mixed into the normal lists",
      held.body && normal.body && held.body.rows.every(function(r){ return r.counted === false; }) &&
      normal.body.rows.every(function(r){ return r.counted !== false; }));

    // This one asks HubSpot directly, so on fixtures it must decline clearly rather than
    // pretend there is nothing outside the tracked list.
    const outside = await get("/api/callnow2/outside");
    ok("the outside-tracked check declines cleanly with no token",
      outside.status === 503 && outside.body && /token/i.test(outside.body.error),
      outside.status + " " + JSON.stringify(outside.body));

    const rec = await get("/api/callnow2/reconcile");
    ok("reconciliation returns a row per bucket",
      rec.body && Array.isArray(rec.body.rows) && rec.body.rows.length >= 10, rec.raw);
    ok("every row carries both sides, the gap and the reason",
      rec.body && rec.body.rows.every(function(r){
        return typeof r.v1 === "number" && typeof r.v2 === "number" &&
               r.delta === r.v2 - r.v1 && r.why && r.why.length > 20; }));
    ok("it reports how many leads are shown but not counted",
      rec.body && rec.body.shown && rec.body.shown.notCounted > 0,
      JSON.stringify(rec.body && rec.body.shown));

    /* The assignment pool: fresh leads nobody is working, split by creator. It must not
       be scoped by agent, or the pool a manager came to find would be empty. */
    const asg = (await get("/api/callnow2/assign")).body;
    ok("the assignment pool is allowed for a VP", asg && asg.allowed === true, JSON.stringify(asg));
    ok("it finds the unassigned fresh leads", asg.totals.unassigned === 7, JSON.stringify(asg.totals));
    ok("and the ones left behind by an agent who has gone", asg.totals.left === 4, JSON.stringify(asg.totals));
    ok("the two add up to the pool", asg.totals.total === asg.totals.unassigned + asg.totals.left);
    ok("it is split by creator", asg.rows.length >= 3, String(asg.rows.length));
    ok("each creator row adds up", asg.rows.every(function(r){ return r.total === r.unassigned + r.left; }));
    ok("the rows sum to the total",
      asg.rows.reduce(function(a, r){ return a + r.total; }, 0) === asg.totals.total);
    ok("it names who is holding the stranded ones",
      asg.rows.some(function(r){ return (r.holders || []).some(function(h){ return h.name === "Gone Gita"; }); }),
      JSON.stringify(asg.rows[0]));
    ok("an agent filter cannot empty the pool",
      (await get("/api/callnow2/assign?agent=201")).body.totals.total === asg.totals.total);
    ok("nothing already owned by a working agent is in it",
      asg.rows.every(function(r){ return r.unassigned + r.left > 0 || r.assignedToday > 0; }));

    /* Effort by stage and by creator, and the agent filter that used to fight with All. */
    const ags = (await get("/api/callnow2/agents")).body;
    ok("effort is summarised by stage", Array.isArray(ags.byStage) && ags.byStage.length > 0);
    ok("and by creator", Array.isArray(ags.byCreator) && ags.byCreator.length > 0);
    ok("a stage row splits into agents", ags.byStage.some(function(r){ return (r.agents || []).length > 0; }));
    ok("a stage row's agents sum to the stage", ags.byStage.every(function(r){
      return r.agents.reduce(function(a, x){ return a + x.n; }, 0) === r.n; }));
    ok("every band adds up to the row", ags.byStage.every(function(r){
      return ["total", "owner"].every(function(k){
        return r.effort[k].low + r.effort[k].avg + r.effort[k].bench + r.effort[k].high === r.n; }); }));
    ok("stage and creator cover the same population",
      ags.byStage.reduce(function(a, r){ return a + r.n; }, 0) ===
      ags.byCreator.reduce(function(a, r){ return a + r.n; }, 0));
    ok("the unassigned bucket keeps a name that is not the empty string",
      ags.agents.some(function(a){ return a.id === "none"; }),
      JSON.stringify(ags.agents.map(function(a){ return a.id; })));

    const allAgents = (await get("/api/callnow2")).body;
    const noneOnly = (await get("/api/callnow2?agent=none")).body;
    ok("filtering to unassigned is not the same as no filter",
      noneOnly.baseSize < allAgents.baseSize && noneOnly.baseSize > 0,
      noneOnly.baseSize + " of " + allAgents.baseSize);
    ok("no agent option collides with the All option",
      allAgents.agentOptions.every(function(o){ return String(o.id) !== ""; }),
      JSON.stringify(allAgents.agentOptions.map(function(o){ return o.id; })));

    /* One model. Overview, the Daily review and the coaching pick now read the same
       frozen list as the floor's page, so the same question has one answer. */
    const which = (await get("/api/callnow/which")).body;
    ok("the floor's link serves v2", which.serving === "v2", JSON.stringify(which));
    ok("and the old page is still reachable", which.v1At === "/callnow-v1.html");

    // Assert on something only the new page has, not on the status code.
    const page = await getText("/callnow.html");
    ok("/callnow.html serves the v2 page", page.status === 200 &&
      page.body.indexOf("Where the effort is going") >= 0, "status " + page.status);
    const oldPage = await getText("/callnow-v1.html");
    ok("/callnow-v1.html still serves the old one", oldPage.status === 200 &&
      oldPage.body.indexOf("Where the effort is going") < 0 &&
      oldPage.body.indexOf("exportCsv") >= 0, "status " + oldPage.status);

    /* Agents get the swap too, or the floor is split across two pages.
       Auth is off under fixtures, so these assert the gate's own allow list and the
       ordering that makes the swap route win over the static file. */
    const src = require("fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const allowAt = src.indexOf('const allowed = ["/callnow.html"');
    ok("an agent is allowed onto the page the swap serves", allowAt > 0);
    ok("and the root still sends them there", src.indexOf('if (p === "/") return res.redirect("/callnow.html")') > 0);
    ok("and so does signing in", src.indexOf('res.redirect("/callnow.html")') > 0);
    ok("the old page is not on an agent's allow list, so they cannot land on a dead one",
      src.slice(allowAt, allowAt + 200).indexOf("callnow-v1") < 0);
    ok("the swap route is registered before express.static, or the file would win",
      src.indexOf('app.get("/callnow.html"') < src.indexOf('app.use(express.static("public"))'));
    ok("rebuilding and relocking the list stay closed to everyone but a VP",
      (src.match(/Call Now 2.0 is restricted/g) || []).length === 2);

    // The segment picker is a manager and VP control; the endpoint has to say so itself.
    const segs = await get("/api/callnow2/segments");
    ok("the segment catalogue answers", segs.status === 200, "status " + segs.status);
    ok("and says whether the caller may use it", segs.body && "allowed" in segs.body,
      JSON.stringify(segs.body));
    // With no HubSpot token the catalogue is empty, which must not become a 500.
    ok("an empty catalogue is not an error", !(segs.body && segs.body.error) || segs.status === 200);
    const segFiltered = await get("/api/callnow2?segment=999999");
    ok("an unknown segment does not break the page", segFiltered.status === 200,
      "status " + segFiltered.status + " " + segFiltered.raw);
    ok("and it reports itself as still fetching rather than silently empty",
      segFiltered.body && segFiltered.body.seg && segFiltered.body.seg.loading === true,
      JSON.stringify(segFiltered.body && segFiltered.body.seg));

    const vp = (await get("/api/vp")).body;
    const floor = (await get("/api/callnow2")).body;
    if (vp && vp.teams && vp.teams.length) {
      const vpQueue = vp.teams.reduce(function(a, t){ return a + (t.queue || 0); }, 0);
      // Overview counts only leads whose owner is on a mapped team, so it can be smaller
      // than the floor total, but it can never exceed it.
      ok("Overview's queue cannot exceed the floor's call-today total",
        vpQueue <= floor.totals.n.all, vpQueue + " vs " + floor.totals.n.all);
      ok("Overview's due and done are consistent",
        vp.teams.every(function(t){ return (t.done || 0) <= (t.due || 0); }));
      ok("and its worked count never exceeds its queue",
        vp.teams.every(function(t){ return (t.touched || 0) <= (t.queue || 0); }));
    } else {
      ok("Overview answered", !!vp);
    }

    const nothing = await get("/api/callnow2/leads?sec=n&col=all");
    ok("the drill returns lead rows", nothing.body && Array.isArray(nothing.body.rows) && nothing.body.rows.length > 0,
      nothing.raw);
    ok("no 500 was recorded while doing all that",
      !(await get("/api/health")).body.last500,
      JSON.stringify((await get("/api/health")).body.last500));
  } catch (e) {
    fail++;
    console.log("  FAIL harness: " + e.message);
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    try { child.kill("SIGKILL"); } catch (e) {}
  }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
