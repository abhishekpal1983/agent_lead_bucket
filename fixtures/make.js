"use strict";
/* A synthetic pool holding one lead of every awkward shape, so the page can be driven
   locally without a HubSpot token. Deterministic: same output every run. */
const cn2 = require("../lib/cn2");
const D = function(y, m, d, h){ return Date.UTC(y, m - 1, d, (h || 10) - 5, -30); };
const TODAY = D(2026, 8, 6, 12);                 // a Thursday
const day = cn2.dayBoundsFor(TODAY);
const AGENTS = [
  { id: "201", name: "Sid Menon", team: "t1" },
  { id: "202", name: "Rhea Kapoor", team: "t1" },
  { id: "203", name: "Vikram Rao", team: "t2" },
  { id: "204", name: "Neha Iyer", team: "t2" },
  // Has left. Still holding leads, which is the whole point of the assignment pool.
  { id: "205", name: "Gone Gita", team: "t1", active: false }
];
const CREATORS = ["ayush_singh13", "payalineurope", "ankita_gulati"];
const STAGES = ["counselled", "program_pitched", "discovery", "pricing_pitched", "Follow up",
  "payment_prospect", "FU_DNP", "FU_RCB", "rcb_requested_callback", "dnp_did_not_pick", "__fresh"];

// Deterministic pseudo-random, so the fixture is varied but identical on every run.
let seed = 20260806;
function rnd(){ seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
let n = 0;
function lead(o){
  n++;
  const a = AGENTS[n % AGENTS.length];
  return Object.assign({
    id: "L" + String(1000 + n),
    name: "Lead " + n,
    stage: STAGES[n % STAGES.length],
    owner: a.id, ownerName: a.name, creator: CREATORS[n % CREATORS.length],
    fu: 0, last: 0, formLast: 0, forms: [], score: 0, intl: false,
    // When the lead landed in its current stage. DNP coverage measures attempts against
    // the working days since this, so a fixture without it leaves that path untested.
    entered: D(2026, 8, 1 + (n % 5), 10),
    // Loop's WhatsApp summary. Zero for most leads; the block below gives a realistic
    // handful a conversation, including some in closed stages, because that is the whole
    // point of the Loop WA view and a fixture without them tests nothing.
    waReplied: false, waN: 0, waAt: 0, waOut: 0, waLast: "",
    // Assigned long before today unless a case below says otherwise.
    assignedAt: D(2026, 7, 20, 11), role: "", tech: "",
    calls: 0, own: 0, phone: "+9190000000" + (n % 10), needsOwner: false
  }, o);
}
const rows = [];
// bulk, spread across every stage and timing so the table has body
for (let i = 0; i < 240; i++) {
  const mode = Math.floor(rnd() * 6);
  const calledToday = rnd() < 0.28;                          // roughly a real day's coverage
  rows.push(lead({
    fu: mode === 0 ? D(2026, 8, 6, 14)                       // due today, 2pm
      : mode === 1 ? D(2026, 8, 3, 11)                       // overdue by days
      : mode === 2 ? 0                                       // no follow-up
      : mode === 3 ? D(2026, 8, 20, 11)                      // scheduled ahead
      : mode === 4 ? D(2026, 8, 9, 11)                       // Sunday, rolls forward
      : D(2026, 8, 5, 16),                                   // overdue by one day
    last: calledToday ? day.start + Math.floor(rnd() * 12) * 3600000
      : (rnd() < 0.4 ? D(2026, 7, 28, 11) : 0),
    calls: Math.floor(rnd() * 5), own: Math.floor(rnd() * 3),
    score: rnd() < 0.22 ? 6 + Math.floor(rnd() * 4) : 0,
    intl: rnd() < 0.15,
    forms: rnd() < 0.08 ? ["waitlist"] : []
  }));
}
// the shapes that break things
rows.push(lead({ id: "EDGE_dnp_parked", stage: "dnp_did_not_pick", fu: D(2026, 8, 1, 11), last: 0 }));
rows.push(lead({ id: "EDGE_dnp_priority", stage: "dnp_did_not_pick", fu: D(2026, 8, 1, 11), last: 0, score: 9 }));
rows.push(lead({ id: "EDGE_ifc_due", stage: "IFC", fu: D(2026, 8, 6, 11), last: 0 }));
rows.push(lead({ id: "EDGE_ifc_over", stage: "IFC", fu: D(2026, 8, 2, 11), last: 0 }));
rows.push(lead({ id: "EDGE_ifc_ahead", stage: "IFC", fu: D(2026, 8, 25, 11), last: 0 }));
rows.push(lead({ id: "EDGE_refill_ghosted", stage: "ghosted", formLast: D(2026, 8, 5, 9), last: D(2026, 7, 20, 9), forms: ["waitlist"] }));
rows.push(lead({ id: "EDGE_refill_won", stage: "deal_won", formLast: D(2026, 8, 5, 9), last: D(2026, 7, 20, 9), forms: ["waitlist"] }));
rows.push(lead({ id: "EDGE_refill_dq", stage: "disqualified", formLast: D(2026, 8, 5, 9), last: D(2026, 7, 20, 9), forms: ["waitlist"] }));
rows.push(lead({ id: "EDGE_form_before_call", stage: "ni_not_interested", formLast: D(2026, 7, 1, 9), last: D(2026, 8, 1, 9), forms: ["waitlist"] }));
rows.push(lead({ id: "EDGE_2pm_today", stage: "counselled", fu: D(2026, 8, 6, 14), last: 0, score: 7 }));
rows.push(lead({ id: "EDGE_sunday_fu", stage: "counselled", fu: D(2026, 8, 9, 11), last: 0 }));
rows.push(lead({ id: "EDGE_needs_owner", stage: "counselled", fu: 0, last: 0, owner: "", ownerName: "(unassigned)", needsOwner: true, score: 8 }));
rows.push(lead({ id: "EDGE_called_today", stage: "counselled", fu: D(2026, 8, 6, 9), last: day.start + 7200000, score: 8 }));
// Arrived after the base was frozen. They qualify now, they were not in this morning's
// list, and the calls made on them are off-base effort rather than coverage.
rows.push(lead({ id: "EDGE_arrived_called", stage: "__fresh", fu: 0, last: day.start + 5400000, arrivedToday: true }));
rows.push(lead({ id: "EDGE_arrived_called2", stage: "counselled", fu: D(2026, 8, 6, 15), last: day.start + 9000000, score: 9, arrivedToday: true }));
rows.push(lead({ id: "EDGE_arrived_quiet", stage: "counselled", fu: D(2026, 8, 6, 15), last: 0, arrivedToday: true }));
// Shown but never counted: an unassigned lead and a parking bucket that holds a pile.
rows.push(lead({ id: "EDGE_unassigned", stage: "counselled", fu: D(2026, 8, 1, 11), last: 0,
  owner: "", ownerName: "(unassigned)", needsOwner: true, counted: false, score: 8 }));
/* The assignment pool: fresh leads nobody is working. Some with no owner at all, some
   still sitting with an agent who has left. Both are handed out by a manager. */
for (let i = 0; i < 7; i++) {
  rows.push(lead({ id: "EDGE_fresh_unassigned_" + i, stage: "__fresh", fu: 0, last: 0,
    creator: CREATORS[i % CREATORS.length], owner: "", ownerName: "(unassigned)",
    needsOwner: true, counted: false }));
}
for (let i = 0; i < 4; i++) {
  rows.push(lead({ id: "EDGE_fresh_left_" + i, stage: "__fresh", fu: 0, last: 0,
    creator: CREATORS[i % CREATORS.length], owner: "205", ownerName: "Gone Gita",
    needsOwner: true, counted: false }));
}
for (let i = 0; i < 40; i++) {
  rows.push(lead({ id: "EDGE_park_" + i, stage: "counselled", fu: D(2026, 8, 1, 11), last: 0,
    owner: "165087274", ownerName: "Abhishek Pal", counted: false, score: 7 }));
}
/* Leads who have answered on WhatsApp. Deliberately spread across open and closed
   stages, some rung since they replied and some not, so both sides of the one signal the
   Loop WA view is built on are exercised. */
const WA_SAID = ["Next 6-12 months", "We can talk today 2 hours from now", "Kuwait standard time",
  "Just exploring", "Not interested", "Permanent EU job", "Ok", "5:30 berlin time"];
const waIds = [];
rows.forEach(function(r, i){
  if (i % 7) return;
  const replyAt = D(2026, 8, 5, 9 + (i % 8));
  r.waReplied = true;
  r.waN = 1 + (i % 12);
  r.waAt = replyAt;
  r.waOut = replyAt - 3600000;
  r.waLast = WA_SAID[i % WA_SAID.length];
  // Half of them have not been rung since they wrote back.
  if (i % 2 === 0) r.last = 0;
  waIds.push(r.id);
});
// A member we do not hold at all, so "in the list but not in our pool" is a real number
// in the fixture rather than a branch nobody ever walks.
waIds.push("NOT_IN_POOL_1");

/* Leads assigned today, in the three shapes assignment actually comes in. Without these
   the assignment rule is untested and would pass against a fixture where nothing ever
   changes hands. */
rows.push(lead({ id: "ASSIGN_NEW", stage: "counselled", owner: "201", ownerName: "Sid Menon",
  creator: "ayush_singh13", fu: D(2026, 8, 6, 15), last: 0,
  // Created and handed over after the list was written this morning.
  assignedAt: TODAY + 60 * 60000 }));
rows.push(lead({ id: "ASSIGN_FROM_NOBODY", stage: "discovery", owner: "202",
  ownerName: "Rhea Kapoor", creator: "payalineurope", fu: D(2026, 8, 6, 16), last: 0,
  needsOwner: false, assignedAt: TODAY + 90 * 60000 }));
rows.push(lead({ id: "ASSIGN_MOVED", stage: "program_pitched", owner: "203",
  ownerName: "Vikram Rao", creator: "ayush_singh13", fu: D(2026, 8, 6, 14), last: 0,
  assignedAt: TODAY + 120 * 60000 }));
// A few roles to classify, including one that is genuinely either.
rows.slice(0, 6).forEach(function(r, i){
  r.role = ["Senior Software Engineer", "Chef", "Business Analyst", "Data Engineer",
            "Consultant", ""][i];
});

/* A shift's worth of call records for the idle tracker.

   Deliberately awkward, because every one of these shapes exists in the portal and each
   one breaks a naive implementation: FreJun and the agent logging the same call, genuine
   redials to one lead, dials that never connected, a call with no agent on it, and one
   with a date somebody typed wrong. */
const AT = function(h, m){ return D(2026, 8, 6, h) + (m || 0) * 60000; };
const calls = [];
let cseq = 0;
function call(owner, contact, h, m, durMs, source, disposition){
  cseq++;
  calls.push({ id: "CALL" + (9000 + cseq), at: AT(h, m), durMs: durMs || 0,
    disposition: disposition || "", owner: owner, source: source || "INTEGRATION",
    contact: contact ? String(contact) : "" });
  return calls[calls.length - 1];
}
// 201 works steadily right through, and logs many of his calls twice.
[[12,40],[12,52],[13,10],[13,26],[13,44],[14,5],[14,20],[15,10],[15,28],[15,50],
 [16,12],[16,30],[16,48],[17,40],[18,2],[18,30],[19,10],[19,44],[20,20],[21,5]]
  .forEach(function(t, i){
    const cid = 7000 + i;
    call("201", cid, t[0], t[1], i % 3 === 0 ? 0 : 40000 + i * 9000);
    // The manual write-up, half a minute later, on the same lead.
    if (i % 2 === 0) call("201", cid, t[0], t[1], 0, "CRM_UI");
  });
// Three real redials to one lead, minutes apart. These must never be merged.
call("201", 7999, 13, 5, 0);
call("201", 7999, 13, 9, 669200);
call("201", 7999, 13, 21, 4400);
// 202 stops after lunch and never comes back: the case the tracker exists for.
[[12,45],[13,15],[13,50],[14,10]].forEach(function(t, i){
  call("202", 7100 + i, t[0], t[1], i === 1 ? 0 : 52000);
});
// 203 has one long unexplained gap in the middle of the shift.
[[12,35],[13,5],[13,40],[17,50],[18,20],[19,0],[20,10],[21,20]].forEach(function(t, i){
  call("203", 7200 + i, t[0], t[1], i % 2 ? 0 : 91000);
});
// 204 barely starts.
call("204", 7300, 20, 15, 12000);
// Nobody's call, and a call somebody dated in October.
call("", 7400, 15, 0, 30000);
calls.push({ id: "CALLBAD", at: D(2026, 10, 15, 11), durMs: 0, disposition: "",
  owner: "201", source: "CRM_UI", contact: "7401" });

module.exports = {
  waIds: waIds, calls: calls, rows: rows, now: TODAY, agents: AGENTS,
  teams: [{ id: "t1", name: "Team Sid", managerEmail: "m1@topmate.io", agentIds: ["201", "202", "205"],
            creators: ["ayush_singh13", "ankita_gulati"] },
          { id: "t2", name: "Team Vik", managerEmail: "m2@topmate.io", agentIds: ["203", "204"],
            creators: ["payalineurope"] }] };
