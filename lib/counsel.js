"use strict";
/* What a lead's stage history says happened to it.

   The whole point of this file is that a counselling is not a stage, it is a transition,
   and HubSpot only stores the stage. `previous_engagement_stage` looks like it would
   answer this and does not: on all 702 leads that changed stage on 4 September 2026 it
   held the same value as the current stage, `counselled` following `counselled`, so it
   cannot tell a first counselling from a lead cycling through the same stage twice.
   Everything here therefore comes from walking the full property history.

   Three ideas, and the rest is bookkeeping.

   A counselling is the FIRST time a lead reaches any of the four stages. A lead that
   climbs Discovery, Program pitched, Pricing pitched and Counselled inside one afternoon
   is one counselling, not four, because one person was counselled once. Later climbs are
   progress and are worth seeing, but they are not new counsellings.

   A repeat is entering a stage the lead has already been in. Progress is not a repeat:
   Discovery then Program pitched is two different stages. Discovery, Program pitched,
   Discovery again is a repeat, and it is the shape that inflates any counting rule which
   trusts stage changes.

   A reversal is going backwards. Two kinds, asked about separately because they mean
   different things. Coming back into a counselling stage out of Follow up, FU-DNP or
   FU-RCB means somebody re-opened a conversation that had already moved on. Dropping into
   DNP or RCB after having been counselled means a lead who had a real conversation is
   being filed as one nobody has reached yet.

   None of this is proof of anything. A lead can genuinely be counselled, go quiet, and be
   counselled again months later. These are for looking at, not for accusing with, and the
   view says so in as many words. */

/* The four stages a counselling conversation lands in. `Follow up` really does carry a
   space and a capital F in HubSpot; it is not a typo and must not be tidied. */
const COUNSEL_STAGES = ["discovery", "program_pitched", "pricing_pitched", "counselled"];

/* Where a lead sits once counselling has happened and the conversation is parked. */
const POST_STAGES = ["Follow up", "FU_DNP", "FU_RCB"];

/* Stages for a lead nobody has had a real conversation with yet. Landing here after a
   counselling is the backwards move. `dnp_other` is included because the portal holds
   both spellings and only one of them is in the documented enum. */
const PRE_STAGES = ["dnp_did_not_pick", "dnp_other", "rcb_requested_callback"];

const LABELS = {
  discovery: "Discovery",
  program_pitched: "Program pitched",
  pricing_pitched: "Pricing pitched",
  counselled: "Counselled",
  "Follow up": "Follow up",
  FU_DNP: "FU-DNP",
  FU_RCB: "FU-RCB",
  dnp_did_not_pick: "DNP",
  dnp_other: "DNP",
  rcb_requested_callback: "RCB",
  payment_prospect: "Payment prospect",
  ni_not_interested: "Not interested",
  ghosted: "Ghosted",
  disqualified: "Disqualified",
  deal_won: "Deal won",
  IFC: "Interested in future",
  "": "Fresh"
};

function labelOf(stage){ return LABELS[stage] || String(stage || "Fresh"); }
function isCounsel(s){ return COUNSEL_STAGES.indexOf(s) >= 0; }
function isPost(s){ return POST_STAGES.indexOf(s) >= 0; }
function isPre(s){ return PRE_STAGES.indexOf(s) >= 0; }

/* HubSpot returns history newest first and the order is not promised anywhere, so it is
   sorted rather than trusted. Entries without a parseable timestamp are dropped: an event
   that cannot be placed on a day is useless to a per-day report, and guessing where it
   goes would put somebody's counselling on the wrong date.

   Consecutive duplicates are collapsed. A workflow rewriting the same value produces two
   history entries and no transition, and counting that as a repeat would flag an agent
   for something an automation did. */
function timeline(history){
  const rows = (history || []).map(function(e){
    return { stage: String(e && e.value != null ? e.value : ""), at: Date.parse(e && e.timestamp) };
  }).filter(function(r){ return !isNaN(r.at) && r.at > 0; });
  rows.sort(function(a, b){ return a.at - b.at; });
  const out = [];
  rows.forEach(function(r){
    if (out.length && out[out.length - 1].stage === r.stage) return;
    out.push(r);
  });
  return out;
}

/* Every event this lead's history contains, in order.

   Each event carries the day it happened so the caller can bucket by date without
   re-deriving anything, and the stage it came from, because "Counselled, from DNP" and
   "Counselled, from Pricing pitched" are different stories to a manager. */
function eventsFor(history, opts){
  const o = opts || {};
  const dayKeyOf = o.dayKey || function(ms){ return new Date(ms).toISOString().slice(0, 10); };
  const tl = timeline(history);
  const events = [];
  const seen = {};              // stages this lead has already been in
  let counselledAt = 0;         // when it first reached any of the four

  tl.forEach(function(r, i){
    const from = i ? tl[i - 1].stage : "";
    const base = { at: r.at, day: dayKeyOf(r.at), stage: r.stage, from: from,
      label: labelOf(r.stage), fromLabel: labelOf(from) };

    if (isCounsel(r.stage)) {
      if (!counselledAt) {
        counselledAt = r.at;
        events.push(Object.assign({ kind: "counselling" }, base));
      } else if (seen[r.stage]) {
        /* Been in this exact stage before. Going round, not forward. */
        events.push(Object.assign({ kind: "repeat" }, base));
      } else if (isPost(from)) {
        /* A stage it has not been in before, but reached by coming back out of a
           follow-up stage. Progress and reversal look identical without the `from`. */
        events.push(Object.assign({ kind: "reopened" }, base));
      } else {
        events.push(Object.assign({ kind: "progress" }, base));
      }
    } else if (isPre(r.stage) && counselledAt) {
      /* Counselled, then filed as somebody nobody has spoken to. */
      events.push(Object.assign({ kind: "dropped" }, base));
    }

    seen[r.stage] = true;
  });

  return { events: events, counselledAt: counselledAt, timeline: tl };
}

/* The events that fall on one day, with the lead's first counselling separated out.

   `counselling` is the headline and there is at most one per lead ever, so a day's count
   is a count of people rather than of stage changes. The rest are flags. */
function dayFor(history, dayKey, opts){
  const r = eventsFor(history, opts);
  const mine = r.events.filter(function(e){ return e.day === dayKey; });
  const of = function(k){ return mine.filter(function(e){ return e.kind === k; }); };
  return {
    counselling: of("counselling")[0] || null,
    progress: of("progress"),
    repeat: of("repeat"),
    reopened: of("reopened"),
    dropped: of("dropped"),
    events: mine,
    counselledAt: r.counselledAt
  };
}

/* How long the lead was talked to, and whether we actually know.

   "Under ten minutes" and "we hold no duration for this" are different statements and the
   second must never be printed as the first. 137 call logs in the last 30 days carry a
   screenshot and not one of them carries a duration, so an agent working over WhatsApp
   would be marked as rushing every conversation by a rule that reads a missing number as
   zero. One agent logged 41 calls in a day totalling five minutes.

   `calls` arrives already deduplicated, because FreJun logs the dial and the agent writes
   the same call up again a minute later. */
function talkFor(calls, opts){
  const o = opts || {};
  const minMs = o.shortMs == null ? 600000 : o.shortMs;
  const rows = calls || [];
  const dated = rows.filter(function(c){ return (c.durMs || 0) > 0; });
  const ms = dated.reduce(function(n, c){ return n + (c.durMs || 0); }, 0);
  return {
    calls: rows.length,
    withDuration: dated.length,
    ms: ms,
    unknown: rows.length > 0 && dated.length === 0,
    none: rows.length === 0,
    short: dated.length > 0 && ms < minMs
  };
}

module.exports = {
  COUNSEL_STAGES, POST_STAGES, PRE_STAGES, LABELS,
  labelOf, isCounsel, isPost, isPre,
  timeline, eventsFor, dayFor, talkFor
};
