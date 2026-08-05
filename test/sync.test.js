"use strict";
/* Simulates the two-phase boot sync against fake owners, so the shape of the change can
   be checked without a HubSpot token: is it faster, does it publish early, and is the
   final pool identical to what the old one-at-a-time version produced. */
const { mapLimit } = require("../lib/pool");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " -> " + extra : "")); }
}
const sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

const OWNERS = new Array(19).fill(0).map(function(_, i){ return "o" + i; });
// One parking bucket takes far longer than the rest, which is the real shape of it.
const stagedMs = function(id){ return id === "o7" ? 120 : 20; };
const freshMs  = function(id){ return id === "o7" ? 200 : 25; };
const fetchStaged = async function(id){ await sleep(stagedMs(id)); return [id + "-a", id + "-b"]; };
const fetchFresh  = async function(id){ await sleep(freshMs(id)); return id === "o3" ? [] : [id + "-f"]; };

async function oldWay(){
  const t0 = Date.now();
  const contacts = [], fresh = {};
  for (const id of OWNERS) {
    contacts.push(...await fetchStaged(id));
    const fr = await fetchFresh(id);
    if (fr.length) fresh[id] = fr;
  }
  return { ms: Date.now() - t0, contacts: contacts, fresh: fresh, usableAt: Date.now() - t0 };
}
async function newWay(concurrency){
  const t0 = Date.now();
  const contacts = [], fresh = {};
  const staged = await mapLimit(OWNERS, concurrency, function(id){ return fetchStaged(id); });
  staged.forEach(function(rows){ contacts.push(...rows); });
  const usableAt = Date.now() - t0;          // the app becomes usable here
  const fr = await mapLimit(OWNERS, concurrency, async function(id){
    return { id: id, rows: await fetchFresh(id) };
  });
  fr.forEach(function(x){ if (x.rows.length) fresh[x.id] = x.rows; });
  return { ms: Date.now() - t0, contacts: contacts, fresh: fresh, usableAt: usableAt };
}

(async function(){
  const a = await oldWay();
  const b = await newWay(4);

  console.log("\nThe finished pool is identical");
  ok("same staged leads, in the same order", JSON.stringify(a.contacts) === JSON.stringify(b.contacts));
  ok("same fresh leads per owner", JSON.stringify(a.fresh) === JSON.stringify(b.fresh));
  ok("owner with no fresh leads is absent from both", !a.fresh.o3 && !b.fresh.o3);

  console.log("\nIt is faster end to end");
  ok("four at a time beats one at a time (" + a.ms + "ms vs " + b.ms + "ms)", b.ms < a.ms * 0.6,
    b.ms + " vs " + a.ms);

  console.log("\nAnd usable far sooner, which is the point");
  ok("pages have staged leads after " + b.usableAt + "ms, against " + a.usableAt + "ms before",
    b.usableAt < a.usableAt * 0.4);
  console.log("     old: nothing at all until " + a.usableAt + "ms");
  console.log("     new: stage tables live at " + b.usableAt + "ms, everything by " + b.ms + "ms");

  console.log("\nHigher concurrency keeps the same answer");
  const c = await newWay(8);
  ok("eight at a time still identical", JSON.stringify(c.contacts) === JSON.stringify(b.contacts));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
