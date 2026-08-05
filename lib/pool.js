"use strict";
/* Run an async job over a list with a cap on how many run at once.
   Pure, so the boot sync's concurrency can be tested without touching HubSpot. */
async function mapLimit(items, limit, fn){
  const n = items.length;
  const out = new Array(n);
  let next = 0, active = 0, done = 0;
  const cap = Math.max(1, Math.min(limit | 0 || 1, n || 1));
  return new Promise(function(resolve, reject){
    if (!n) return resolve(out);
    let failed = false;
    const pump = function(){
      while (active < cap && next < n && !failed) {
        const i = next++;
        active++;
        Promise.resolve()
          .then(function(){ return fn(items[i], i); })
          .then(function(v){ out[i] = v; })
          .catch(function(e){ failed = true; reject(e); })
          .then(function(){
            active--; done++;
            if (done === n && !failed) resolve(out);
            else pump();
          });
      }
    };
    pump();
  });
}
// Highest number of jobs that were ever in flight at once, for asserting the cap holds.
function instrument(fn){
  let live = 0, peak = 0;
  const wrapped = async function(){
    live++; if (live > peak) peak = live;
    try { return await fn.apply(null, arguments); }
    finally { live--; }
  };
  wrapped.peak = function(){ return peak; };
  return wrapped;
}
module.exports = { mapLimit, instrument };
