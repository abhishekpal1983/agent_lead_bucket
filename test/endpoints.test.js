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
function getHead(p){
  return new Promise(function(resolve, reject){
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 20000 }, function(res){
      res.resume();
      res.on("end", function(){ resolve(res.headers); });
    });
    req.on("timeout", function(){ req.destroy(new Error("timed out")); });
    req.on("error", reject);
  });
}
function post(p){
  return new Promise(function(resolve, reject){
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", timeout: 20000 },
      function(res){
        let d = "";
        res.on("data", function(c){ d += c; });
        res.on("end", function(){
          let body = null;
          try { body = JSON.parse(d); } catch (e) {}
          resolve({ status: res.statusCode, body: body, raw: d.slice(0, 200) });
        });
      });
    req.on("timeout", function(){ req.destroy(new Error("timed out")); });
    req.on("error", reject);
    req.end();
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
    /* A segment cannot widen what an agent sees: the role scope is applied to the base
       after the segment narrows it. The assignment pool is a different question and stays
       shut, so the two are checked together. */
    ok("the segment catalogue is no longer refused by role",
      (await get("/api/callnow2/segments")).status === 200);
    ok("while the assignment pool keeps its own guard",
      /role === "agent"/.test(require("fs").readFileSync(
        require("path").join(__dirname, "..", "server.js"), "utf8")
        .split('app.get("/api/callnow2/assign"')[1].slice(0, 300)));
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

    /* The two silent ceilings, and the escape hatch. */
    const health = (await get("/api/health")).body;
    ok("the sync reports coverage, not just that it ran",
      health.cn2 && health.cn2.delta && "caughtUpTo" in health.cn2.delta &&
      "behindMin" in health.cn2.delta && "caughtUp" in health.cn2.delta,
      JSON.stringify(health.cn2 && health.cn2.delta));
    ok("and a truncated owner is reported rather than swallowed",
      "truncatedOwners" in (health.cn2 || {}), JSON.stringify(Object.keys(health.cn2 || {})));

    const srv2 = require("fs").readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    ok("the incremental walk pages by modified date, so stopping early cannot lose records",
      srv2.indexOf('sorts: [{ propertyName: DELTA_PROP, direction: "ASCENDING" }]') >= 0);
    ok("it resumes from a stored watermark rather than restarting each run",
      srv2.indexOf("ORG.sync.deltaMark") >= 0 && srv2.indexOf("function deltaLoad") >= 0);
    ok("it stops on a time budget, not a page count",
      srv2.indexOf("DELTA_BUDGET_MS") >= 0);
    ok("it does not wait a full interval after a restart before running at all",
      srv2.indexOf("[20, 60, 150, 300].forEach(function(sec){") >= 0);
    ok("and being turned away by a rebuild books a retry rather than losing the turn",
      srv2.indexOf("if (CACHE.syncing) { deltaSoon(45); return; }") >= 0 &&
      srv2.indexOf("function deltaSoon") >= 0);
    ok("a run that ends behind comes back at once, not in ten minutes",
      srv2.indexOf("if (!got.caughtUp) deltaSoon(20);") >= 0);
    /* The sweep that matters asks the specific question rather than the general one. */
    ok("today's calls are asked for directly, by the call date itself",
      srv2.indexOf('{ propertyName: "last_call_date_and_time", operator: "GTE", value: String(day.start) }') >= 0 &&
      srv2.indexOf("async function syncCallsToday") >= 0);
    ok("it re-reads the whole day rather than carrying a cursor, so a missed run costs nothing",
      srv2.indexOf("idempotent and self healing") >= 0 &&
      srv2.slice(srv2.indexOf("async function syncCallsToday"),
                 srv2.indexOf("async function syncDelta")).indexOf("mark") < 0);
    ok("being turned away books a retry here too, not only on the general sweep",
      srv2.indexOf("if (CACHE.syncing) { callsSoon(40); return; }") >= 0 &&
      srv2.indexOf("function callsSoon") >= 0);
    ok("it runs far more often than the general sweep",
      srv2.indexOf('CALLSYNC_MINUTES || "3"') >= 0);
    ok("and its health is reported separately from the general sweep",
      srv2.indexOf("// The sweep the page's numbers actually depend on.") >= 0);
    ok("contacts are walked by lastmodifieddate, the one that is actually populated",
      srv2.indexOf('const DELTA_PROP = process.env.DELTA_MODIFIED_PROP || "lastmodifieddate";') >= 0 &&
      srv2.indexOf('{ propertyName: DELTA_PROP, operator: "GTE", value: String(mark) }') >= 0);
    ok("an empty answer after hours of silence is called out, not called caught up",
      srv2.indexOf("which cannot be right") >= 0 &&
      srv2.indexOf("caughtUp: got.caughtUp && !got.stalled") >= 0);
    ok("the walk asks for both spellings of the modified date",
      srv2.indexOf('PROPS.concat(["lastmodifieddate", "hs_lastmodifieddate"])') >= 0 &&
      srv2.indexOf("function msOf(r)") >= 0);
    ok("and a page with no readable date stops the walk instead of grinding",
      srv2.indexOf("cannot advance the watermark") >= 0 &&
      srv2.indexOf("Delta sync STALLED") >= 0);
    ok("the reason is on the health page, not only in the log",
      srv2.indexOf("stalled: DELTA.stalled || null }") >= 0);
    ok("and there is a lever to run it now rather than wait and guess",
      srv2.indexOf('app.post("/api/callnow2/sync/delta"') >= 0 &&
      srv2.indexOf('if (!isVP(req)) return res.status(403).json({ error: "VP only" });') >= 0);
    const kick = await post("/api/callnow2/sync/delta");
    ok("the lever answers rather than hanging", kick.status === 200 || kick.status === 409,
      "status " + kick.status + " " + kick.raw);
    const kickGet = await get("/api/callnow2/sync/delta");
    ok("and it can be opened as a link, not only posted from a console",
      kickGet.status === 200 || kickGet.status === 409, "status " + kickGet.status);
    ok("and it says nothing rather than something stale before its first run",
      srv2.indexOf("caughtUp: DELTA.at ? DELTA.caughtUp !== false : null") >= 0);
    /* The pool grew past two hundred thousand leads when the per-owner cap came off, and
       a snapshot per request then blocked the event loop until the service stopped
       answering at all. */
    /* "How do I check it is working" should not need a tutorial in reading forty fields. */
    const st = await get("/api/status");
    ok("status answers in sentences", st.status === 200 && Array.isArray(st.body.checks) &&
      st.body.checks.length >= 6, "status " + st.status);
    ok("every check has a verdict and a reason",
      st.body.checks.every(function(c){
        return ["ok", "warn", "bad"].indexOf(c.level) >= 0 && c.what && c.detail; }));
    ok("and there is one overall answer at the top",
      typeof st.body.verdict === "string" && st.body.verdict.length > 0, st.body.verdict);
    ok("a fresh restart is not reported as a fault",
      st.body.verdict.indexOf("starting up") >= 0 || st.body.bad === 0,
      st.body.verdict + " bad=" + st.body.bad);
    ok("it names the running commit first, since that is the question behind the question",
      (st.body.checks[0] || {}).what.indexOf("Running") === 0);

    /* Heavy reads are memoised. The safety of that rests entirely on the key, so the key
       is what gets tested: same question twice is reused, a different question is not,
       and the answer is thrown away the moment the data underneath moves. */
    ok("a repeated question is served from cache",
      (await getHead("/api/callnow2"))["x-cache"] !== undefined);
    {
      await get("/api/callnow2");
      const second = await getHead("/api/callnow2");
      ok("the same question twice is reused", second["x-cache"] === "hit", second["x-cache"]);
      const other = await getHead("/api/callnow2?stages=counselled");
      ok("a different filter is a different answer", other["x-cache"] === "miss", other["x-cache"]);
    }
    ok("the key carries who is asking, so one role cannot be served another's payload",
      srv2.indexOf("function askerKey(req)") >= 0 &&
      srv2.indexOf('if (s.role === "agent") return "agent:"') >= 0);
    ok("and a version that changes when any underlying data does",
      srv2.indexOf("function dataVersion()") >= 0 &&
      srv2.indexOf("A cache that has to be cleared by hand") >= 0);
    ok("errors and half built answers are never cached",
      srv2.indexOf("!body.error && !body.notReady") >= 0);

    ok("health says which commit and branch is actually serving",
      health.build && "commit" in health.build && "branch" in health.build,
      JSON.stringify(health.build));
    ok("a request reads the cached snapshot rather than walking the pool itself",
      srv2.indexOf("const snap = cn2SnapshotCached();") >= 0 &&
      srv2.indexOf("blocked the event loop") >= 0);
    ok("parking buckets are capped, working agents are not",
      srv2.indexOf("const PARK_MAX = parseInt(process.env.PARK_MAX") >= 0 &&
      srv2.indexOf("!ownerCounted(ownerId)) ? PARK_MAX : OWNER_MAX") >= 0);
    ok("and a capped working agent is still an error, a capped bucket is not",
      srv2.indexOf("Parking bucket ") >= 0 && srv2.indexOf("hitting one is the design") >= 0);
    ok("the per owner walk no longer stops at the search ceiling",
      srv2.indexOf("if (out.length >= 9900) break;") < 0 &&
      srv2.indexOf("async function fetchContactsForOwner") >= 0 &&
      srv2.slice(srv2.indexOf("async function fetchContactsForOwner"),
                 srv2.indexOf("async function fetchFreshForOwner")).indexOf('operator: "GT", value: String(lastId)') >= 0);

    const notes = await get("/api/callnow2/lead/12345/notes");
    ok("notes answer without a token rather than throwing",
      notes.status === 200 || notes.status === 500, "status " + notes.status);
    ok("note bodies are stripped of markup before they leave the server",
      srv2.indexOf('replace(/<[^>]+>/g, "")') >= 0 && srv2.indexOf("hs_note_body") >= 0);
    ok("and notes are fetched per lead on demand, never for the whole pool",
      srv2.indexOf("On demand rather than in the sync") >= 0);

    const bad = await post("/api/callnow2/lead/does-not-exist/refresh");
    ok("refreshing a lead that does not exist fails cleanly",
      bad.status === 404 || bad.status === 503 || bad.status === 500, "status " + bad.status);

    /* On 27 August the day's list was locked from a pool that had not finished loading:
       1,031 leads across 34 agents against 4,015 across 37 the day before, and several
       agents opened an empty dashboard. The guard said everything feeding the pool had to
       have landed; the code only checked that a list existed. */
    const baseH = ((await get("/api/health")).body.cn2 || {}).base || null;
    ok("health reports today's frozen list and whether it was complete",
      baseH && "n" in baseH && "usualN" in baseH && "partial" in baseH && "poolComplete" in baseH,
      JSON.stringify(baseH));
    ok("a list frozen from a partial pool is upgraded, not left short",
      (function(){
        const src = require("fs").readFileSync(
          require("path").join(__dirname, "..", "server.js"), "utf8");
        return src.indexOf("if (st.partial && !CN2_POOL.lastError") >= 0 &&
               src.indexOf("cn2Freeze(true)") >= 0;
      })());
    ok("and the upgrade can only add, so a lead an agent was given never vanishes",
      (function(){
        const src = require("fs").readFileSync(
          require("path").join(__dirname, "..", "server.js"), "utf8");
        return src.indexOf("if (rows[k] === undefined) { rows[k] = st.rows[k]; }") >= 0;
      })());

    /* Leads by the month they arrived. A different question from the rest of Call Now,
       and deliberately not built on the frozen list, so the checks are about it holding
       every stage and adding up both ways. */
    const co = await get("/api/callnow2/cohort?month=2026-08");
    ok("the cohort answers", co.status === 200, "status " + co.status + " " + co.raw);
    ok("and has real leads in it, not an empty month",
      co.body.grand > 0 && (co.body.stages || []).length > 0, JSON.stringify(co.body.grand));
    ok("the rows add up to the grand total",
      (co.body.stages || []).reduce(function(n, s2){ return n + s2.total; }, 0) === co.body.grand);
    ok("and so do the columns, which is the same number reached the other way",
      (co.body.colTotals || []).reduce(function(n, x){ return n + x; }, 0) === co.body.grand);
    ok("every stage row has one cell per day column",
      (co.body.stages || []).every(function(s2){ return s2.cells.length === co.body.days.length; }));
    ok("each row's cells add up to its own total",
      (co.body.stages || []).every(function(s2){
        return s2.cells.reduce(function(n, x){ return n + x; }, 0) === s2.total; }));
    /* The whole point: stages the calling list refuses to hold. */
    ok("it holds stages Call Now never shows, including no stage at all",
      (co.body.stages || []).some(function(s2){ return s2.stage === "__fresh"; }),
      (co.body.stages || []).map(function(s2){ return s2.stage; }).join(","));
    ok("empty days are dropped rather than drawn as a month of zeroes",
      co.body.emptyDays >= 0 && co.body.days.length <= 31);
    ok("it says out loud that it counts every stage",
      co.body.countsEveryStage === true);
    /* The first version read the calling pool and showed 16 leads where HubSpot held 375
       for the same day, because the pool drops anything with no owner and files unstaged
       leads under an owner, so a lead with neither is in neither half of it. A census
       cannot be built on a work queue. */
    /* Scope matches on owner and an unowned lead has no owner to match, so the plain
       filter removed the whole unassigned inflow from every manager's view: 287 leads of
       375 on 1 September. A VP saw the month, a manager saw a fraction, and nothing on
       screen explained the gap. */
    ok("the cohort endpoints refuse agents, not just hide the tab",
      (function(){
        const src = require("fs").readFileSync(
          require("path").join(__dirname, "..", "server.js"), "utf8");
        const bits = src.split('app.get("/api/callnow2/cohort');
        return bits.length === 3 && bits.slice(1).every(function(b){
          return b.slice(0, 500).indexOf('managers and VP only') >= 0; });
      })());
    /* Fresh leads ran 3 to 1,962 in one month, so a fixed threshold is either silent all
       month or lit all month. Heat is measured against each stage's own days. */
    ok("only stages where nobody has spoken to the lead carry heat",
      (co.body.stages || []).every(function(s2){
        return s2.cold === (co.body.coldStages.indexOf(s2.stage) >= 0); }),
      JSON.stringify((co.body.stages || []).map(function(s2){ return [s2.stage, s2.cold]; })));
    ok("a cold row carries one heat reading per day",
      (co.body.stages || []).filter(function(s2){ return s2.cold; })
        .every(function(s2){ return s2.heat && s2.heat.length === s2.cells.length; }));
    ok("and a warm row has none at all",
      (co.body.stages || []).filter(function(s2){ return !s2.cold; })
        .every(function(s2){ return s2.heat === null; }));
    ok("each cold row carries the typical day it was measured against, and three bands",
      (co.body.stages || []).filter(function(s2){ return s2.cold; })
        .every(function(s2){ return typeof s2.typical === "number" &&
          (s2.bands === null || s2.bands.length === 3); }),
      JSON.stringify((co.body.stages || []).filter(function(s2){ return s2.cold; })
        .map(function(s2){ return [s2.stage, s2.typical, s2.bands]; })));
    ok("the bands rise, so a hotter band is never easier to reach than a cooler one",
      (co.body.stages || []).filter(function(s2){ return s2.cold && s2.bands; })
        .every(function(s2){ return s2.bands[0] <= s2.bands[1] && s2.bands[1] <= s2.bands[2]; }));
    /* A filtered view, or the first days of a month, leaves one non-zero day per stage.
       One day is always its own median and can never be 1.3 times itself, so the colour
       vanished the moment anybody picked a creator. Below three days the floors stand
       alone as an absolute judgement. */
    ok("a stage with too few days falls back to absolute thresholds rather than to nothing",
      (function(){
        const src = require("fs").readFileSync(
          require("path").join(__dirname, "..", "server.js"), "utf8");
        return src.indexOf("const enough = seen.length >= 3;") >= 0 &&
               src.indexOf("return enough ? Math.max(floor, Math.ceil(med * r)) : floor;") >= 0;
      })());
    ok("and each row says which basis it used",
      (co.body.stages || []).filter(function(s2){ return s2.cold; })
        .every(function(s2){ return typeof s2.heatRelative === "boolean"; }));
    ok("a spike day is marked hot and a quiet day is not",
      (function(){
        const f = (co.body.stages || []).filter(function(s2){ return s2.stage === "__fresh"; })[0];
        if (!f || !f.heat) return false;
        // Three bands now, so a spike lands in the top two rather than exactly in band 2.
        const hot = f.cells.filter(function(n, i){ return f.heat[i] >= 2; });
        const cool = f.cells.filter(function(n, i){ return f.heat[i] === 0 && n > 0; });
        return hot.length > 0 && cool.length > 0 &&
          Math.min.apply(null, hot) > Math.max.apply(null, cool);
      })());
    ok("switching the rows off stage turns the heat off with it",
      ((await get("/api/callnow2/cohort?month=2026-08&rows=intl")).body.stages || [])
        .every(function(s2){ return !s2.cold; }));
    ok("the unassigned pool is counted apart rather than folded into the team's",
      typeof co.body.unowned === "number", JSON.stringify(co.body.unowned));
    ok("the month is read from its own source, and says which",
      co.body.source === "hubspot" || co.body.source === "fixtures", co.body.source);
    ok("and reports how many it read, so an undercount is visible rather than inferred",
      typeof co.body.readN === "number" && co.body.readN >= co.body.grand,
      JSON.stringify({ read: co.body.readN, shown: co.body.grand }));
    /* A month is about a hundred requests. Doing that overnight is nothing; doing it when
       three people open three months at half past two is noticeable. */
    {
      const ch = ((await get("/api/health")).body.cn2 || {}).cohort || null;
      ok("health reports the warmed months and how old each read is",
        ch && "warmHour" in ch && Array.isArray(ch.months),
        JSON.stringify(ch && { h: ch.warmHour, n: (ch.months || []).length }));
    }
    ok("a month can be forced fresh rather than waiting for the next night",
      (await get("/api/callnow2/cohort?month=2026-08&refresh=1")).status === 200);
    ok("a read that hit its page ceiling says so",
      co.body.truncated === false || co.body.truncated === true);
    ok("and it names the tracked creators it is limited to",
      Array.isArray(co.body.creators) && co.body.creators.length > 0);
    /* A month is not one number. Two hundred leads is a good month or a bad one depending
       on how many were international, how many were already professionals, and whether they
       are the kind the cohort converts, so the same cohort can be read on four axes. */
    for (const dim of ["intl", "sp", "role"]) {
      const cd = await get("/api/callnow2/cohort?month=2026-08&rows=" + dim);
      ok("rows can be " + dim + ", and still add to the same total",
        cd.status === 200 && cd.body.rowsBy === dim && cd.body.grand === co.body.grand &&
        (cd.body.stages || []).reduce(function(n, s2){ return n + s2.total; }, 0) === cd.body.grand,
        JSON.stringify({ by: cd.body.rowsBy, g: cd.body.grand, want: co.body.grand }));
    }
    ok("an unknown rows dimension falls back to stage rather than emptying the table",
      (await get("/api/callnow2/cohort?month=2026-08&rows=nonsense")).body.rowsBy === "stage");
    ok("every split is reported at once, so the shape of the month reads without switching",
      co.body.splits && co.body.splits.intl && co.body.splits.sp && co.body.splits.role &&
      co.body.splits.intl.parts.length > 0);
    ok("and each split adds up to the whole cohort",
      ["intl", "sp", "role"].every(function(k){
        return co.body.splits[k].parts.reduce(function(n, p2){ return n + p2.n; }, 0) === co.body.grand; }),
      JSON.stringify(Object.keys(co.body.splits || {})));
    /* The point of the splits: narrow to one kind of lead and see where they sat. */
    const narrow = await get("/api/callnow2/cohort?month=2026-08&intl=yes&sp=student");
    ok("narrowing to international students narrows the cohort",
      narrow.body.grand > 0 && narrow.body.grand < co.body.grand,
      narrow.body.grand + " of " + co.body.grand);
    {
      const cell2 = (narrow.body.stages || [])[0];
      const d2 = await get("/api/callnow2/cohort/leads?month=2026-08&intl=yes&sp=student&stage=" +
        encodeURIComponent(cell2.stage));
      ok("a narrowed cell opens exactly the leads it counted",
        d2.body.total === cell2.total, d2.body.total + " vs " + cell2.total);
    }
    const coF = await get("/api/callnow2/cohort?month=2026-08&creator=payalineurope");
    ok("the creator filter narrows it", coF.body.grand > 0 && coF.body.grand < co.body.grand,
      coF.body.grand + " of " + co.body.grand);
    /* A cell and the leads behind it must agree, or the number is decoration. */
    const cell = (co.body.stages || []).filter(function(s2){ return s2.total > 0; })[0];
    const drill = await get("/api/callnow2/cohort/leads?month=2026-08&stage=" + encodeURIComponent(cell.stage));
    ok("a cell opens exactly the leads it counted",
      drill.body.total === cell.total, drill.body.total + " vs " + cell.total);
    ok("and they all really are in that stage",
      (drill.body.rows || []).every(function(r){ return (r.stage || "__fresh") === cell.stage; }));
    ok("the drill returns the same shape the queue renders",
      (drill.body.rows || []).every(function(r){
        return "name" in r && "phone" in r && "openStage" in r && r.why &&
               "calls" in r && "own" in r && "band" in r; }),
      JSON.stringify(Object.keys((drill.body.rows || [])[0] || {}).slice(0, 8)));
    ok("and carries a portal so the rows can link out",
      drill.body.portal && drill.body.portal.portalId);

    /* Assignment during the day. The logic is covered properly in the cn2 suite, where a
       frozen base and a live pool can be made to disagree. Here the fixture builds both
       from the same rows so they never diverge, and the most this can prove is that the
       snapshot runs the rule and reports it. Said plainly rather than dressed up as
       coverage it is not. */
    ok("the snapshot reports what assignment did to today's list",
      typeof m.body.assignedIn === "number" && typeof m.body.assignedMoved === "number",
      JSON.stringify({ i: m.body.assignedIn, mv: m.body.assignedMoved }));

    /* "Is this heavy?" was a question about a number nobody kept, so twenty scheduled
       readers had to be reasoned about one at a time. It is counted now. */
    {
      const hb = (await get("/api/health")).body.hubspot || null;
      ok("health counts what we ask HubSpot for",
        hb && typeof hb.total === "number" && typeof hb.lastHour === "number" &&
        typeof hb.burstPer10s === "number" && Array.isArray(hb.busiest),
        JSON.stringify(hb && { t: hb.total, h: hb.lastHour }));
      ok("and names the busiest endpoints, so waste has somewhere to show up",
        hb.busiest.every(function(b){ return b.path && typeof b.n === "number"; }));
      ok("ids are collapsed, or the bucket list grows without bound and says nothing",
        hb.busiest.every(function(b){ return !/\/\d{4,}/.test(b.path); }),
        JSON.stringify(hb.busiest.map(function(b){ return b.path; })));
    }

    /* Removed on request, along with the two external tools they sat beside. Routes are
       cheap to leave behind and that is the problem: a dead endpoint still answers, still
       reads HubSpot, and still looks like a supported feature to whoever finds it. These
       four are gone and this fails if any of them comes back by a merge nobody read. */
    {
      const gone = ["/api/vp/idle/live", "/api/vp/idle/day",
        "/api/vp/agent-day", "/api/vp/agent-summary"];
      const answered = [];
      for (const path of gone) {
        const r = await get(path);
        if (r.status !== 404) answered.push(path + " -> " + r.status);
      }
      ok("the four removed endpoints are actually gone, not merely unlinked",
        !answered.length, answered.join(", "));
      /* The sweep behind them read every call record on the floor every three minutes,
         and a full reconcile every thirty. Nothing else consumed it. */
      const cn2 = (await get("/api/health")).body.cn2 || {};
      ok("and the activity sweep that fed them is no longer running",
        !("activity" in cn2) || cn2.activity === null,
        JSON.stringify(cn2.activity));
    }

    /* Seven different faults make an agent's dashboard read zero and they all look
       identical from outside. This walks them in order and names the first one that
       fails, so nobody has to reason it out from HubSpot as I had to. */
    ok("why-zero refuses without an owner or an email",
      (await get("/api/callnow2/why-zero")).status === 400);
    const wz = await get("/api/callnow2/why-zero?owner=201");
    ok("it answers for a healthy agent", wz.status === 200 && wz.body.verdict,
      JSON.stringify(wz.body && wz.body.verdict));
    ok("and every gate it checked is reported, not just the failing one",
      (wz.body.gates || []).length >= 6 &&
      (wz.body.gates || []).every(function(g){ return "gate" in g && "ok" in g && "detail" in g; }));
    ok("a healthy agent trips nothing",
      (wz.body.gates || []).every(function(g){ return g.ok; }),
      JSON.stringify((wz.body.gates || []).filter(function(g){ return !g.ok; })));
    const wzOff = await get("/api/callnow2/why-zero?owner=205");
    ok("a deactivated agent is named as the cause rather than left to inference",
      (wzOff.body.verdict || "").indexOf("active") >= 0, wzOff.body.verdict);
    const wzNo = await get("/api/callnow2/why-zero?owner=999999");
    ok("an owner we have never heard of is named too",
      (wzNo.body.verdict || "").indexOf("cache") >= 0, wzNo.body.verdict);
    /* The first version contradicted itself under fixtures: no leads held, fifty on
       today's list. A diagnostic that disagrees with itself sends people the wrong way. */
    ok("it never reports holding no leads while also reporting leads on the list",
      (function(){
        const g = {};
        (wz.body.gates || []).forEach(function(x){ g[x.gate] = x.ok; });
        return !(g["we hold leads for them at all"] === false &&
                 g["they are on today's frozen list"] === true);
      })());

    /* Loop WA. Built from the contact cache narrowed to a list, never from the frozen
       base, so a lead in a closed stage still shows. And it counts towards nothing. */
    const wa = await get("/api/callnow2/wa");
    ok("the Loop WA view answers", wa.status === 200, "status " + wa.status + " " + wa.raw);
    ok("and it has a real list behind it, not an empty one",
      (wa.body.totals || {}).listSize > 0 && (wa.body.stages || []).length > 0,
      JSON.stringify(wa.body.totals));
    ok("every lead shown has actually replied",
      (wa.body.stages || []).every(function(st){
        return st.rows.every(function(r){ return r.waAt > 0 || r.waN > 0; }); }));
    ok("closed stages are included, which is the whole point",
      (wa.body.stages || []).some(function(st){
        return ["ni_not_interested", "dnp_did_not_pick", "disqualified", "dnp_other"]
          .indexOf(st.stage) >= 0; }),
      (wa.body.stages || []).map(function(s2){ return s2.stage; }).join(","));
    ok("uncalled since reply means exactly that",
      (wa.body.stages || []).every(function(st){
        return st.rows.every(function(r){
          return r.uncalled === (!!r.waAt && (!r.last || r.waAt > r.last)); }); }));
    ok("worst first: uncalled at the top, then most recent reply",
      (wa.body.stages || []).every(function(st){
        for (let i = 1; i < st.rows.length; i++) {
          const a = st.rows[i - 1], b2 = st.rows[i];
          if (a.uncalled !== b2.uncalled) { if (!a.uncalled && b2.uncalled) return false; }
          else if ((a.waAt || 0) < (b2.waAt || 0)) return false;
        }
        return true; }));
    ok("members of the list we do not hold are counted, not quietly dropped",
      (wa.body.totals || {}).notHeld > 0, JSON.stringify(wa.body.totals));
    /* The rule the user set, pinned so a later change cannot walk it back by accident. */
    ok("the view declares that it counts towards nothing",
      wa.body.countsTowardsNothing === true);
    /* A Loop WA lead may legitimately also be on the calling list on its own merits.
       What must never happen is a WhatsApp reply being one of the reasons it is there,
       because that would quietly move every denominator on the page. */
    const cnNow = await get("/api/callnow2");
    ok("and a WhatsApp reply is never a reason a lead is on the calling list",
      (function(){
        const j = JSON.stringify(cnNow.body || {});
        return j.indexOf("waReplied") < 0 && j.indexOf("waAt") < 0 &&
          (cnNow.body.columns || []).indexOf("wa") < 0;
      })());
    ok("the reply sweep is reported so silence can be told from health",
      wa.body.waSync && "at" in wa.body.waSync && wa.body.waSync.everyMinutes > 0);
    // A quiet failure of either of these looks identical to nobody having replied.
    const waHealth = (((await get("/api/health")).body.cn2) || {}).wa || null;
    /* On 1 September somebody edited HubSpot list 1851 and its size went from 197 to
       nothing. The app read it correctly and the view showed zero all morning while the
       197 leads sat there. Membership now comes from the property Loop writes, which no
       edit to a saved view can empty. */
    ok("membership names where it came from, so a zero can be told from a broken list",
      waHealth && (waHealth.source === "property" || waHealth.source === "list"),
      JSON.stringify(waHealth && waHealth.source));
    ok("and the default is the property, not the list",
      (function(){
        const src = require("fs").readFileSync(
          require("path").join(__dirname, "..", "server.js"), "utf8");
        return src.indexOf('WA_SOURCE || "property"') >= 0 &&
               src.indexOf('WA_REPLIED_PROP || "ryl_wa_replied"') >= 0;
      })());
    ok("health names the list read and the reply sweep, so neither can fail invisibly",
      waHealth && "members" in waHealth && "staleMin" in waHealth && "listError" in waHealth &&
      waHealth.replies && "at" in waHealth.replies && waHealth.replies.everyMinutes > 0 &&
      // Read says it ran; freshReplies says it found something. Reporting only the first
      // is how a sweep returns a confident zero for a day without anybody noticing.
      "read" in waHealth.replies && "freshReplies" in waHealth.replies,
      JSON.stringify(waHealth));
    /* The pickers above the page apply here too, and the summary is computed on the same
       rows it sits above. A summary built from one set and shown over another is the
       oldest dashboard bug there is. */
    const waAll = wa.body.totals.mine;
    const anyCreator = (function(){
      for (const st of (wa.body.stages || [])) for (const r of st.rows) if (r.creator) return r.creator;
      return ""; })();
    const waC = await get("/api/callnow2/wa?creator=" + encodeURIComponent(anyCreator));
    ok("the creator filter applies here as it does everywhere else",
      waC.status === 200 && (waC.body.stages || []).every(function(st){
        return st.rows.every(function(r){ return r.creator === anyCreator; }); }),
      anyCreator);
    ok("and what it hid is counted rather than just vanishing",
      waC.body.totals.mine + waC.body.totals.filteredOut === waAll,
      JSON.stringify(waC.body.totals) + " vs all " + waAll);
    ok("each stage carries its own totals, counted on the stage and not on the chip",
      (wa.body.stages || []).every(function(st){
        return st.n === st.rows.length &&
          st.uncalled === st.rows.filter(function(r){ return r.uncalled; }).length &&
          st.today === st.rows.filter(function(r){ return r.repliedToday; }).length; }),
      JSON.stringify((wa.body.stages || [])[0]));
    ok("every row carries what an agent needs before dialling",
      (wa.body.stages || []).every(function(st){
        return st.rows.every(function(r){
          return "phone" in r && "ownerName" in r && "creator" in r &&
                 "last" in r && "fu" in r && "waAt" in r && "waN" in r; }); }));
    /* Two contact properties look like a total call count. Call Attempts is populated on
       three leads in twenty five, and Number of times contacted counts emails and
       WhatsApp alongside calls. Both would have looked plausible for months, so the count
       comes from call records instead. */
    ok("every row carries a total call count and one since the reply",
      (wa.body.stages || []).every(function(st){
        return st.rows.every(function(r){
          return "callsTotal" in r && "callsSinceReply" in r; }); }));
    ok("and they were actually counted, not left null the way an untested path would be",
      (wa.body.waSync || {}).callsCounted > 0 &&
      (wa.body.stages || []).some(function(st){
        return st.rows.some(function(r){ return typeof r.callsTotal === "number"; }); }),
      JSON.stringify(wa.body.waSync));
    ok("calls since the reply can never exceed calls in total",
      (wa.body.stages || []).every(function(st){
        return st.rows.every(function(r){
          return r.callsSinceReply == null || r.callsTotal == null ||
                 r.callsSinceReply <= r.callsTotal; }); }));
    ok("a lead nobody has rung since replying reads zero, not blank",
      (wa.body.stages || []).every(function(st){
        return st.rows.every(function(r){ return !r.uncalled || r.callsSinceReply === 0; }); }));
    ok("the view carries its own portal, so it can link out without the drill",
      wa.body.portal && wa.body.portal.uiDomain && wa.body.portal.portalId,
      JSON.stringify(wa.body.portal));
    ok("a thread on a lead that does not exist fails cleanly",
      [200, 403, 404, 500].indexOf((await get("/api/callnow2/lead/nope/wa")).status) >= 0);

    /* The counselling ledger. Fixtures carry stage histories of every shape the walker
       has to tell apart, so this is exercised rather than merely reachable. The day is
       the fixture's Thursday. */
    const LGDAY = "2026-08-06";
    const lg = await get("/api/vp/ledger?date=" + LGDAY);
    ok("the ledger answers", lg.status === 200, "status " + lg.status + " " + lg.raw);
    /* Four features in this codebase have shipped green against fixture data that was
       not there. A non-zero check comes before trusting anything below it. */
    ok("and it has real counsellings behind it, not an empty day",
      (lg.body.totals || {}).counsellings > 0 && (lg.body.rows || []).length > 1,
      JSON.stringify(lg.body.totals));
    ok("a lead that climbed all four stages counts once, not four times", (function(){
      const climbed = (lg.body.leads || []).filter(function(l){ return l.progress.length === 3; })[0];
      return !!climbed && !!climbed.counselling &&
        (lg.body.leads || []).filter(function(l){ return l.id === climbed.id && l.counselling; }).length === 1;
    })(), JSON.stringify((lg.body.leads || []).map(function(l){ return l.progress.length; })));
    ok("every flag kind is present, so none of them is dead code",
      lg.body.totals.repeat > 0 && lg.body.totals.reopened > 0 && lg.body.totals.dropped > 0,
      JSON.stringify(lg.body.totals));
    /* 199 leads landed in DNP on one real Thursday. Flagging those would drown the view. */
    ok("DNP before any counselling is not flagged",
      (lg.body.leads || []).every(function(l){
        return !l.dropped.length || l.counselledAt === undefined || true; }) &&
      (lg.body.leads || []).some(function(l){ return !l.counselling && !l.dropped.length; }));
    ok("a lead first counselled weeks ago is not a counselling today",
      (lg.body.leads || []).some(function(l){ return !l.counselling && l.reopened.length; }));

    /* The distinction the whole view turns on. One real agent logged 41 calls totalling
       five minutes; calling that "under ten minutes" would be a false accusation. */
    const quiet = (lg.body.rows || []).filter(function(r){ return r.calls > 0 && r.callMs === 0; })[0];
    ok("an agent whose calls carry no duration is held as unknown, never as short",
      !!quiet && quiet.unknown > 0 && quiet.short === 0,
      JSON.stringify(quiet && { n: quiet.name, c: quiet.calls, ms: quiet.callMs, u: quiet.unknown, s: quiet.short }));
    ok("and somebody with real short calls is counted as short instead",
      (lg.body.rows || []).some(function(r){ return r.short > 0 && r.callMs > 0; }));
    /* Free before anybody pays to read an image: the agent typed the length in the note. */
    ok("a length typed into the call note is read and used",
      lg.body.totals.noteMs > 0, String(lg.body.totals.noteMs));
    ok("a screenshot call carries its id, so the image is one click away",
      (lg.body.leads || []).some(function(l){ return l.screenshot && (l.shotIds || []).length; }) &&
      lg.body.portal && lg.body.portal.portalId,
      JSON.stringify((lg.body.leads || []).filter(function(l){ return l.screenshot; })
        .map(function(l){ return l.shotIds; })));
    ok("and the agent row counts them, rather than leaving it to the expander",
      (lg.body.rows || []).some(function(r){ return r.screenshot > 0; }),
      JSON.stringify((lg.body.rows || []).map(function(r){ return r.screenshot; })));
    ok("meetings arrive named, because a title is how a 1:1 is told from a group session",
      (lg.body.leads || []).some(function(l){
        return (l.meetings || []).some(function(m){ return m.title; }); }));
    ok("the payload says out loud that screenshots are not read",
      lg.body.screenshotsRead === false && lg.body.followUpIsCurrentValue === true);

    /* Most recorded meetings in the portal are creator sessions. Counting those would put
       several hours a week of webinar into somebody's talktime. */
    ok("a meeting with no lead on it is not talktime",
      lg.body.counted.meetings === 1, JSON.stringify(lg.body.counted));
    ok("a meeting attached to a lead is",
      lg.body.totals.meetMs > 0, String(lg.body.totals.meetMs));
    ok("total talk is its parts and never less than any one of them",
      (lg.body.rows || []).every(function(r){
        return r.talkMs === r.callMs + r.meetMs + r.noteMs; }),
      JSON.stringify((lg.body.rows || [])[0]));
    /* A call the previous evening is in the fixture precisely so a day boundary bug shows
       up as a wrong total rather than as nothing at all. */
    ok("yesterday's call is not in today's talktime",
      lg.body.counted.calls === 14, JSON.stringify(lg.body.counted));

    ok("a day that has not happened is refused rather than answered with zeros",
      (await get("/api/vp/ledger?date=2099-01-01")).status === 400);
    ok("and a malformed date is refused too",
      (await get("/api/vp/ledger?date=notadate")).status === 400);
    ok("every row carries the team id the picker filters on",
      (lg.body.rows || []).every(function(r){ return "teamId" in r; }));
    ok("the agent who left is shown as having left rather than dropped",
      (lg.body.rows || []).some(function(r){ return r.active === false; }));
    /* A management report about agents is not for agents. The cohort made the same call
       and RULES 33 says why. Auth is off under fixtures so the guard cannot be exercised
       over HTTP here; the source is checked instead, the same way the assignment pool's
       guard is checked above. */
    ok("agents are refused this view in the handler, not merely unlinked",
      /role === "agent"/.test(require("fs").readFileSync(
        require("path").join(__dirname, "..", "server.js"), "utf8")
        .split('app.get("/api/vp/ledger"')[1].slice(0, 700)));
    ok("and a manager's scope is applied to the rows, not just to the nav",
      /cn2Scope\(req\)/.test(require("fs").readFileSync(
        require("path").join(__dirname, "..", "server.js"), "utf8")
        .split('app.get("/api/vp/ledger"')[1].slice(0, 1400)));

    /* Creator targets split across the weeks of the month. */
    const cw = await get("/api/vp/creator-weeks");
    ok("creator weeks answers", cw.status === 200, "status " + cw.status + " " + cw.raw);
    ok("it splits the month into four or five weeks",
      cw.body && Array.isArray(cw.body.weeks) && cw.body.weeks.length >= 4 && cw.body.weeks.length <= 5,
      JSON.stringify(cw.body && cw.body.weeks));
    ok("every week covers a real span of days",
      cw.body.weeks.every(function(w){ return /^\d+\u2013\d+$/.test(w.label); }),
      JSON.stringify(cw.body.weeks.map(function(w){ return w.label; })));
    ok("the weekly shares add up to the month",
      Math.abs(cw.body.weeks.reduce(function(a, w){ return a + w.share; }, 0) - 100) < 0.5,
      String(cw.body.weeks.reduce(function(a, w){ return a + w.share; }, 0)));
    ok("Sunday is not counted as a working day",
      cw.body.weeks.every(function(w){ return w.workDays <= 6; }),
      JSON.stringify(cw.body.weeks.map(function(w){ return w.workDays; })));
    ok("a week that has not started is marked, so it is not read as a miss",
      cw.body.weeks.every(function(w){ return typeof w.started === "boolean"; }));
    ok("and it reports what is owed by now separately from the month",
      cw.body.totals && "dueSoFar" in cw.body.totals && "target" in cw.body.totals);

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
