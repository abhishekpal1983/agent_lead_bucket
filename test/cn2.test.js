"use strict";
const cn2 = require("../lib/cn2");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}
function eq(name, got, want){ ok(name + " (" + JSON.stringify(got) + ")", got === want, "wanted " + JSON.stringify(want)); }
function head(t){ console.log("\n" + t); }

const WORK = cn2.workDaySet();                 // Mon to Sat
// Pick a known Thursday 6 Aug 2026 in IST for the whole suite.
const AUG6 = Date.UTC(2026, 7, 6) - 5.5 * 3600000 + 1000;
const day6 = cn2.dayBoundsFor(AUG6 + 12 * 3600000);
const at = function(y, m, d, h){ return Date.UTC(y, m - 1, d, (h || 0) - 5, -30); };

head("Overdue needs the day to cross, not the hour");
{
  const r = { id: "1", stage: "counselled", fu: at(2026, 8, 6, 14), last: 0 };
  eq("2pm follow-up on the 6th, checked at 6pm on the 6th", cn2.timingOf(r, day6, WORK), "due");
  const day7 = cn2.dayBoundsFor(at(2026, 8, 7, 10));
  eq("same lead on the 7th with no call", cn2.timingOf(r, day7, WORK), "over");
  const day8 = cn2.dayBoundsFor(at(2026, 8, 8, 10));
  eq("still overdue on the 8th", cn2.timingOf(r, day8, WORK), "over");
}

head("Non-working days do not create a miss nobody could have made");
{
  // 9 Aug 2026 is a Sunday.
  eq("9 Aug 2026 is a Sunday", cn2.istWeekday(cn2.istDayIndex(at(2026, 8, 9, 12))), 0);
  const r = { id: "2", stage: "counselled", fu: at(2026, 8, 9, 11), last: 0 };
  const mon = cn2.dayBoundsFor(at(2026, 8, 10, 10));
  eq("Sunday follow-up reads as due on Monday, not overdue", cn2.timingOf(r, mon, WORK), "due");
  const tue = cn2.dayBoundsFor(at(2026, 8, 11, 10));
  eq("and becomes overdue on Tuesday", cn2.timingOf(r, tue, WORK), "over");
  const sat = { id: "3", stage: "counselled", fu: at(2026, 8, 8, 11), last: 0 };
  eq("Saturday is a working day, so Sunday shows it overdue", cn2.timingOf(sat, cn2.dayBoundsFor(at(2026, 8, 9, 10)), WORK), "over");
  const noSat = cn2.workDaySet("1,2,3,4,5");
  // Friday was workable, so by Saturday the chance has been missed whatever the weekend
  // policy is. What the policy changes is whether the weekend itself creates a miss.
  eq("with Saturday off, a Friday follow-up is still overdue on Saturday",
    cn2.timingOf({ id: "4", stage: "counselled", fu: at(2026, 8, 7, 11), last: 0 },
      cn2.dayBoundsFor(at(2026, 8, 8, 10)), noSat), "over");
  eq("but a Saturday follow-up rolls to Monday as due, not overdue",
    cn2.timingOf({ id: "5", stage: "counselled", fu: at(2026, 8, 8, 11), last: 0 },
      cn2.dayBoundsFor(at(2026, 8, 10, 10)), noSat), "due");
  eq("and Monday does not inherit the weekend under Mon to Sat either",
    cn2.timingOf({ id: "6", stage: "counselled", fu: at(2026, 8, 9, 11), last: 0 },
      cn2.dayBoundsFor(at(2026, 8, 10, 10)), WORK), "due");
}

head("Refill means the form came in after the last call");
{
  ok("form after the last call is a refill",
    cn2.isRefill({ stage: "ghosted", formLast: at(2026, 8, 6, 9), last: at(2026, 8, 1, 9) }));
  ok("form before the last call is not",
    !cn2.isRefill({ stage: "ghosted", formLast: at(2026, 8, 1, 9), last: at(2026, 8, 6, 9) }));
  ok("form with no call at all is a refill",
    cn2.isRefill({ stage: "ni_not_interested", formLast: at(2026, 8, 6, 9), last: 0 }));
  ok("no form is not", !cn2.isRefill({ stage: "counselled", formLast: 0, last: 0 }));
  cn2.REFILL_EXCLUDED.forEach(function(st){
    ok("refill ignored on " + st, !cn2.isRefill({ stage: st, formLast: at(2026, 8, 6, 9), last: 0 }));
  });
}

head("Sections");
{
  const mk = function(o){ return Object.assign({ id: "x", stage: "counselled", fu: 0, last: 0, forms: [], score: 0, intl: false, formLast: 0 }, o); };
  const cl = function(o){ return cn2.classify(mk(o), day6, { work: WORK, scoreMin: 6 }); };
  eq("DNP with no priority signal is parked", cl({ stage: "dnp_other", fu: at(2026, 8, 1, 9) }).sec, "d");
  eq("and does not read as overdue in the action bucket", cl({ stage: "dnp_other", fu: at(2026, 8, 1, 9) }).t, "over");
  eq("DNP with a score does not park", cl({ stage: "dnp_did_not_pick", score: 8, fu: at(2026, 8, 1, 9) }).sec, "n");
  eq("a future follow-up is scheduled ahead", cl({ fu: at(2026, 8, 20, 9) }).sec, "a");
  eq("no follow-up needs action", cl({ fu: 0 }).sec, "n");
  eq("fresh gets its own timing", cl({ stage: "__fresh", fu: 0 }).t, "newlead");
  const ifc = cl({ stage: "IFC", fu: at(2026, 8, 6, 9) });
  ok("IFC due today qualifies", ifc.why.ifc && ifc.sec === "n");
  const ifcOver = cl({ stage: "IFC", fu: at(2026, 8, 1, 9) });
  ok("IFC overdue also qualifies", ifcOver.why.ifc && ifcOver.sec === "n");
  ok("IFC scheduled ahead does not", !cl({ stage: "IFC", fu: at(2026, 8, 20, 9) }).why.ifc);
}

head("The three sections add up to the stage total, column by column");
{
  const stages = ["counselled", "dnp_other", "__fresh", "IFC"];
  const leads = [
    { id: "a", stage: "counselled", fu: at(2026, 8, 6, 14), last: 0, score: 8, forms: [], intl: false, formLast: 0, owner: "1" },
    { id: "b", stage: "counselled", fu: at(2026, 8, 1, 14), last: 0, score: 0, forms: ["f"], intl: true, formLast: 0, owner: "1" },
    { id: "c", stage: "counselled", fu: at(2026, 8, 20, 9), last: 0, score: 9, forms: [], intl: false, formLast: 0, owner: "2" },
    { id: "d", stage: "counselled", fu: 0, last: 0, score: 0, forms: [], intl: false, formLast: 0, owner: "2" },
    { id: "e", stage: "dnp_other", fu: at(2026, 8, 1, 9), last: 0, score: 0, forms: [], intl: false, formLast: 0, owner: "1" },
    { id: "f", stage: "__fresh", fu: 0, last: 0, score: 0, forms: [], intl: false, formLast: 0, owner: "2" },
    { id: "g", stage: "IFC", fu: at(2026, 8, 6, 9), last: 0, score: 0, forms: [], intl: false, formLast: 0, owner: "1" }
  ];
  const base = {};
  leads.forEach(function(r){ base[r.id] = cn2.pack(cn2.classify(r, day6, { work: WORK, scoreMin: 6 })); });
  const live = {}; leads.forEach(function(r){ live[r.id] = r; });
  const agg = cn2.aggregate(base, live, day6, stages);
  let good = true;
  stages.forEach(function(s){
    cn2.COLUMNS.forEach(function(col){
      const sum = agg.sections.n[s][col] + agg.sections.a[s][col] + agg.sections.d[s][col];
      const truth = leads.filter(function(r){ return r.stage === s; }).filter(function(r){
        return cn2.hit(cn2.classify(r, day6, { work: WORK, scoreMin: 6 }), col);
      }).length;
      if (sum !== truth) { good = false; console.log("    mismatch " + s + "." + col + " " + sum + " vs " + truth); }
    });
  });
  ok("every column in every stage reconciles", good);
}

head("The base does not move when the lead does");
{
  const r = { id: "z", stage: "counselled", fu: at(2026, 8, 1, 9), last: 0, score: 8, forms: [], intl: false, formLast: 0, owner: "1" };
  const base = { z: cn2.pack(cn2.classify(r, day6, { work: WORK, scoreMin: 6 })) };
  const before = cn2.aggregate(base, { z: r }, day6, ["counselled", "Follow up"]);
  eq("at open, counselled needs-action score", before.sections.n.counselled.score, 1);
  eq("and nothing called yet", before.sections.n.counselled.scoreW, 0);
  // Noon: called, stage advanced, follow-up pushed out, handed to another agent.
  const moved = Object.assign({}, r, { stage: "Follow up", last: day6.start + 43200000, fu: at(2026, 8, 20, 9), owner: "9" });
  const after = cn2.aggregate(base, { z: moved }, day6, ["counselled", "Follow up"]);
  eq("the denominator stays where it was", after.sections.n.counselled.score, 1);
  eq("and the call lands on it", after.sections.n.counselled.scoreW, 1);
  eq("nothing leaks into the new stage", after.sections.n["Follow up"].all, 0);
  eq("credit stays with the morning owner", after.byAgent["1"].n.scoreW, 1);
  ok("and not with the new one", !after.byAgent["9"]);
  const gone = cn2.aggregate(base, {}, day6, ["counselled", "Follow up"]);
  eq("a lead that leaves the pool holds its place", gone.sections.n.counselled.score, 1);
  eq("and counts as not called", gone.sections.n.counselled.scoreW, 0);
}

head("A lead that leaves the pool keeps its place, and keeps its call");
{
  const r = { id: "z", stage: "counselled", fu: 0, last: 0, score: 8, forms: [], intl: false,
    formLast: 0, owner: "1", creator: "c", counted: true };
  const base = { z: cn2.pack(cn2.classify(r, day6, { work: WORK, scoreMin: 6 })) };
  // Called at 10am, then moved to a stage this page does not carry, so it leaves the pool.
  const gone = { id: "z", last: day6.start + 36000000, stage: "ghosted", owner: "1" };
  const without = cn2.aggregate(base, {}, day6, ["counselled"]);
  const withAll = cn2.aggregate(base, {}, day6, ["counselled"], { z: gone });
  eq("it stays in the cell it was in this morning", withAll.sections.n.counselled.all, 1);
  eq("and the call is not lost", withAll.sections.n.counselled.allW, 1);
  eq("without the wider pool the call would vanish", without.sections.n.counselled.allW, 0);
  eq("its stage change does not move it", withAll.sections.n.counselled.score, 1);
}

head("The two confirmed business rules (RULES.md, 8 Aug 2026)");
{
  // Monday to Saturday. Sunday is the only day that rolls a follow-up forward.
  const W = cn2.workDaySet();
  [[0, "Sunday"], [1, "Monday"], [2, "Tuesday"], [3, "Wednesday"],
   [4, "Thursday"], [5, "Friday"], [6, "Saturday"]].forEach(function(d){
    const isWork = !!W[d[0]];
    ok(d[1] + (d[0] === 0 ? " is not a working day" : " is a working day"),
      d[0] === 0 ? !isWork : isWork);
  });

  // Needs owner never joins the priority queue on its own.
  const noOwner = cn2.classify({ id: "n1", stage: "counselled", fu: 0, last: 0, forms: [],
    score: 0, intl: false, formLast: 0, owner: "", needsOwner: true }, day6, { work: W, scoreMin: 6 });
  ok("a lead with no owner is flagged needs owner", noOwner.why.needs);
  ok("but that alone does not make it any priority", !cn2.hit(noOwner, "any"));
  ok("and it still has its own column", cn2.hit(noOwner, "needs"));
  const scored = cn2.classify({ id: "n2", stage: "counselled", fu: 0, last: 0, forms: [],
    score: 8, intl: false, formLast: 0, owner: "", needsOwner: true }, day6, { work: W, scoreMin: 6 });
  ok("a needs-owner lead that also scores does count as any priority", cn2.hit(scored, "any"));
}

head("Off-base effort");
{
  const base = { a: cn2.pack(cn2.classify({ id: "a", stage: "counselled", fu: 0, last: 0 }, day6, { work: WORK })) };
  const liveRows = [
    { id: "a", last: day6.start + 100 },
    { id: "new1", last: day6.start + 200 },
    { id: "new2", last: 0 }
  ];
  const off = cn2.offBase(base, liveRows, day6);
  eq("only leads called today that were not in the base", off.length, 1);
  eq("and it is the right one", off[0].id, "new1");
}

head("Lead source survives the pack, and an older locked list still parses");
{
  const c = cn2.classify({ id: "s1", stage: "counselled", fu: 0, last: 0, owner: "9",
    creator: "ayush_singh13", source: "digital product" }, day6, { work: WORK });
  const packed = cn2.pack(c);
  eq("source is packed", cn2.unpack(packed).source, "digital product");
  eq("creator still packed", cn2.unpack(packed).creator, "ayush_singh13");
  eq("a list locked before source existed reads as blank, not a crash",
    cn2.unpack("counselled|n|nofu|0|9|ayush_singh13").source, "");
  eq("and the rest of that older row is still correct",
    cn2.unpack("counselled|n|nofu|0|9|ayush_singh13").owner, "9");
}


/* ---- routing done during the day -------------------------------------------------
   A lead nobody was working joins the totals the moment a working agent takes it, and
   the credit follows them. Nothing already counted is ever taken back out. */
{
  const mk = function(o){
    return cn2.pack(Object.assign({ stage: "__fresh", sec: "n", t: "newlead",
      why: { needs: false, fresh: true }, owner: "", creator: "c1", source: "", counted: true }, o));
  };
  const live = function(id){ return { id: "L", owner: id, last: 0 }; };
  const countable = function(id){ return ["10", "11"].indexOf(id) >= 0; };   // 99 is a parking bucket, 98 has left

  const unowned = mk({ why: { needs: true, fresh: true }, owner: "", counted: false });

  let r = cn2.promoteBase({ L: unowned }, { L: live("10") }, { countable: countable });
  ok("a routed lead starts counting", cn2.read(r.base.L).counted === true);
  ok("and the count of routed leads is reported", r.promoted === 1);
  ok("credit follows the new owner", cn2.read(r.base.L).owner === "10");
  ok("and it stops asking to be routed", cn2.read(r.base.L).why.needs === false);
  ok("its stage row does not move", cn2.read(r.base.L).stage === "__fresh");
  ok("its timing does not move", cn2.read(r.base.L).t === "newlead");
  ok("its section does not move", cn2.read(r.base.L).sec === "n");
  ok("its other reasons survive", cn2.read(r.base.L).why.fresh === true);

  r = cn2.promoteBase({ L: unowned }, { L: live("99") }, { countable: countable });
  ok("routing into a parking bucket changes nothing", cn2.read(r.base.L).counted === false && r.promoted === 0);

  r = cn2.promoteBase({ L: unowned }, { L: live("98") }, { countable: countable });
  ok("routing to someone who has also left changes nothing", r.promoted === 0);

  r = cn2.promoteBase({ L: unowned }, { L: live("") }, { countable: countable });
  ok("still nobody means still not counted", r.promoted === 0);

  r = cn2.promoteBase({ L: unowned }, {}, { countable: countable });
  ok("a lead that has left the pool is not promoted", r.promoted === 0);

  // The rule can only ever add.
  const parked = mk({ why: { needs: false, fresh: true }, owner: "165087274", counted: false });
  r = cn2.promoteBase({ L: parked }, { L: live("10") }, { countable: countable });
  ok("a parking bucket lead handed out is not promoted, it was never a routing case",
    cn2.read(r.base.L).counted === false && r.promoted === 0);

  const counted = mk({ owner: "10", counted: true });
  r = cn2.promoteBase({ L: counted }, { L: live("98") }, { countable: countable });
  ok("a counted lead whose agent leaves is never demoted", cn2.read(r.base.L).counted === true);
  ok("and its owner is not rewritten", cn2.read(r.base.L).owner === "10");

  // The stored base must not be touched: tomorrow reads it again.
  const store = { L: unowned };
  cn2.promoteBase(store, { L: live("10") }, { countable: countable });
  ok("the stored list is never rewritten", store.L === unowned);

  // And the promoted lead has to reach the totals, not just the base.
  const day = cn2.dayBoundsFor(Date.UTC(2026, 7, 6, 6, 30));
  const p2 = cn2.promoteBase({ L: unowned }, { L: live("10") }, { countable: countable });
  const agg = cn2.aggregate(p2.base, { L: { id: "L", last: day.start + 3600000, stage: "__fresh", owner: "10" } },
    day, ["__fresh"], null);
  ok("a routed lead lands in the totals", agg.totals.n.all === 1);
  ok("and out of the shown-but-not-counted block", agg.excluded.n.all === 0);
  ok("and the call on it is credited to the new agent", !!agg.byAgent["10"] && agg.byAgent["10"].n.allW === 1);
  ok("and not to nobody", !agg.byAgent["none"]);
  ok("and it no longer sits in the needs-owner column", agg.totals.n.needs === 0);
}


/* ---- a lead stranded with an agent who has left ----------------------------------
   Nobody is working it, so nobody can be measured on it. It leaves the totals, stays
   visible, and comes back the moment somebody working takes it. */
{
  const mk = function(o){
    return cn2.pack(Object.assign({ stage: "counselled", sec: "n", t: "nofu",
      why: { needs: false }, owner: "10", creator: "c1", source: "", counted: true }, o));
  };
  const countable = function(id){ return id === "10"; };   // 98 has left, 99 is a bucket

  let r = cn2.correctBase({ L: mk({ owner: "98", why: { needs: true }, counted: true }) }, { countable: countable });
  ok("a lead left behind by a departed agent stops counting", cn2.read(r.base.L).counted === false);
  ok("and the correction is reported", r.corrected === 1);
  ok("it keeps its owner, so the pile is still visible", cn2.read(r.base.L).owner === "98");
  ok("and it still asks to be routed", cn2.read(r.base.L).why.needs === true);

  r = cn2.correctBase({ L: mk({ owner: "10" }) }, { countable: countable });
  ok("a lead with a working agent is untouched", cn2.read(r.base.L).counted === true && r.corrected === 0);

  // The narrow part: only where the morning list already knew nobody was working it.
  r = cn2.correctBase({ L: mk({ owner: "98", why: { needs: false }, counted: true }) }, { countable: countable });
  ok("an agent who was working at midnight and left at noon does not demote the lead",
    cn2.read(r.base.L).counted === true && r.corrected === 0);

  r = cn2.correctBase({ L: mk({ owner: "98", why: { needs: true }, counted: false }) }, { countable: countable });
  ok("a lead already out of the totals is not corrected twice", r.corrected === 0);

  const store = { L: mk({ owner: "98", why: { needs: true }, counted: true }) };
  cn2.correctBase(store, { countable: countable });
  ok("the stored list is never rewritten", typeof store.L === "string");

  // Correct, then promote: stranded this morning, routed at noon, counts for the taker.
  const c1 = cn2.correctBase({ L: mk({ owner: "98", why: { needs: true }, counted: true }) }, { countable: countable });
  const p1 = cn2.promoteBase(c1.base, { L: { owner: "10" } }, { countable: countable });
  ok("a stranded lead routed to a working agent counts again", cn2.read(p1.base.L).counted === true);
  ok("and counts for the agent who took it", cn2.read(p1.base.L).owner === "10");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
