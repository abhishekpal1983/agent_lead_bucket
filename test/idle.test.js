"use strict";
/* The idle tracker's arithmetic. Every case here is drawn from something real in the
   portal rather than invented, because the failure modes are all quiet ones: a number
   that is merely wrong looks exactly like a number that is right. */
const I = require("../lib/idle.js");

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}
const M = I.MIN;
const DAY = "2026-08-29";                    // a Saturday
const base = I.istMidnight(DAY);
const at = function(h, m){ return base + (h * 60 + (m || 0)) * M; };
const shift = I.shiftFor(DAY);

console.log("\nThe shift is where the day is, not where the clock is");
ok("12:30 IST is the start", new Date(shift.start).toISOString() === "2026-08-29T07:00:00.000Z",
  new Date(shift.start).toISOString());
ok("22:00 IST is the end", new Date(shift.end).toISOString() === "2026-08-29T16:30:00.000Z");
ok("Saturday is a working day", shift.isWorkDay);
ok("Sunday is not", I.shiftFor("2026-08-30").isWorkDay === false);
ok("both breaks are known", shift.breaks.length === 2);
ok("lunch is 14:30 to 15:00 IST", I.inBreak(at(14, 45), shift) && !I.inBreak(at(15, 1), shift));
ok("tea is 17:00 to 17:30 IST", I.inBreak(at(17, 15), shift) && !I.inBreak(at(16, 59), shift));

console.log("\nIdle time is measured in working minutes");
/* The case that makes this worth having: a break sitting inside the gap. */
ok("14:20 to 15:12 is 22 minutes, not 52",
  I.workedBetween(at(14, 20), at(15, 12), shift) === 22 * M,
  I.workedBetween(at(14, 20), at(15, 12), shift) / M + " min");
ok("a gap spanning both breaks loses both",
  I.workedBetween(at(14, 0), at(18, 0), shift) === (240 - 60) * M,
  I.workedBetween(at(14, 0), at(18, 0), shift) / M + " min");
ok("time before the shift does not count",
  I.workedBetween(at(9, 0), at(13, 0), shift) === 30 * M);
ok("time after the shift does not count",
  I.workedBetween(at(21, 30), at(23, 30), shift) === 30 * M);
ok("a Sunday counts nothing at all",
  I.workedBetween(at(14, 0), at(18, 0), I.shiftFor("2026-08-30")) === 0);

console.log("\nA call logged twice is one call");
/* Straight from the portal: FreJun writes the dial, the agent writes it up, the two land
   within a minute of each other on the same lead. */
const twice = I.dedupe([
  { id: "f1", at: at(13, 44, 17), owner: "9", contact: "111", source: "INTEGRATION", durMs: 0 },
  { id: "c1", at: at(13, 44) + 27000, owner: "9", contact: "111", source: "CRM_UI", durMs: 0 }
]);
ok("two sources on one lead within the window merge", twice.length === 1, JSON.stringify(twice.length));
ok("and the merged call remembers both records", twice[0].ids.length === 2 && twice[0].merged);

const retries = I.dedupe([
  { id: "f1", at: at(13, 0), owner: "9", contact: "222", source: "INTEGRATION", durMs: 0 },
  { id: "f2", at: at(13, 4), owner: "9", contact: "222", source: "INTEGRATION", durMs: 669200 },
  { id: "f3", at: at(13, 20), owner: "9", contact: "222", source: "INTEGRATION", durMs: 4400 }
]);
ok("three FreJun dials to one lead stay three, because they are real retries",
  retries.length === 3, String(retries.length));

const far = I.dedupe([
  { id: "f1", at: at(13, 0), owner: "9", contact: "333", source: "INTEGRATION", durMs: 0 },
  { id: "c1", at: at(13, 9), owner: "9", contact: "333", source: "CRM_UI", durMs: 0 }
]);
ok("nine minutes apart is two calls, not a duplicate", far.length === 2);

const others = I.dedupe([
  { id: "f1", at: at(13, 0), owner: "9", contact: "444", source: "INTEGRATION", durMs: 0 },
  { id: "c1", at: at(13, 0) + 20000, owner: "7", contact: "444", source: "CRM_UI", durMs: 0 }
]);
ok("two agents calling the same lead are two calls", others.length === 2);

const dur = I.dedupe([
  { id: "f1", at: at(13, 0), owner: "9", contact: "555", source: "INTEGRATION", durMs: 101040 },
  { id: "c1", at: at(13, 0) + 30000, owner: "7000", contact: null, source: "CRM_UI", durMs: 0 }
]);
ok("a call with no lead on it can never be merged away", dur.length === 2);
const merged = I.dedupe([
  { id: "f1", at: at(13, 0), owner: "9", contact: "666", source: "INTEGRATION", durMs: 101040 },
  { id: "c1", at: at(13, 0) + 30000, owner: "9", contact: "666", source: "CRM_UI", durMs: 0 }
]);
ok("the merged call keeps FreJun's duration, not the manual log's nothing",
  merged[0].durMs === 101040);

console.log("\nAnswered is not the same as a conversation");
const spread = I.dedupe([
  { id: "a", at: at(13, 0), owner: "9", contact: "1", source: "INTEGRATION", durMs: 0 },
  { id: "b", at: at(13, 5), owner: "9", contact: "2", source: "INTEGRATION", durMs: 26000 },
  { id: "c", at: at(13, 10), owner: "9", contact: "3", source: "INTEGRATION", durMs: 101040 }
]);
ok("a dial that rang out is neither answered nor a conversation",
  !spread[0].answered && !spread[0].conversation);
/* 403 of 1,039 connected calls in two days lasted under 30 seconds. Voicemail answers. */
ok("26 seconds is answered but not a conversation",
  spread[1].answered && !spread[1].conversation);
ok("101 seconds is both", spread[2].answered && spread[2].conversation);

console.log("\nGaps, and what an agent is doing right now");
const day = I.dedupe([
  { id: "a", at: at(12, 40), owner: "9", contact: "1", source: "INTEGRATION", durMs: 60000 },
  { id: "b", at: at(13, 30), owner: "9", contact: "2", source: "INTEGRATION", durMs: 60000 },
  { id: "c", at: at(16, 15), owner: "9", contact: "3", source: "INTEGRATION", durMs: 60000 }
]);
const gaps = I.gapsFor(day, shift, at(16, 30));
/* Two, and the second one is the point. 12:41 to 13:30 is 49 quiet minutes, which is
   already a gap; the long one runs from 13:31 to 16:15. My first version of this test
   expected one gap because I had forgotten the earlier stretch, which is exactly the sort
   of thing a manager would have spotted on the screen instead. */
ok("both quiet stretches are found, not just the obvious one", gaps.length === 2, String(gaps.length));
// 13:31 to 16:15 is 164 minutes and only lunch falls inside it; tea is at 17:00.
ok("the long one is measured with lunch taken out of it",
  Math.round(gaps[1].ms / M) === 164 - 30, Math.round(gaps[1].ms / M) + " min");
const late = I.gapsFor(I.dedupe([
  { id: "a", at: at(15, 30), owner: "9", contact: "1", source: "INTEGRATION", durMs: 0 }
]), shift, at(16, 0));
ok("turning up late is itself a gap, running from the start of the shift",
  late.length === 2 && late[0].from === shift.start,
  JSON.stringify(late.map(function(g){ return Math.round(g.ms / M); })));
ok("and the 150 minutes before that first call are counted, minus lunch",
  Math.round(late[0].ms / M) === 180 - 30, Math.round(late[0].ms / M) + " min");

ok("nothing at all, mid shift, reads as not started",
  I.stateFor([], shift, at(14, 0)).state === "none");
ok("a call thirty seconds ago with no duration reads as on a call",
  I.stateFor(I.dedupe([{ id: "a", at: at(15, 59, 30), owner: "9", contact: "1", source: "INTEGRATION", durMs: 0 }]),
    shift, at(16, 0)).state === "oncall");
ok("six minutes since the last call is between calls",
  I.stateFor(I.dedupe([{ id: "a", at: at(15, 54), owner: "9", contact: "1", source: "INTEGRATION", durMs: 60000 }]),
    shift, at(16, 0)).state === "between");
ok("twenty seven minutes is quiet",
  I.stateFor(I.dedupe([{ id: "a", at: at(15, 33), owner: "9", contact: "1", source: "INTEGRATION", durMs: 0 }]),
    shift, at(16, 0)).state === "quiet");
ok("an hour and a half is idle",
  I.stateFor(I.dedupe([{ id: "a", at: at(14, 30), owner: "9", contact: "1", source: "INTEGRATION", durMs: 0 }]),
    shift, at(16, 30)).state === "idle");
/* Nothing may fire outside the shift, or the alarm is noise by the second day. */
ok("nobody is idle at two in the morning",
  I.stateFor([], shift, at(2, 0)).state === "offshift");
ok("nobody is idle during lunch", I.stateFor([], shift, at(14, 45)).state === "break");
ok("and nobody is idle on a Sunday",
  I.stateFor([], I.shiftFor("2026-08-30"), at(15, 0) + 86400000).state === "offshift");

console.log("\nThe day summary adds up");
const sum = I.summarise(day, shift, at(16, 30));
ok("dialled counts calls, not records", sum.dialled === 3 && sum.records === 3);
ok("the gap total matches the gaps listed",
  sum.gapMs === sum.gaps.reduce(function(n, g){ return n + g.ms; }, 0));
/* Only lunch has happened by 16:30; tea is still to come, so only 30 minutes come off. */
ok("worked time so far excludes the break that has already happened",
  sum.shiftMs === (4 * 60) * M - 30 * M, sum.shiftMs / M + " min");
ok("and by close of shift both breaks are gone",
  I.workedBetween(shift.start, shift.end, shift) === (9 * 60 + 30 - 60) * M,
  I.workedBetween(shift.start, shift.end, shift) / M + " min");
ok("a gap can never exceed the shift", sum.gapMs <= sum.shiftMs);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
