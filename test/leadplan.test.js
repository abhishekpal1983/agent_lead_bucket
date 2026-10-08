"use strict";
/* Lead management arithmetic: pacing, lag flags, funnel buckets, enrolment matching. */
const LP = require("../lib/leadplan");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  ->  " + JSON.stringify(extra) : "")); }
}
const IST = 5.5 * 3600000;
const at = function(s){ return Date.parse(s + "Z") - IST; };   // an IST wall clock time

// Month boundaries are IST midnight.
ok("October has 31 days", LP.daysIn("2026-10") === 31);
ok("Feb 2027 has 28 days", LP.daysIn("2027-02") === 28);
ok("prev of January is December", LP.prevMonth("2027-01") === "2026-12");
ok("00:30 IST on the 1st is in the new month", LP.istMonth(at("2026-10-01T00:30:00")) === "2026-10");
ok("23:50 IST on 30 Sep is still September", LP.istMonth(at("2026-09-30T23:50:00")) === "2026-09");

// Pace is judged to the minute: noon on day 11 of 31 means 10.5 days elapsed.
const info = LP.monthInfo("2026-10", at("2026-10-11T12:00:00"));
ok("todayIdx is day 11", info.todayIdx === 10, info.todayIdx);
ok("elapsed 10.5 days", Math.abs(info.elapsedDays - 10.5) < 1e-9, info.elapsedDays);

const even = new Array(31).fill(0);
for (let i = 0; i < 10; i++) even[i] = 10;                  // 100 over ten complete days
even[10] = 5;                                                // half of today
const p = LP.pace(310, even, info);
ok("required by noon on day 11 is 105", p.required === 105, p.required);
ok("105 of 105 is on track", p.status === "ok", p.status);
ok("daily target is 10", Math.abs(p.dailyTarget - 10) < 1e-9);
ok("yesterday read from day 10", p.yesterday === 10, p.yesterday);
ok("last 3 complete days average 10, today excluded", p.last3 === 10, p.last3);
ok("no alerts when on pace", p.alerts.length === 0, p.alerts);

const behind = even.map(function(n){ return Math.round(n * 0.4); });
const pb = LP.pace(310, behind, info);
ok("40% of due is behind", pb.status === "behind", pb.status);
ok("behind flags the catch-up rate", pb.alerts.some(function(a){ return a.k === "catchup"; }), pb.alerts);

// Silence: two complete days with nothing, and nothing yet today.
const dark = even.slice(); dark[8] = 0; dark[9] = 0; dark[10] = 0;
const pd = LP.pace(310, dark, info);
ok("two empty complete days is silent 2", pd.silentDays === 2, pd.silentDays);
ok("silent alert raised", pd.alerts.some(function(a){ return a.k === "silent"; }));
const back = dark.slice(); back[10] = 3;
ok("a lead today ends the silence", LP.pace(310, back, info).silentDays === 0);
const early = LP.monthInfo("2026-10", at("2026-10-11T00:30:00"));
const nothingYet = even.slice(); nothingYet[10] = 0;
ok("00:30 with nothing yet today is not a silent day", LP.pace(310, nothingYet, early).silentDays === 0);
ok("silence is flagged even with no target", LP.pace(0, dark, info).alerts.some(function(a){ return a.k === "silent"; }));
ok("no target reads as none", LP.pace(0, even, info).status === "none");

// A finished month is judged on the whole month.
const past = LP.monthInfo("2026-09", at("2026-10-05T10:00:00"));
ok("past month is fully elapsed", past.isPast && past.elapsedFrac === 1);
const full = new Array(30).fill(10);
ok("300 of 300 in a finished month is on track", LP.pace(300, full, past).status === "ok");

// Buckets follow the vetted definitions.
ok("empty stage is fresh", LP.bucketOf("") === "fresh");
ok("Follow up with a space is workable", LP.bucketOf("Follow up") === "workable");
ok("ghosted is churned", LP.bucketOf("ghosted") === "churned");
ok("IFC is outside both", LP.bucketOf("IFC") === "ifc");
ok("deal_won is outside both", LP.bucketOf("deal_won") === "won");

// Enrolment: first payment per consumer per creator, by email then phone.
const idx = LP.enrolIndex([
  { creator_username: "a", consumer_email: "X@Y.com", consumer_phone: "+91 98765 43210", price_inr: "5000", date: "2026-10-02" },
  { creator_username: "a", consumer_email: "x@y.com", consumer_phone: "", price_inr: "15000", date: "2026-10-09" },
  { creator_username: "b", consumer_email: "z@y.com", consumer_phone: "9000000000", price_inr: "7000", date: "2026-10-03" }
]);
const e1 = idx.find("a", "x@y.com", "");
ok("email match is case-insensitive", !!e1);
ok("revenue sums balance payments", e1 && e1.revenue === 20000, e1);
ok("phone fallback matches last 10 digits", !!idx.find("a", "", "09876543210"));
ok("creator must match exactly", !idx.find("b", "x@y.com", ""));

// Funnel: NI split, touches, counselling and enrolment.
const now = at("2026-10-11T12:00:00");
const f = LP.emptyFunnel();
const ctx = { now: now, counselAt: function(r){ return r.c || 0; }, enrol: function(r){ return r.e ? { revenue: 100 } : null; } };
[
  { createdate: new Date(at("2026-10-01T10:00:00")).toISOString(), contact_engagement_stage: "", hubspot_owner_id: "1" },
  { createdate: new Date(now - 3600000).toISOString(), contact_engagement_stage: "", hubspot_owner_id: "" },
  { createdate: new Date(at("2026-10-02T10:00:00")).toISOString(), contact_engagement_stage: "ni_not_interested", previous_engagement_stage: "counselled", hubspot_owner_id: "1", c: 1,
    hs_sa_first_engagement_date: new Date(at("2026-10-02T12:00:00")).toISOString() },
  { createdate: new Date(at("2026-10-02T10:00:00")).toISOString(), contact_engagement_stage: "ni_not_interested", previous_engagement_stage: "dnp_did_not_pick", hubspot_owner_id: "1" },
  { createdate: new Date(at("2026-10-03T10:00:00")).toISOString(), contact_engagement_stage: "Follow up", hubspot_owner_id: "1", c: 1, e: 1 },
  { createdate: new Date(at("2026-10-03T10:00:00")).toISOString(), contact_engagement_stage: "deal_won", hubspot_owner_id: "1", e: 1 }
].forEach(function(r){ LP.addLead(f, r, ctx); });
LP.finishFunnel(f);
ok("six leads", f.total === 6);
ok("two fresh, one older than a day", f.fresh === 2 && f.freshOld === 1, f);
ok("one unassigned", f.unassigned === 1);
ok("NI split pre 1 / post 1", f.niPre === 1 && f.niPost === 1, f);
ok("churn rate over staged leads", Math.abs(f.churnPct - 2 / 4) < 1e-9, f.churnPct);
ok("counselled 2, enrolled 2, enrolled after counselling 1", f.counselled === 2 && f.enrolled === 2 && f.enrolledCounselled === 1, f);
ok("C2E is 1 of 2", f.c2e === 0.5);
ok("workable with no follow-up counted", f.noFu === 1);
ok("first touch in 2h counts within 24h", f.touched24 === 1 && f.ttfMedianH === 2, f);

console.log((fail ? "FAILED " : "passed ") + pass + "/" + (pass + fail));
process.exit(fail ? 1 : 0);
