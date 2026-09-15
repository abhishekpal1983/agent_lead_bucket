"use strict";
/* Locking a day, and catching the edit that comes afterwards. */
const T = require("../lib/talklock.js");

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}
const M = 60000;

console.log("\nA lock that a restart cannot lose");
ok("nothing is due mid afternoon once yesterday is locked",
  T.pendingLock("2026-09-05", "14:00", { "2026-09-04": 1 }) === null);
ok("today is locked at 23:59",
  (function(){ const p = T.pendingLock("2026-09-05", "23:59", { "2026-09-04": 1 });
    return p && p.day === "2026-09-05" && p.late === false; })());
ok("and not before",
  T.pendingLock("2026-09-05", "23:58", { "2026-09-04": 1 }) === null);
ok("locking twice does not happen",
  T.pendingLock("2026-09-05", "23:59", { "2026-09-04": 1, "2026-09-05": 1 }) === null);
/* The night the server is redeploying at 23:58. Firing on the clock alone loses the day
   silently, and nobody finds out for a week. */
/* The check polls every couple of minutes against a moment, so it always lands a few
   minutes past it. The first version called that "late, the window was missed" and printed
   it every single night, which made the one signal that should mean something mean nothing.
   Late now means substantially late. */
ok("closing the day a few minutes after midnight is on time, not an incident",
  (function(){ const p = T.pendingLock("2026-09-05", "00:03", {}, { since: "2026-09-01" });
    return p && p.day === "2026-09-04" && p.lateMin === 4 && p.late === false; })(),
  JSON.stringify(T.pendingLock("2026-09-05", "00:03", {}, { since: "2026-09-01" })));
ok("and so is anything inside the grace",
  T.pendingLock("2026-09-05", "00:29", {}, { since: "2026-09-01" }).late === false);
ok("but eighteen hours past is late, which is what the flag is for",
  (function(){ const p = T.pendingLock("2026-09-05", "18:33", {}, { since: "2026-09-01" });
    return p && p.lateMin === 1114 && p.late === true; })());
ok("a whole day missed is late too",
  T.pendingLock("2026-09-06", "10:00", {}, { since: "2026-09-01" }).late === true);
ok("the grace is configurable, being a judgement and not a fact",
  T.pendingLock("2026-09-05", "00:03", {}, { since: "2026-09-01", graceMin: 1 }).late === true);
ok("lateness is measured from that day's own 23:59, not from now",
  T.pendingLock("2026-09-05", "00:00", {}, { since: "2026-09-01" }).lateMin === 1);
ok("the older owed day is taken first, since it is the one about to be edited",
  (function(){ const p = T.pendingLock("2026-09-05", "23:59", {});
    return p && p.day === "2026-09-04"; })());
/* Without a floor this walks backwards forever on a fresh volume. */
ok("it does not reach back before the day the store began",
  T.pendingLock("2026-09-05", "10:00", {}, { since: "2026-09-05" }) === null);
ok("the lock time is configurable, being a policy and not a fact",
  (function(){ const p = T.pendingLock("2026-09-05", "22:05", { "2026-09-04": 1 }, { lockHm: "22:00" });
    return p && p.day === "2026-09-05"; })());
ok("a month boundary goes backwards correctly", T.prevDay("2026-09-01") === "2026-08-31");

console.log("\nOnly what a person typed is guarded");
const built = { rows: [
  { id: "201", name: "Sid Menon", callMs: 30 * M, meetMs: 0, declaredTotalMs: 20 * M,
    talkMs: 50 * M, calls: 5, waCalls: 1, waMissing: 0, meetings: 0 }
] };
const snapA = T.snapshotOf(built, { calls: [
  { id: "c1", owner: "201", contact: "L1", declaredMs: 20 * M, isWa: true },
  { id: "c2", owner: "201", contact: "L2", declaredMs: 0, noteMs: 0, isWa: false, durMs: 30 * M }
]});
/* A FreJun call cannot be argued with, so it is not part of the guarded set. Keeping all
   1,430 of a day's calls here would bury the two entries that matter. */
ok("a machine timed call is not tracked, an agent typed one is",
  Object.keys(snapA.declared).length === 1 && !!snapA.declared.c1);
ok("and the agent totals are kept for the row",
  snapA.rows["201"].talkMs === 50 * M && snapA.rows["201"].name === "Sid Menon");

console.log("\nWhat changed after the day was closed");
const snapB = T.snapshotOf(built, { calls: [
  { id: "c1", owner: "201", contact: "L1", declaredMs: 48 * M, isWa: true },
  { id: "c3", owner: "201", contact: "L3", declaredMs: 15 * M, isWa: true }
]});
const d = T.diff(snapA, snapB, { day: "2026-09-04", phase: "locked", at: "2026-09-05T06:30:00Z" });
ok("an edited length is reported per call, not as a total",
  d.some(function(e){ return e.kind === "changed" && e.callId === "c1" &&
    e.from === 20 * M && e.to === 48 * M; }), JSON.stringify(d));
ok("a call added to a closed day is reported",
  d.some(function(e){ return e.kind === "added" && e.callId === "c3" && e.to === 15 * M; }));
ok("and one taken away from it",
  T.diff(snapB, snapA, {}).some(function(e){ return e.kind === "removed" && e.callId === "c3"; }));
ok("every entry carries the day, the phase and when it was seen",
  d.every(function(e){ return e.day === "2026-09-04" && e.phase === "locked" && e.at; }));
ok("the agent is named on the entry, so the log reads without a lookup",
  d.every(function(e){ return e.name === "Sid Menon"; }));
ok("an unchanged day produces nothing at all",
  T.diff(snapA, snapA, {}).length === 0);
/* The row flag needs the size of it, not just that something happened. */
ok("changes roll up per agent with the direction of travel",
  (function(){ const r = T.byOwner(d);
    return r["201"] && r["201"].n === 2 && r["201"].deltaMs === 43 * M; })(),
  JSON.stringify(T.byOwner(d)));

console.log("\nA correction has to leave a mark of its own");
/* Per-call diffing covers what an agent typed and misses everything else. Meeting time
   changing, or the arithmetic being fixed, moves an agent's totals without touching a
   single declared call, and the first relock reported "0 figures moved" while visibly
   changing the numbers. A change log that misses a change is worse than none. */
{
  const rowsA = { rows: { "201": { name: "Sid", talkMs: 185 * M, meetMs: 55 * M,
    callMs: 100 * M, declaredMs: 30 * M } }, declared: {} };
  const rowsB = { rows: { "201": { name: "Sid", talkMs: 170 * M, meetMs: 40 * M,
    callMs: 100 * M, declaredMs: 30 * M } }, declared: {} };
  ok("a total that moved with no call touched is still reported",
    (function(){ const d = T.diff(rowsA, rowsB, { rows: true });
      return d.length === 2 &&
        d.some(function(e){ return e.field === "meetMs" && e.from === 55 * M && e.to === 40 * M; }) &&
        d.some(function(e){ return e.field === "talkMs"; }); })(),
    JSON.stringify(T.diff(rowsA, rowsB, { rows: true })));
  ok("and it says which figure moved, in words a person reads",
    T.diff(rowsA, rowsB, { rows: true }).some(function(e){ return e.label === "meeting time"; }));
  ok("an unchanged figure is not reported",
    T.diff(rowsA, rowsB, { rows: true }).every(function(e){ return e.field !== "callMs"; }));
  /* Off while the day is open, or every call landing writes four entries and buries the
     ones worth reading. */
  ok("row totals are left alone unless asked for",
    T.diff(rowsA, rowsB, {}).length === 0);
}

console.log("\nA cached day is only final if it was built after the day ended");
/* The rule this replaces read "if (dayKey < today) return hit", commented "a past day
   cannot change". The day cannot. The cache entry can be a picture of the afternoon, and
   the moment midnight passes that test starts calling it finished. It froze 14 September
   and then reported 84 calls that had been there all along as amendments by the agents. */
{
  const now = Date.parse("2026-09-15T08:00:00Z");
  const mid = { at: now - 3600000, builtOn: "2026-09-14" };   // built during the 14th
  const after = { at: now - 3600000, builtOn: "2026-09-15" }; // built once it had closed
  ok("a build made during the day is never final once that day is over",
    T.cacheUsable(mid, "2026-09-14", "2026-09-15", { now: now }) === false);
  ok("a build made after the day closed is",
    T.cacheUsable(after, "2026-09-14", "2026-09-15", { now: now }) === true);
  ok("today's own build is used while it is fresh",
    T.cacheUsable({ at: now - 60000, builtOn: "2026-09-15" }, "2026-09-15", "2026-09-15",
      { now: now, ttlMs: 900000 }) === true);
  ok("and rebuilt once it is stale",
    T.cacheUsable({ at: now - 3600000, builtOn: "2026-09-15" }, "2026-09-15", "2026-09-15",
      { now: now, ttlMs: 900000 }) === false);
  ok("nothing cached means nothing to use",
    T.cacheUsable(null, "2026-09-14", "2026-09-15", { now: now }) === false);
  ok("and a build that errored is never served",
    T.cacheUsable({ at: now, builtOn: "2026-09-15", error: "boom" }, "2026-09-14",
      "2026-09-15", { now: now }) === false);
  /* An entry from before this field existed has no builtOn at all. Treating it as final
     is how the original bug would come back through the back door. */
  ok("an entry with no build day is not trusted as final either",
    T.cacheUsable({ at: now - 3600000 }, "2026-09-14", "2026-09-15", { now: now }) === false);
}

console.log("\nBreakage has to announce itself");
/* Every failure this codebase has shipped was quiet: a watermark that stopped matching
   looked like a quiet floor, a sweep running four copies looked like normal load, a lock
   that froze a stale build looked like thirty agents editing records. */
{
  const S = require("../lib/selfcheck.js");
  const bad = S.run({ lock: { day: "2026-09-14", verified: false, movedFigures: 84,
    worstMs: 6600000 } });
  ok("a lock that does not match a fresh read is a failure, not a note",
    bad.length === 1 && bad[0].level === "fail" && S.worst(bad) === "fail",
    JSON.stringify(bad));
  /* The reader is HR or a manager, so the day goes in the headline and the damage in the
     detail, rather than both being buried in engineer's shorthand. */
  ok("and it says which day and how far out",
    bad[0].name.indexOf("2026-09-14") >= 0 && bad[0].detail.indexOf("84") >= 0 &&
    bad[0].hint.indexOf("Re-lock this day") >= 0,
    JSON.stringify(bad[0]));
  ok("a verified lock is reported too, so silence is not mistaken for health",
    S.run({ lock: { day: "2026-09-15", verified: true } })[0].level === "ok");
  ok("a dead sync is a failure, since its numbers just stop moving",
    S.run({ syncs: [{ name: "calls", error: "HubSpot 400" }] })[0].level === "fail");
  ok("locks that cannot be saved are a failure",
    S.run({ store: { persistent: false } })[0].level === "fail");
  /* "One in 3 HubSpot requests is a retry" is a sentence about our plumbing. The reader
     needs to know whether the number in front of them is wrong, and it is not. */
  ok("a retry storm is a warning that says the numbers are still fine",
    (function(){ const r = S.run({ hubspot: { total: 7675, retries: 2275 } });
      return r[0].level === "warn" && r[0].detail.indexOf("30 out of every 100") >= 0 &&
        r[0].hint.indexOf("Nothing on this page is wrong") >= 0; })(),
    JSON.stringify(S.run({ hubspot: { total: 7675, retries: 2275 } })));
  /* A finished working day with nobody on it is a failed read, not a quiet day. */
  ok("a past day with no agents at all is a failure",
    S.run({ day: { date: "2026-09-14", isPast: true, agents: 0 } })[0].level === "fail");
  ok("and a clean system says nothing alarming",
    S.worst(S.run({ lock: { day: "x", verified: true },
      store: { persistent: true, loadedFromDisk: true, lockedDays: 2 },
      syncs: [{ name: "calls", error: null }],
      hubspot: { total: 4000, retries: 80 } })) === "ok");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
