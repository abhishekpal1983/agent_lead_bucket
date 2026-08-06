"use strict";
/* Invariants that must hold every single time the page is built.
   These are not tests that run when someone remembers: they run on every request, and the
   page shows a red banner the moment one fails. A number that is quietly wrong is worse
   than a page that is visibly broken, because only one of the two gets fixed. */

function sum(list, pick){ return list.reduce(function(a, x){ return a + pick(x); }, 0); }

/* payload: what /api/callnow2 is about to return.
   extra:   { baseSize, agents } so the per-agent view is checked against the same source. */
function runChecks(payload, extra){
  const out = [];
  const add = function(key, label, ok, detail){ out.push({ key: key, label: label, ok: !!ok, detail: detail || "" }); };
  const T = payload.totals, X = payload.excluded, S = payload.stages || [];
  const COLS = payload.columns || [], TIMING = payload.timing || [];
  const SEC = ["n", "a", "d"];

  // 1. Nothing may be silently dropped: every lead is counted or deliberately held aside.
  const counted = SEC.reduce(function(a, s){ return a + T[s].all; }, 0);
  const held = X ? SEC.reduce(function(a, s){ return a + X[s].all; }, 0) : 0;
  add("total", "Every lead is either counted or held aside",
    counted + held === (extra && extra.baseSize),
    counted + " counted + " + held + " held vs " + (extra && extra.baseSize) + " on the list");

  // 2. The rows of a table must add up to the row under it.
  let bad = [];
  SEC.forEach(function(s){
    COLS.concat(TIMING).forEach(function(k){
      const rows = sum(S, function(x){ return x[s][k]; });
      if (rows !== T[s][k]) bad.push(s + "." + k + " rows " + rows + " vs total " + T[s][k]);
    });
  });
  add("rowsum", "Stage rows add to their section total", bad.length === 0, bad.slice(0, 3).join("; "));

  // 3. A lead has exactly one timing, so the timings must partition the section.
  bad = [];
  SEC.forEach(function(s){
    const t = TIMING.reduce(function(a, k){ return a + T[s][k]; }, 0);
    if (t !== T[s].all) bad.push(s + ": timings " + t + " vs all " + T[s].all);
  });
  add("timing", "Each lead has exactly one follow-up timing", bad.length === 0, bad.join("; "));

  // 4. Reasons overlap by design, so "any priority" must be at or below the raw sum and
  //    never above the stage total. If it exceeded either, the dedupe is broken.
  const raw = ["form", "score", "intl", "fresh", "refill", "ifc"]
    .reduce(function(a, k){ return a + T.n[k]; }, 0);
  add("any", "Any priority is deduplicated, not a sum",
    T.n.any <= raw && T.n.any <= T.n.all,
    "any " + T.n.any + ", raw sum " + raw + ", all " + T.n.all);

  // 5. Called can never exceed the population it is measured against.
  bad = [];
  SEC.forEach(function(s){
    COLS.forEach(function(k){
      if (T[s][k + "W"] > T[s][k]) bad.push(s + "." + k + " " + T[s][k + "W"] + " called of " + T[s][k]);
    });
  });
  add("worked", "Called never exceeds the leads it is measured against", bad.length === 0, bad.slice(0, 3).join("; "));

  // 6. The hero divides one population by itself.
  add("hero", "The headline divides one population by itself",
    T.n.allW <= T.n.all, T.n.allW + " of " + T.n.all);

  // 7. Effort bands are exclusive, so they must add to the call-today leads.
  if (payload.effort) {
    const e = Object.keys(payload.effort.total).reduce(function(a, k){ return a + payload.effort.total[k]; }, 0);
    add("effort", "Effort bands cover every call-today lead exactly once",
      e === T.n.all, e + " banded vs " + T.n.all + " call today");
  }

  // 8. Per agent must account for the same leads the floor does.
  if (extra && extra.agents) {
    const a = sum(extra.agents, function(x){ return x.n.all; });
    const want = T.n.all + (X ? X.n.all : 0);
    add("agents", "Agent rows account for every call-today lead", a === want, a + " vs " + want);
  }

  return { at: new Date().toISOString(), ok: out.every(function(c){ return c.ok; }), checks: out };
}
module.exports = { runChecks };
