"use strict";
const { mapLimit, instrument } = require("../lib/pool");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " -> " + extra : "")); }
}
const sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

(async function(){
  console.log("\nResults come back in order, whatever order they finish in");
  {
    const items = [50, 10, 30, 5, 20];
    const out = await mapLimit(items, 3, async function(ms, i){ await sleep(ms); return i + ":" + ms; });
    ok("order preserved", JSON.stringify(out) === JSON.stringify(["0:50","1:10","2:30","3:5","4:20"]),
      JSON.stringify(out));
  }

  console.log("\nThe cap actually holds");
  {
    const fn = instrument(async function(){ await sleep(20); return 1; });
    await mapLimit(new Array(20).fill(0), 4, fn);
    ok("never more than 4 in flight, peak was " + fn.peak(), fn.peak() <= 4);
    ok("and it did use the full cap", fn.peak() === 4);
  }

  console.log("\nParallel is faster, and gives the same answer");
  {
    const owners = new Array(19).fill(0).map(function(_, i){ return "owner" + i; });
    const work = async function(id){ await sleep(40); return id + ":leads"; };
    const t1 = Date.now();
    const seq = await mapLimit(owners, 1, work);
    const seqMs = Date.now() - t1;
    const t2 = Date.now();
    const par = await mapLimit(owners, 4, work);
    const parMs = Date.now() - t2;
    ok("identical output", JSON.stringify(seq) === JSON.stringify(par));
    ok("four at a time is at least twice as quick (" + seqMs + "ms vs " + parMs + "ms)", parMs * 2 < seqMs);
  }

  console.log("\nOne owner failing does not take the whole sync down");
  {
    let seen = 0;
    const out = await mapLimit([1,2,3,4,5], 2, async function(x){
      seen++;
      try { if (x === 3) throw new Error("owner 3 is broken"); return x * 2; }
      catch (e) { return null; }          // this is how sync() handles it: log and carry on
    });
    ok("every owner attempted", seen === 5);
    ok("the broken one is null, the rest are fine", JSON.stringify(out) === JSON.stringify([2,4,null,8,10]),
      JSON.stringify(out));
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
