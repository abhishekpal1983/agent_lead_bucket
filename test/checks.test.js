"use strict";
const { runChecks } = require("../lib/checks");
const CN2 = require("../lib/cn2");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (x ? " -> " + x : "")); } };

const COLS = CN2.COLUMNS, TIMING = CN2.TIMING;
function cell(o){ return Object.assign(CN2.cell(), o); }
function good(){
  // one stage, internally consistent
  const n = cell({ due: 5, over: 3, nofu: 2, all: 10, allW: 4, any: 6, form: 2, score: 4, intl: 1, fresh: 0, refill: 0, ifc: 0, needs: 1 });
  const a = cell({ sched: 4, all: 4, any: 1 });
  const d = cell({ over: 2, all: 2 });
  return { totals: { n: n, a: a, d: d }, excluded: { n: cell(), a: cell(), d: cell() },
    stages: [{ stage: "counselled", n: n, a: a, d: d }], columns: COLS, timing: TIMING,
    effort: { total: { low: 6, avg: 2, bench: 1, high: 1 }, owner: {} } };
}
const extra = { baseSize: 16, agents: [{ n: cell({ all: 10 }) }] };

console.log("\nA healthy payload passes everything");
{
  const r = runChecks(good(), extra);
  ok("all checks pass", r.ok, JSON.stringify(r.checks.filter(c => !c.ok)));
  ok("and it names every check", r.checks.length >= 7, String(r.checks.length));
}

console.log("\nEach check catches its own kind of breakage");
const bust = (mutate, key) => {
  const p = good(); mutate(p);
  const r = runChecks(p, extra);
  const c = r.checks.filter(x => x.key === key)[0];
  ok(key + " catches it", c && !c.ok, c ? "still passing" : "check missing");
  ok(key + " makes the whole run fail", !r.ok);
};
bust(p => { p.totals.n.all = 11; }, "total");
bust(p => { p.stages[0].n = cell({ all: 99 }); }, "rowsum");
bust(p => { p.totals.n.due = 99; }, "timing");
bust(p => { p.totals.n.any = 999; }, "any");
bust(p => { p.totals.n.allW = 99; }, "worked");
bust(p => { p.effort.total.low = 99; }, "effort");
bust(p => { p.totals.n.all = 10; extra.agents = [{ n: cell({ all: 3 }) }]; }, "agents");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
