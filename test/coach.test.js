"use strict";
/* Pins one rule: an audit needs a call.

   Only agents with a reviewable call go on the day's list, the walk continues past
   agents who have none, and a day with three reviewable agents owes three rather
   than five with two blanks nobody can clear. */
const C = require("../lib/coach");
const fs = require("fs"), path = require("path"), vm = require("vm");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}
// A roster where every third agent took no call.
const CALLS = {};
["a","b","c","d","e","f","g","h"].forEach(function(id, i){
  CALLS[id] = (i % 3 === 2) ? [] : [{ id: "call_" + id }];
});
const has = function(id){ return CALLS[id].length > 0; };
const pick = function(id, taken){
  return CALLS[id].filter(function(c){ return taken.indexOf(c.id) < 0; })[0] || null;
};
const ORDER = ["a","b","c","d","e","f","g","h"];

const d = C.chooseDay(ORDER, pick, 5);
ok("the day fills to five", d.rows.length === 5, String(d.rows.length));
ok("every chosen agent has a call", d.rows.every(function(r){ return !!r.callId; }));
ok("agents with no call are skipped, not padded",
  d.rows.map(function(r){ return r.agentId; }).join(",") === "a,b,d,e,g", d.rows.map(function(r){ return r.agentId; }).join(","));
ok("the skipped are named", d.skipped.join(",") === "c,f", d.skipped.join(","));
ok("nobody appears twice", new Set(d.rows.map(function(r){ return r.agentId; })).size === 5);
ok("no call is used twice", new Set(d.rows.map(function(r){ return r.callId; })).size === 5);

// A thin day owes what it can actually cover.
const thin = C.chooseDay(["c","f"], pick, 5);
ok("a dry roster produces no rows at all", thin.rows.length === 0);
ok("and no blank cards to fail against", thin.rows.filter(function(r){ return !r.callId; }).length === 0);
ok("everyone dry is named", thin.skipped.length === 2);

const three = C.chooseDay(["a","c","b","f","d"], pick, 5);
ok("three reviewable agents means the day owes three", three.rows.length === 3, String(three.rows.length));

// The walk must not stop early just because it met a blank.
const late = C.chooseDay(["c","f","a","b","d","e"], pick, 3);
ok("a run of blanks at the front does not shorten the day", late.rows.length === 3 &&
  late.rows[0].agentId === "a");

ok("an empty roster is safe", C.chooseDay([], pick, 5).rows.length === 0);
ok("perDay is honoured", C.chooseDay(ORDER, pick, 2).rows.length === 2);

// The cheap preview used before the day is locked must agree with the lock.
ok("the preview picks the same agents as the lock",
  C.eligible(ORDER, has, 5).join(",") === d.rows.map(function(r){ return r.agentId; }).join(","));
ok("the preview is capped too", C.eligible(ORDER, has, 2).length === 2);
ok("the preview of a dry roster is empty", C.eligible(["c","f"], has, 5).length === 0);

// Legacy locks, written when the day was padded to five with blanks.
ok("a padded lock is legacy", C.isLegacyLock({ rows: [{ callId: "x" }, { callId: "" }] }) === true);
ok("a clean lock is not", C.isLegacyLock({ rows: [{ callId: "x" }] }) === false);
ok("an empty lock is not legacy", C.isLegacyLock({ rows: [] }) === false);
ok("no lock is not legacy", C.isLegacyLock(null) === false);

/* And the page shows it: skipped agents are named, never carded. */
{
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "coaching.html"), "utf8");
  ok("the page names agents with no call", html.indexOf("noCall") >= 0 && html.indexOf("keep their turn") >= 0);
  ok("they are a note, not a card", html.indexOf("class=\"nocall\"") >= 0);
  ok("a day with nothing to audit says so", html.indexOf("nothing to audit") >= 0);
}

/* The server must not reintroduce blank rows anywhere. */
{
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  ok("no blank row is ever locked", srv.indexOf("callId: \"\", call: null") < 0);
  ok("the target is read from the lock, not the roster",
    srv.indexOf("const target = coachDayTarget(t, date);") >= 0);
  ok("every lock read goes through the repair", srv.indexOf("function coachLockFor(") >= 0 &&
    (srv.match(/coachAssignments\(\)\[coachAssignKey/g) || []).length === 1);
  ok("today's compliance uses the day target, not the roster",
    srv.indexOf("todayExpected: expectedToday") >= 0);
}

console.log("\n" + (fail ? "FAILED  " : "") + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
