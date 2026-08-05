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
      ["/api/callnow2/leads?moved=still", "drill: nothing happened to them"]
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
    ok("the three groups add up to the whole list",
      b.totals && (b.totals.n.all + b.totals.a.all + b.totals.d.all) === b.baseSize,
      b.totals ? (b.totals.n.all + " + " + b.totals.a.all + " + " + b.totals.d.all + " vs " + b.baseSize) : "no totals");

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
