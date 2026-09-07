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

module.exports = { DEFAULTS, MIN, dedupe, writeUps };

/* The note logged after the call it describes.

   A real practice on this floor: FreJun dials and logs the call, then the agent writes the
   conversation up by hand so the notes live somewhere. That is one conversation and two
   records, and the plain de-duplication above only catches it when the two land within
   `dedupeMs` of each other. Measured against one agent's day in the portal, they mostly do
   not:

     11:02:48 -> 11:03:55    67 seconds
     08:52:31 -> 09:00:40     8 minutes
     08:32:38 -> 08:49:07    16 minutes
     14:33:36 -> 15:46:05    70 minutes

   Widening the window to seventy minutes is not the answer, because a genuine second
   attempt to the same lead an hour later would then vanish. The day is a better key than
   the clock.

   The rule: a manual record carrying no duration at all, on a lead the same agent already
   has a MEASURED call for on the same day, is the write-up of that call rather than a
   second conversation. Three things make this safe.

   A manual record with a declared length is never merged. Declaring a length is the agent
   saying "this was its own call", so the field does double duty and the rule gets stricter
   as adoption improves rather than looser.

   A record whose duration property is present but zero is measured, not missing: FreJun
   timed it and the answer was that nobody picked up. Only an absent property is unknown.

   And nothing is ever merged into another manual record. Two write-ups with no measurement
   between them are two calls, because there is no evidence they are not. */
function writeUps(records, cfg){
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const rows = (records || []).slice().sort(function(a, b){ return (a.at || 0) - (b.at || 0); });
  const dayOf = c.dayKey || function(ms){ return new Date(ms).toISOString().slice(0, 10); };
  const measured = {};                       // owner|contact|day -> the measured calls
  rows.forEach(function(r){
    if (!r.contact || !r.hasDur) return;
    const k = String(r.owner || "") + "|" + String(r.contact) + "|" + dayOf(r.at || 0);
    (measured[k] = measured[k] || []).push(r);
  });
  const out = [], absorbed = [];
  rows.forEach(function(r){
    const orphan = r.contact && !r.hasDur && !(r.declaredMs > 0) && !(r.noteMs > 0);
    if (!orphan) { out.push(r); return; }
    const k = String(r.owner || "") + "|" + String(r.contact) + "|" + dayOf(r.at || 0);
    const cand = measured[k] || [];
    if (!cand.length) { out.push(r); return; }
    /* Attach it to the nearest measured call, so a lead rung three times has the write-up
       land on the one it most likely describes rather than on the first of the day. */
    let best = cand[0], gap = Math.abs((r.at || 0) - (cand[0].at || 0));
    cand.forEach(function(m){
      const g = Math.abs((r.at || 0) - (m.at || 0));
      if (g < gap) { gap = g; best = m; }
    });
    best.writeUps = (best.writeUps || 0) + 1;
    best.writeUpGapMs = gap;
    if (r.body && !best.body) best.body = r.body;
    if (r.attach) best.attach = true;
    absorbed.push({ id: r.id, into: best.id, gapMs: gap });
  });
  return { calls: out, absorbed: absorbed };
}
