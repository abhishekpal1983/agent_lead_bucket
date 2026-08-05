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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
