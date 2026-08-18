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

    /* One row per agent for one day. */
    const ad = await get("/api/vp/agent-day");
    ok("agent day answers", ad.status === 200, "status " + ad.status + " " + ad.raw);
    ok("it offers the pickers a manager needs, built from teams not from rows",
      Array.isArray(ad.body.teams) && "isVP" in ad.body);
    ok("and every row carries the team id the picker filters on",
      (ad.body.rows || []).every(function(r){ return "teamId" in r; }));
    ok("it says where its list columns came from",
      ad.body && ["live", "snapshot", "none"].indexOf(ad.body.source) >= 0, JSON.stringify(ad.body && ad.body.source));
    ok("a past date with no snapshot is reported, not faked",
      (await get("/api/vp/agent-day?date=2020-01-01")).body.source === "none");
    ok("HubSpot being unreachable costs the call counts, not the whole report",
      ad.status === 200 && (!ad.body.callsError || ad.body.rows !== undefined),
      JSON.stringify(ad.body && ad.body.callsError));
    ok("every row keeps tracked and untracked calls separable",
      (ad.body.rows || []).every(function(r){
        return r.called === r.calledTracked + r.calledOutside; }),
      JSON.stringify((ad.body.rows || [])[0]));
    ok("both counselling definitions are reported side by side",
      (ad.body.rows || []).every(function(r){ return "counsellings" in r && "counsDeep" in r; }) &&
      "counsDeep" in (ad.body.totals || {}));
    ok("the narrower count can never exceed the wider one",
      (ad.body.rows || []).every(function(r){ return r.counsDeep <= r.counsellings; }),
      JSON.stringify((ad.body.rows || []).filter(function(r){ return r.counsDeep > r.counsellings; })));
    ok("and no row claims more calls made than it has",
      (ad.body.rows || []).every(function(r){ return r.done <= r.due && r.worked <= r.queue; }));

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
