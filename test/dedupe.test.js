"use strict";
/* Call de-duplication. Every case here is drawn from something real in the portal rather
   than invented, because the failure modes are all quiet ones: a number that is merely
   wrong looks exactly like a number that is right.

   The idle tracker this was written for has been removed. The de-duplication stayed
   because the Loop WA view counts calls per lead through it, and counting records instead
   of calls reads about 6% high across the floor and much worse on individual agents. */
const I = require("../lib/idle.js");

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}
const M = I.MIN;
/* A fixed Saturday. The shift arithmetic that gave these their meaning is gone, so this
   is now just a stable clock to hang the records off. */
const base = Date.UTC(2026, 7, 28, 18, 30);   // 2026-08-29 00:00 IST
const at = function(h, m, s){ return base + (h * 60 + (m || 0)) * M + (s || 0) * 1000; };
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


console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
