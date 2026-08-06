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
  { id: "204", name: "Neha Iyer", team: "t2" }
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
for (let i = 0; i < 40; i++) {
  rows.push(lead({ id: "EDGE_park_" + i, stage: "counselled", fu: D(2026, 8, 1, 11), last: 0,
    owner: "165087274", ownerName: "Abhishek Pal", counted: false, score: 7 }));
}
module.exports = { rows: rows, now: TODAY, agents: AGENTS,
  teams: [{ id: "t1", name: "Team Sid", managerEmail: "m1@topmate.io", agentIds: ["201", "202"] },
          { id: "t2", name: "Team Vik", managerEmail: "m2@topmate.io", agentIds: ["203", "204"] }] };
