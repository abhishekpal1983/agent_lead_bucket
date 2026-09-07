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
ok("a day missed by a restart is still locked, and marked late",
  (function(){ const p = T.pendingLock("2026-09-05", "00:40", {});
    return p && p.day === "2026-09-04" && p.late === true; })());
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

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
