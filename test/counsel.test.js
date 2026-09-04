"use strict";
/* The counselling ledger's arithmetic.

   Every shape here is one the portal actually produces. The four stages, the space in
   `Follow up`, the workflow that writes the same value twice, and the lead that goes
   round rather than forward are all real, and each one breaks a rule that reads only the
   current stage. */
const C = require("../lib/counsel.js");

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}

/* IST day keys, because a counselling at 23:10 IST belongs to that day and not to the
   next one in UTC. This mirrors what the server passes in. */
const IST = 5.5 * 3600 * 1000;
const dayKey = function(ms){ return new Date(ms + IST).toISOString().slice(0, 10); };
const H = function(stage, iso){ return { value: stage, timestamp: iso }; };

console.log("\nA counselling is one lead, not one stage change");
const climb = [
  H("", "2026-09-01T06:00:00Z"),
  H("discovery", "2026-09-04T09:00:00Z"),
  H("program_pitched", "2026-09-04T10:00:00Z"),
  H("pricing_pitched", "2026-09-04T11:00:00Z"),
  H("counselled", "2026-09-04T12:00:00Z")
];
const d1 = C.dayFor(climb, "2026-09-04", { dayKey: dayKey });
ok("climbing all four in one day is one counselling", !!d1.counselling && d1.progress.length === 3,
  JSON.stringify({ c: !!d1.counselling, p: d1.progress.length }));
ok("and it is dated at the first of them, not the last",
  d1.counselling.stage === "discovery" && d1.counselling.at === Date.parse("2026-09-04T09:00:00Z"));
ok("the three that follow are progress, never counted again",
  d1.progress.every(function(e){ return e.kind === "progress"; }) &&
  d1.repeat.length === 0 && d1.reopened.length === 0);

/* The lead that was counselled last month is not a counselling today, however much it
   moves. Counting stage changes rather than people is exactly how a floor total triples
   without anybody speaking to anybody new. */
const older = [
  H("discovery", "2026-08-12T09:00:00Z"),
  H("Follow up", "2026-08-20T09:00:00Z"),
  H("counselled", "2026-09-04T10:00:00Z")
];
const d2 = C.dayFor(older, "2026-09-04", { dayKey: dayKey });
ok("a lead first counselled in August is not a counselling in September",
  d2.counselling === null, JSON.stringify(d2.counselling));
ok("but coming back out of Follow up is reported as reopened",
  d2.reopened.length === 1 && d2.reopened[0].fromLabel === "Follow up",
  JSON.stringify(d2.reopened.map(function(e){ return e.fromLabel; })));

console.log("\nGoing round rather than forward");
const round = [
  H("discovery", "2026-09-04T05:00:00Z"),
  H("program_pitched", "2026-09-04T06:00:00Z"),
  H("discovery", "2026-09-04T07:00:00Z")
];
const d3 = C.dayFor(round, "2026-09-04", { dayKey: dayKey });
ok("re-entering a stage the lead has already been in is a repeat",
  d3.repeat.length === 1 && d3.repeat[0].stage === "discovery");
ok("and it is still only one counselling for the day",
  !!d3.counselling && d3.progress.length === 1);
/* Discovery then Program pitched is two stages, not the same stage twice. A rule that
   flagged this would flag every lead that made normal progress. */
ok("plain forward progress is never a repeat",
  C.dayFor(climb, "2026-09-04", { dayKey: dayKey }).repeat.length === 0);

console.log("\nBackwards into a stage for people nobody has spoken to");
const dropped = [
  H("discovery", "2026-09-04T05:00:00Z"),
  H("counselled", "2026-09-04T06:00:00Z"),
  H("dnp_did_not_pick", "2026-09-04T07:30:00Z")
];
const d4 = C.dayFor(dropped, "2026-09-04", { dayKey: dayKey });
ok("DNP after a counselling is flagged", d4.dropped.length === 1 && d4.dropped[0].label === "DNP");
ok("and the stage it fell from is carried, since that is the story",
  d4.dropped[0].fromLabel === "Counselled");
/* Before any counselling, DNP is just an unanswered phone. Flagging it would light up
   most of the floor most days: 199 leads landed in DNP on 4 September alone. */
const freshDnp = [H("dnp_did_not_pick", "2026-09-04T05:00:00Z"), H("rcb_requested_callback", "2026-09-04T08:00:00Z")];
ok("DNP before any counselling is not flagged, it is just an unanswered phone",
  C.dayFor(freshDnp, "2026-09-04", { dayKey: dayKey }).dropped.length === 0);
ok("RCB after a counselling is flagged the same way",
  C.dayFor([H("counselled", "2026-09-01T05:00:00Z"), H("rcb_requested_callback", "2026-09-04T05:00:00Z")],
    "2026-09-04", { dayKey: dayKey }).dropped.length === 1);
/* The portal holds both spellings and only one is in the documented enum. */
ok("dnp_other counts as DNP, because the portal holds both spellings",
  C.dayFor([H("counselled", "2026-09-01T05:00:00Z"), H("dnp_other", "2026-09-04T05:00:00Z")],
    "2026-09-04", { dayKey: dayKey }).dropped.length === 1);

console.log("\nWhat the history does to anyone who trusts it");
/* A workflow rewriting the same value produces two entries and no transition. Counting
   that as a repeat would flag an agent for something an automation did. */
const dupes = [
  H("counselled", "2026-09-04T05:00:00Z"),
  H("counselled", "2026-09-04T05:00:01Z"),
  H("counselled", "2026-09-04T09:00:00Z")
];
const d5 = C.dayFor(dupes, "2026-09-04", { dayKey: dayKey });
ok("the same value written three times is one entry and no repeat",
  !!d5.counselling && d5.repeat.length === 0, JSON.stringify(d5.repeat.length));
ok("history is sorted, not trusted to arrive in order", (function(){
  const jumbled = [H("counselled", "2026-09-04T12:00:00Z"), H("discovery", "2026-09-04T09:00:00Z")];
  const d = C.dayFor(jumbled, "2026-09-04", { dayKey: dayKey });
  return d.counselling.stage === "discovery";
})());
/* An event that cannot be placed on a day would land on the wrong agent's row. */
ok("an entry with no usable timestamp is dropped, not guessed onto a day",
  C.timeline([H("counselled", null), H("counselled", "nonsense"), H("discovery", "2026-09-04T09:00:00Z")]).length === 1);
ok("Follow up keeps its space and capital F, because HubSpot does",
  C.isPost("Follow up") && !C.isPost("follow_up") && C.labelOf("Follow up") === "Follow up");
/* 23:10 IST is 17:40 UTC the same day, but 00:40 IST is the next day in IST and the same
   day in UTC. A UTC day key puts one agent's late counselling on somebody else's row. */
ok("a counselling at 23:10 IST belongs to that IST day",
  C.dayFor([H("counselled", "2026-09-04T17:40:00Z")], "2026-09-04", { dayKey: dayKey }).counselling !== null);
ok("and one at 00:40 IST belongs to the next one",
  C.dayFor([H("counselled", "2026-09-04T19:10:00Z")], "2026-09-05", { dayKey: dayKey }).counselling !== null);

console.log("\nNot knowing how long a call was is not the same as it being short");
/* 137 call logs in 30 days carry a screenshot and none carry a duration. One agent
   logged 41 calls in a day totalling five minutes. Reading a missing number as zero
   marks every one of those conversations as rushed. */
const noDur = C.talkFor([{ durMs: 0 }, { durMs: 0 }]);
ok("calls with no duration read as unknown, never as short",
  noDur.unknown === true && noDur.short === false, JSON.stringify(noDur));
const shortReal = C.talkFor([{ durMs: 120000 }, { durMs: 90000 }]);
ok("three and a half minutes of real duration is short", shortReal.short === true && shortReal.unknown === false);
ok("eleven minutes is not", C.talkFor([{ durMs: 660000 }]).short === false);
/* One dial that connected and one that did not is still a known short call. */
ok("a mix of dated and undated calls is judged on what we hold",
  (function(){ const t = C.talkFor([{ durMs: 240000 }, { durMs: 0 }]);
    return t.short === true && t.unknown === false && t.withDuration === 1 && t.calls === 2; })());
ok("no calls at all is its own state, neither short nor unknown",
  (function(){ const t = C.talkFor([]); return t.none === true && t.short === false && t.unknown === false; })());
ok("the ten minute line is configurable, since it is a judgement not a fact",
  C.talkFor([{ durMs: 400000 }], { shortMs: 300000 }).short === false);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
