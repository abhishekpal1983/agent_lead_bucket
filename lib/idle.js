"use strict";
/* Call de-duplication.

   Written for the agent idle tracker, which has since been removed. The de-duplication
   outlived it because the Loop WA view counts calls per lead and hits the same problem:
   a call arrives twice. FreJun logs the dial as an INTEGRATION record, then the agent
   writes the same call up in the CRM and HubSpot logs it again. On a sampled agent that
   was 101 records for 55 conversations, and across the floor it merges about 6% of
   records. Counting records rather than calls reads high, and always in the flattering
   direction.

   Kept out of server.js and free of any I/O so the awkward part, which is arithmetic,
   can be tested without a HubSpot token or a running server.

   The shift arithmetic that used to live here went with the tracker. It is in the history
   at 4c2a53e if the floor view is ever wanted back.

   One thing here is worth keeping in mind: a connected call is not a conversation.
   Voicemail answers, so it has a duration. The floor marked exactly one call "Left
   voicemail" in two days, so the disposition cannot separate the two. Only duration can,
   and only as a proxy. */

const MIN = 60 * 1000;

const DEFAULTS = {
  dedupeMs: 2 * MIN,
  conversationMs: 60 * 1000
};

/* One call, from however many records HubSpot holds for it.

   Records merge when they are the same agent, the same lead, from different sources, and
   within the window of each other. Different sources matters: two FreJun dials to the
   same lead four minutes apart are two real attempts, and merging those would hide an
   agent redialling a dead number all afternoon. */
function dedupe(records, cfg){
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const rows = (records || []).slice().sort(function(a, b){ return (a.at || 0) - (b.at || 0); });
  const groups = {};
  const out = [];
  rows.forEach(function(r){
    const owner = String(r.owner || "none");
    // No contact means nothing to match on, so it can never be a duplicate of anything.
    const key = r.contact ? owner + " " + String(r.contact) : null;
    if (key) {
      const prior = groups[key] || [];
      let merged = false;
      for (let i = prior.length - 1; i >= 0 && !merged; i--) {
        const p = prior[i];
        if ((r.at || 0) - (p.at || 0) > c.dedupeMs) break;
        if (p.sources.indexOf(r.source) >= 0) continue;   // same source, a real second dial
        p.sources.push(r.source);
        p.ids.push(r.id);
        // FreJun carries the duration; the manual write-up carries none. Keep the longer.
        if ((r.durMs || 0) > (p.durMs || 0)) p.durMs = r.durMs || 0;
        if (r.disposition && !p.disposition) p.disposition = r.disposition;
        merged = true;
      }
      if (merged) return;
    }
    const act = {
      at: r.at || 0, durMs: r.durMs || 0, owner: owner,
      contact: r.contact ? String(r.contact) : "",
      disposition: r.disposition || "", sources: [r.source], ids: [r.id]
    };
    out.push(act);
    if (key) { groups[key] = groups[key] || []; groups[key].push(act); }
  });
  return out.map(function(a){
    a.endAt = a.at + (a.durMs || 0);
    // Answered includes voicemail and instant hangups. It is not a conversation.
    a.answered = (a.durMs || 0) > 0;
    a.conversation = (a.durMs || 0) >= c.conversationMs;
    a.merged = a.sources.length > 1;
    return a;
  });
}

module.exports = { DEFAULTS, MIN, dedupe };
