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
    // When the lead arrived. Spread across the month so the create-date cohort has
    // columns to draw rather than one lonely bar.
    created: D(2026, 8, 1 + (n % 28), 9 + (n % 8)),
    /* The qualifying axes the cohort splits on. Spread deliberately, including leads that
       answered nothing, because "no answer" is a real and common outcome and a fixture
       where everybody answered would hide it. */
    sp: ["S", "P", "?", "P", "S", "?"][n % 6],
    roleClass: ["tech", "nontech", "white", "blue", "unclear", ""][n % 6],
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

/* Two import spikes, because a real month is not flat. August ran from 3 leads on a quiet
   day to 1,962 on an import day, and a fixture where every day looks the same never
   exercises the heat colouring at all. */
[[3, 40, "__fresh"], [5, 90, "__fresh"], [10, 30, "dnp_did_not_pick"], [17, 25, "FU_DNP"]]
  .forEach(function(spike){
    for (var i = 0; i < spike[1]; i++) {
      rows.push(lead({ stage: spike[2], created: D(2026, 8, spike[0], 11),
        owner: i % 4 ? AGENTS[i % 4].id : "", fu: 0, last: 0 }));
    }
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


/* ---------- stage history, for the counselling ledger ------------------------------

   Deliberately one lead of every shape the walker has to tell apart, because a fixture
   where everybody simply climbs to Counselled would let three separate bugs pass. The
   ledger day is TODAY, a Thursday.

   Attached to leads that already exist in `rows`, so the ledger's owner, creator and
   follow-up fields come from the same place the rest of the page reads them. */
const HTODAY = function(h, m){ return new Date(D(2026, 8, 6, h) + (m || 0) * 60000).toISOString(); };
const HPAST = function(d, h){ return new Date(D(2026, 8, d, h || 10)).toISOString(); };
const history = {};
const ledgerCalls = [];
let lseq = 0;
function hcall(owner, contact, h, m, durMs, source, body, attach, declaredMs){
  lseq++;
  ledgerCalls.push({ id: "LCALL" + (5000 + lseq), at: D(2026, 8, 6, h) + (m || 0) * 60000,
    durMs: durMs || 0, disposition: "", owner: owner, source: source || "INTEGRATION",
    contact: String(contact), body: body || "", attach: !!attach,
    declaredMs: declaredMs || 0 });
}

/* Pick real leads out of the pool so owner and creator are consistent with everything
   else on the page. Sorted by id so the choice is stable run to run. */
const pick = rows.slice().sort(function(a, b){ return a.id < b.id ? -1 : 1; });
const L = function(i){ return pick[i]; };

/* 1. A clean climb. All four stages in one afternoon: ONE counselling, three progress.
      This is the case that separates counting people from counting stage changes. */
history[L(0).id] = [
  { value: "", timestamp: HPAST(1) },
  { value: "discovery", timestamp: HTODAY(13) },
  { value: "program_pitched", timestamp: HTODAY(14) },
  { value: "pricing_pitched", timestamp: HTODAY(15) },
  { value: "counselled", timestamp: HTODAY(16) }
];
L(0).fu = D(2026, 8, 8, 11);
hcall(L(0).owner, L(0).id, 13, 5, 1500000);          // 25 minutes, comfortably fine

/* 2. Going round rather than forward: Discovery, pitched, Discovery again. */
history[L(1).id] = [
  { value: "discovery", timestamp: HTODAY(11) },
  { value: "program_pitched", timestamp: HTODAY(12) },
  { value: "discovery", timestamp: HTODAY(17) }
];
L(1).fu = D(2026, 8, 7, 15);
hcall(L(1).owner, L(1).id, 11, 10, 900000);

/* 3. Counselled in July, re-opened out of Follow up today. Not a counselling today,
      however much it moves, and the floor total triples if that rule is got wrong. */
history[L(2).id] = [
  { value: "discovery", timestamp: HPAST(2, 9) },
  { value: "counselled", timestamp: HPAST(2, 11) },
  { value: "Follow up", timestamp: HPAST(3, 10) },
  { value: "pricing_pitched", timestamp: HTODAY(14, 20) }
];
L(2).fu = 0;                                          // and no next call set
hcall(L(2).owner, L(2).id, 14, 0, 780000);

/* 4. Counselled today, then filed as somebody nobody has spoken to. */
history[L(3).id] = [
  { value: "discovery", timestamp: HTODAY(10) },
  { value: "counselled", timestamp: HTODAY(12) },
  { value: "dnp_did_not_pick", timestamp: HTODAY(18) }
];
L(3).fu = D(2026, 8, 9, 10);
hcall(L(3).owner, L(3).id, 10, 30, 1200000);

/* 5. A counselling with four minutes of talking behind it. Genuinely short. */
history[L(4).id] = [{ value: "counselled", timestamp: HTODAY(15, 30) }];
L(4).fu = D(2026, 8, 7, 12);
hcall(L(4).owner, L(4).id, 15, 0, 140000);
hcall(L(4).owner, L(4).id, 15, 20, 100000);

/* 6. A counselling logged over WhatsApp: a screenshot and no duration anywhere. This
      must read as "we do not know", never as "under ten minutes". 137 real call logs in
      thirty days look exactly like this and not one carries a duration. */
history[L(5).id] = [
  { value: "discovery", timestamp: HTODAY(11, 15) },
  { value: "counselled", timestamp: HTODAY(13, 40) }
];
L(5).fu = D(2026, 8, 10, 16);
hcall(L(5).owner, L(5).id, 11, 0, 0, "CRM_UI", "", true);

/* 7. The same, except the agent typed the length into the note. Free to read, and it
      settles the question without anybody paying to look at an image. */
history[L(6).id] = [{ value: "counselled", timestamp: HTODAY(16, 10) }];
L(6).fu = D(2026, 8, 8, 9);
hcall(L(6).owner, L(6).id, 16, 0, 0, "CRM_UI", "<p>40mins call, sending details</p>", true);

/* 8. A lead that moved into DNP having never been counselled. Not a flag: 199 leads did
      exactly this on one real Thursday and flagging them would drown the view. */
history[L(7).id] = [
  { value: "", timestamp: HPAST(4) },
  { value: "dnp_did_not_pick", timestamp: HTODAY(12, 45) }
];

/* 9. A workflow rewriting the same value. One entry, no repeat, nobody accused of
      anything an automation did. */
history[L(8).id] = [
  { value: "counselled", timestamp: HTODAY(9, 0) },
  { value: "counselled", timestamp: HTODAY(9, 0) },
  { value: "counselled", timestamp: HTODAY(14, 0) }
];
L(8).fu = D(2026, 8, 11, 11);
hcall(L(8).owner, L(8).id, 9, 0, 660000);

/* 10. A counselling by the agent who has left, so scoping and the inactive marker both
       have something to act on. */
const gone = rows.filter(function(r){ return r.owner === "205"; })[0];
if (gone) {
  history[gone.id] = [{ value: "discovery", timestamp: HTODAY(10, 5) }];
  gone.fu = 0;
  hcall("205", gone.id, 10, 0, 300000);
}

/* 12. The agent filled the length in by hand: a WhatsApp counselling with a screenshot,
       no duration, and 22 minutes declared. This is the case the new property exists for
       and it must read as 22 minutes of declared talk, never as unknown and never as
       short. */
const declared = rows.filter(function(r){ return r.owner === "203" && !history[r.id]; })[0];
if (declared) {
  history[declared.id] = [{ value: "counselled", timestamp: HTODAY(14, 5) }];
  declared.fu = D(2026, 8, 10, 10);
  hcall("203", declared.id, 14, 0, 0, "CRM_UI", "spoke on WA", true, 22 * 60000);
}

/* 13. A measured call that ALSO carries a declared number, because an agent filled the
       field in on a FreJun call too. The measured figure must win outright: adding them
       would count one conversation twice and reward filling the box in. */
const both = rows.filter(function(r){ return r.owner === "203" && !history[r.id]; })[0];
if (both) {
  history[both.id] = [{ value: "discovery", timestamp: HTODAY(16, 40) }];
  both.fu = D(2026, 8, 11, 10);
  hcall("203", both.id, 16, 0, 900000, "INTEGRATION", "", false, 45 * 60000);
}

/* 11. The shape that started this whole view: an agent whose whole day carries no
       duration at all. On 4 September one real agent logged 41 calls totalling five
       minutes, and the page has to say that it cannot tell a floor of unanswered dials
       from conversations whose length never reached HubSpot. Without a fixture agent in
       this state the warning that says so is never rendered by any test. */
const quiet = rows.filter(function(r){ return r.owner === "204" && !history[r.id]; }).slice(0, 2);
quiet.forEach(function(r, i){
  history[r.id] = [{ value: i ? "discovery" : "counselled", timestamp: HTODAY(12 + i, 25) }];
  r.fu = D(2026, 8, 9, 12);
  hcall("204", r.id, 12 + i, 0, 0, "CRM_UI", "spoke to cx", true);
  hcall("204", r.id, 12 + i, 40, 0, "INTEGRATION");
});

/* A meeting that was actually held, attached to a lead, and one creator session with no
   lead on it that must stay out of anybody's talktime. */
const meetings = [
  { id: "MEET1", at: D(2026, 8, 6, 17), durMs: 2400000, owner: L(0).owner,
    title: "Counselling call", contact: L(0).id },
  { id: "MEET2", at: D(2026, 8, 6, 15), durMs: 4900000, owner: L(1).owner,
    title: "From Beginner to Host: a creator session", contact: "" }
];

/* A call the day before, so a day boundary bug shows up as a wrong total rather than as
   nothing at all. */
ledgerCalls.push({ id: "LCALLPREV", at: D(2026, 8, 5, 15), durMs: 1800000, disposition: "",
  owner: L(0).owner, source: "INTEGRATION", contact: L(0).id, body: "", attach: false });

module.exports = {
  waIds: waIds, calls: calls, rows: rows, now: TODAY, agents: AGENTS,
  history: history, ledgerCalls: ledgerCalls, meetings: meetings,
  teams: [{ id: "t1", name: "Team Sid", managerEmail: "m1@topmate.io", agentIds: ["201", "202", "205"],
            creators: ["ayush_singh13", "ankita_gulati"] },
          { id: "t2", name: "Team Vik", managerEmail: "m2@topmate.io", agentIds: ["203", "204"],
            creators: ["payalineurope"] }] };
