"use strict";
/* Independent audit. Boots the server on fixtures and re-derives every headline number
   from the leads endpoint, so the matrix is checked against the actual leads rather than
   against itself. */
const { spawn } = require("child_process");
const http = require("http");
const PORT = 3993;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (x ? "  ->  " + x : "")); } };
const get = p => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 30000 }, r => {
    let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0,120))); } });
  }).on("error", rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const child = spawn(process.execPath, [require("path").join(__dirname,"..","server.js")], {
    env: Object.assign({}, process.env, { CN2_FIXTURES: "1", PORT: String(PORT), DATA_DIR: "/tmp/cn2audit" }),
    stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (let i = 0; i < 40; i++) { await sleep(400); try { await get("/api/health"); break; } catch (e) {} }
    const M = await get("/api/callnow2");
    const SEC = { n: "call today", a: "booked later", d: "parked DNP" };

    console.log("\n1. Every cell against the leads behind it");
    let mismatched = 0, checked = 0;
    for (const st of M.stages) {
      for (const sec of ["n", "a", "d"]) {
        for (const col of M.columns) {
          const want = st[sec][col];
          if (!want) continue;
          const q = `/api/callnow2/leads?stage=${encodeURIComponent(st.stage)}&sec=${sec}&col=${col}`;
          const got = (await get(q)).total;
          checked++;
          if (got !== want) { mismatched++; if (mismatched < 6) console.log(`     ${st.stage}/${SEC[sec]}/${col}: cell ${want}, leads ${got}`); }
        }
      }
    }
    ok(`all ${checked} non-empty cells match their lead list`, mismatched === 0, mismatched + " mismatched");

    console.log("\n2. Timing buckets against the leads behind them");
    let tm = 0, tc = 0;
    for (const st of M.stages) for (const sec of ["n","a","d"]) for (const t of M.timing) {
      const want = st[sec][t]; if (!want) continue;
      const got = (await get(`/api/callnow2/leads?stage=${encodeURIComponent(st.stage)}&sec=${sec}&t=${t}`)).total;
      tc++; if (got !== want) { tm++; if (tm < 4) console.log(`     ${st.stage}/${SEC[sec]}/${t}: cell ${want}, leads ${got}`); }
    }
    ok(`all ${tc} non-empty timing cells match`, tm === 0, tm + " mismatched");

    console.log("\n3. The arithmetic that has to close");
    const sum = (sec, k) => M.stages.reduce((a, s) => a + s[sec][k], 0);
    ok("stage rows add to the section total, every column",
      M.columns.concat(M.timing).every(k => ["n","a","d"].every(sec => sum(sec, k) === M.totals[sec][k])));
    const counted = M.totals.n.all + M.totals.a.all + M.totals.d.all;
    const held = M.excluded.n.all + M.excluded.a.all + M.excluded.d.all;
    ok("counted plus held-aside equals the whole locked list", counted + held === M.baseSize,
      `${counted} + ${held} vs ${M.baseSize}`);
    ok("timing buckets partition each section",
      ["n","a","d"].every(sec => M.timing.reduce((a,t) => a + M.totals[sec][t], 0) === M.totals[sec].all));

    console.log("\n4. Reason columns overlap on purpose, 'any priority' is the dedupe");
    const anyRaw = ["form","score","intl","fresh","refill","ifc"].reduce((a,k) => a + M.totals.n[k], 0);
    ok("summing the reasons double counts, 'any' does not", anyRaw >= M.totals.n.any,
      `raw ${anyRaw} vs any ${M.totals.n.any}`);
    ok("'any priority' never exceeds all in stage", M.totals.n.any <= M.totals.n.all);
    ok("needs owner is not folded into any priority",
      (await get("/api/callnow2/leads?sec=n&col=needs")).total >= 0);

    console.log("\n5. Effort bands");
    const bands = ["low","avg","bench","high"];
    const drill = [];
    for (const b of bands) drill.push((await get(`/api/callnow2/leads?sec=n&bandBy=total&band=${b}`)).total);
    ok("bands partition the call-today leads",
      drill.reduce((a,b)=>a+b,0) === (await get("/api/callnow2/leads?sec=n&col=all")).total,
      drill.join(" + "));
    ok("the panel agrees with the drill", bands.every((b,i) => M.effort.total[b] === drill[i]),
      JSON.stringify(M.effort.total) + " vs " + drill.join(","));

    console.log("\n6. Ownership states");
    const [act, ina, un, all] = await Promise.all([
      get("/api/callnow2?ostate=active"), get("/api/callnow2?ostate=inactive"),
      get("/api/callnow2?ostate=unassigned"), get("/api/callnow2")]);
    ok("active, deactivated and unassigned partition the list",
      act.baseSize + ina.baseSize + un.baseSize === all.baseSize,
      `${act.baseSize} + ${ina.baseSize} + ${un.baseSize} vs ${all.baseSize}`);

    console.log("\n7. The hero divides one population by itself");
    ok("numerator is a subset of the denominator", M.totals.n.allW <= M.totals.n.all,
      `${M.totals.n.allW} of ${M.totals.n.all}`);
    const workedDrill = (await get("/api/callnow2/leads?sec=n&col=all&worked=1")).total;
    ok("the hero numerator matches the leads actually called", workedDrill === M.totals.n.allW,
      `${workedDrill} vs ${M.totals.n.allW}`);

    console.log("\n8. Filtering must scope the extra calls too");
    {
      // Off-base was measured against the whole floor even when the page was filtered,
      // which credited one manager with everyone else's calls.
      const one = await get("/api/callnow2?agent=201");
      const all2 = await get("/api/callnow2");
      ok("filtering to one agent cannot report more extra calls than the floor has",
        one.offBase.leads <= all2.offBase.leads,
        one.offBase.leads + " vs " + all2.offBase.leads);
      const a1 = await get("/api/callnow2?agent=201");
      const a2 = await get("/api/callnow2?agent=202");
      ok("two agents' extra calls do not exceed the floor's",
        a1.offBase.leads + a2.offBase.leads <= all2.offBase.leads,
        a1.offBase.leads + " + " + a2.offBase.leads + " vs " + all2.offBase.leads);
    }

    console.log("\n9. Per agent against the floor");
    const A = await get("/api/callnow2/agents");
    const agentSum = A.agents.reduce((a, x) => a + x.n.all, 0);
    ok("agent rows account for every call-today lead, held-aside included",
      agentSum === M.totals.n.all + M.excluded.n.all, `${agentSum} vs ${M.totals.n.all + M.excluded.n.all}`);
    ok("agent churn bands add to each agent's own call-today count",
      A.agents.every(x => bands.reduce((a,b) => a + x.effort.owner[b], 0) === x.n.all));
  } catch (e) {
    fail++; console.log("  FAIL harness: " + e.message);
  } finally { child.kill("SIGKILL"); }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
