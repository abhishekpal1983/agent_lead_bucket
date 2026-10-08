"use strict";
/* Lead management: targets, daily inflow pace, and what happened to the leads.

   Pure functions only, so the arithmetic can be tested without HubSpot. server.js owns the
   sync and hands rows in here.

   Two questions, kept apart on purpose.

   1. INFLOW. Did each creator get the leads we planned for? A monthly target per creator is
      paced evenly across the calendar month, and the month to date count is judged against
      what should have arrived by this minute (IST). Judging against whole days instead makes
      every creator look a day behind at 2am and a day ahead at 11pm.

   2. WORK. For the leads that DID arrive in the month (the create-month cohort), where are
      they now: untouched, workable, churned, counselled, enrolled. Stage buckets, counselling
      and enrolment follow the vetted definitions in the sales ops context skill:
        Workable  rcb, discovery, program/pricing pitched, counselled, Follow up, FU_DNP,
                  FU_RCB, payment_prospect
        Churned   dnp_did_not_pick, ghosted, ni_not_interested, disqualified
        Fresh     engagement stage empty
        IFC and deal_won sit outside both.
        Counselled  first entry into the counselling set, from stage HISTORY
        Enrolled    first payment per consumer per creator in the payment sheet, matched by
                    email then phone last 10 digits. Never deal_won.
      Rates here are COHORT rates (of the leads created in the month, how many have reached
      counselling / enrolment so far), which is why recent months always look weaker. */

const WORKABLE = ["rcb_requested_callback", "discovery", "program_pitched", "pricing_pitched", "counselled",
  "Follow up", "FU_DNP", "FU_RCB", "payment_prospect"];
const CHURN = ["dnp_did_not_pick", "ghosted", "ni_not_interested", "disqualified"];
// NI counts as post-counselling when it came out of one of these, or counselling_done is set.
const NI_POST_PREV = ["discovery", "program_pitched", "pricing_pitched", "counselled", "payment_prospect", "IFC",
  "Follow up", "FU_DNP", "FU_RCB"];

const IST_MS = 5.5 * 3600000;
const DAY_MS = 86400000;

function tsOf(v){
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v);
  if (/^\d{11,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}
function istDay(ms){ return ms ? new Date(ms + IST_MS).toISOString().slice(0, 10) : ""; }
function istMonth(ms){ return istDay(ms).slice(0, 7); }
function daysIn(month){
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthStartMs(month){ return Date.parse(month + "-01T00:00:00Z") - IST_MS; }
function prevMonth(month){
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 1 ? (y - 1) + "-12" : y + "-" + String(m - 1).padStart(2, "0");
}

/* Where we are in the month. elapsed is a fraction of the month, to the minute. */
function monthInfo(month, nowMs){
  const days = daysIn(month);
  const start = monthStartMs(month), end = start + days * DAY_MS;
  let elapsedDays;
  if (nowMs >= end) elapsedDays = days;
  else if (nowMs <= start) elapsedDays = 0;
  else elapsedDays = (nowMs - start) / DAY_MS;
  const todayIdx = nowMs >= start && nowMs < end ? Math.floor((nowMs - start) / DAY_MS) : -1;
  return {
    month: month, days: days, start: start, end: end,
    elapsedDays: elapsedDays, elapsedFrac: elapsedDays / days,
    isCurrent: todayIdx >= 0, isPast: nowMs >= end, isFuture: nowMs < start,
    todayIdx: todayIdx,
    // Whole days still to come, today's remainder included.
    remainingDays: Math.max(0, days - elapsedDays)
  };
}

/* Thresholds for the inflow status, in one place so the page legend can quote them. */
const PACE = { ahead: 1.10, onTrack: 0.95, slight: 0.80, silentDays: 2, weakDay: 0.60 };

/* daily: array of counts, one per calendar day of the month. */
function pace(target, daily, info){
  const mtd = daily.reduce(function(a, b){ return a + b; }, 0);
  const t = Number(target) || 0;
  const dailyTarget = t ? t / info.days : 0;
  const required = t * info.elapsedFrac;
  const pct = required > 0 ? mtd / required : null;
  // Projection from the actual run rate so far.
  const projected = info.elapsedDays > 0 ? Math.round(mtd / info.elapsedDays * info.days) : 0;
  const gap = Math.round(mtd - required);
  const needPerDay = info.isCurrent && t ? Math.max(0, (t - mtd) / Math.max(info.remainingDays, 0.5)) : null;
  const ti = info.todayIdx;
  const today = ti >= 0 ? daily[ti] : null;
  const yesterday = ti >= 1 ? daily[ti - 1] : (info.isPast ? daily[info.days - 1] : null);
  // The three complete days before today. A partial today would drag every average down.
  const lastIdx = ti >= 0 ? ti - 1 : (info.isPast ? info.days - 1 : -1);
  const window = [];
  for (let i = lastIdx; i >= 0 && window.length < 3; i--) window.push(daily[i]);
  const last3 = window.length ? window.reduce(function(a, b){ return a + b; }, 0) / window.length : null;
  // Complete days with no lead at all, counting back from yesterday. If a lead has already
  // arrived today the silence is over. 1am with nothing in yet is not a silent day.
  let silent = 0;
  if (!(ti >= 0 && daily[ti] > 0)) {
    for (let i = lastIdx; i >= 0; i--) { if (daily[i] > 0) break; silent++; }
  }

  let status = "none", label = "No target";
  if (t > 0) {
    if (info.isFuture) { status = "future"; label = "Not started"; }
    else if (pct >= PACE.ahead) { status = "ahead"; label = "Ahead"; }
    else if (pct >= PACE.onTrack) { status = "ok"; label = "On track"; }
    else if (pct >= PACE.slight) { status = "slight"; label = "Slight lag"; }
    else { status = "behind"; label = "Behind"; }
  }
  const alerts = [];
  // A creator going dark is worth knowing with or without a target.
  if (!info.isFuture && silent >= PACE.silentDays)
    alerts.push({ k: "silent", sev: "bad", t: "No new leads for " + silent + " days" });
  if (t > 0 && !info.isFuture) {
    if (yesterday !== null && dailyTarget >= 1 && yesterday < dailyTarget * PACE.weakDay)
      alerts.push({ k: "weakday", sev: "warn", t: "Yesterday " + yesterday + " vs " + Math.round(dailyTarget) + "/day needed" });
    if (last3 !== null && dailyTarget >= 1 && last3 < dailyTarget * PACE.slight && window.length === 3)
      alerts.push({ k: "slowing", sev: "warn", t: "Last 3 days averaging " + last3.toFixed(1) + "/day" });
    if (needPerDay !== null && dailyTarget > 0 && needPerDay > dailyTarget * 1.25 && mtd < t)
      alerts.push({ k: "catchup", sev: "warn", t: "Needs " + Math.ceil(needPerDay) + "/day for the rest of the month" });
  }
  return { target: t, mtd: mtd, dailyTarget: dailyTarget, required: Math.round(required), pacePct: pct,
    gap: gap, projected: projected, projectedPct: t ? projected / t : null, needPerDay: needPerDay,
    today: today, yesterday: yesterday, last3: last3, silentDays: silent, status: status, label: label,
    alerts: alerts };
}

/* First payment per consumer per creator, plus all their payments for revenue.
   Keys: creator|email and creator|p:phone10. */
function normPhone(v){ const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; }
function enrolIndex(sheetRows){
  const rows = (sheetRows || []).slice().sort(function(a, b){ return tsOf(a.date) - tsOf(b.date); });
  const byConsumer = {};   // creator|email-or-phone -> { first, revenue, payments }
  const alias = {};        // phone key -> email key, so one person is one record
  rows.forEach(function(r){
    const cr = r.creator_username || "";
    if (!cr) return;
    const em = String(r.consumer_email || "").trim().toLowerCase();
    const ph = normPhone(r.consumer_phone);
    const ke = em ? cr + "|" + em : "", kp = ph ? cr + "|p:" + ph : "";
    let key = (ke && byConsumer[ke] && ke) || (kp && alias[kp]) || ke || kp;
    if (!key) return;
    if (!byConsumer[key]) byConsumer[key] = { first: tsOf(r.date), firstPrice: Number(r.price_inr) || 0, revenue: 0, payments: 0 };
    const o = byConsumer[key];
    o.revenue += Number(r.price_inr) || 0;
    o.payments++;
    if (kp && !alias[kp]) alias[kp] = key;
    if (ke && !byConsumer[ke]) byConsumer[ke] = o;
  });
  return {
    find: function(creator, email, phone){
      const em = String(email || "").trim().toLowerCase();
      if (em && byConsumer[creator + "|" + em]) return byConsumer[creator + "|" + em];
      const ph = normPhone(phone);
      if (ph) {
        const k = alias[creator + "|p:" + ph];
        if (k && byConsumer[k]) return byConsumer[k];
      }
      return null;
    }
  };
}

function bucketOf(stage){
  if (!stage) return "fresh";
  if (WORKABLE.indexOf(stage) >= 0) return "workable";
  if (CHURN.indexOf(stage) >= 0) return "churned";
  if (stage === "IFC") return "ifc";
  if (stage === "deal_won") return "won";
  return "other";
}

function emptyFunnel(){
  return { total: 0, fresh: 0, freshOld: 0, workable: 0, churned: 0, ifc: 0, won: 0, other: 0,
    dnp: 0, ghosted: 0, ni: 0, niPre: 0, niPost: 0, dq: 0,
    unassigned: 0, touched: 0, touched24: 0, ttfHours: [], counselled: 0, enrolled: 0, enrolledCounselled: 0,
    revenue: 0, overdueFu: 0, noFu: 0, stages: {} };
}

/* One lead into a funnel. ctx: { now, counselAt(id), enrol(row) } */
function addLead(f, r, ctx){
  const stage = r.contact_engagement_stage || "";
  const b = bucketOf(stage);
  f.total++;
  f[b]++;
  f.stages[stage || "__fresh"] = (f.stages[stage || "__fresh"] || 0) + 1;
  const created = tsOf(r.createdate);
  if (!r.hubspot_owner_id) f.unassigned++;
  if (b === "fresh" && created && ctx.now - created > DAY_MS) f.freshOld++;
  if (stage === "dnp_did_not_pick") f.dnp++;
  if (stage === "ghosted") f.ghosted++;
  if (stage === "disqualified") f.dq++;
  if (stage === "ni_not_interested") {
    f.ni++;
    const post = NI_POST_PREV.indexOf(r.previous_engagement_stage || "") >= 0 ||
      String(r.counselling_done || "").toLowerCase() === "true";
    if (post) f.niPost++; else f.niPre++;
  }
  // Touched: an owner's first engagement is logged, a call is logged, or a stage was set.
  const fe = tsOf(r.hs_sa_first_engagement_date);
  if (fe || tsOf(r.last_call_date_and_time) || stage) f.touched++;
  if (fe && created) {
    const h = Math.max(0, (fe - created) / 3600000);
    f.ttfHours.push(h);
    if (h <= 24) f.touched24++;
  }
  if (b === "workable") {
    const fu = tsOf(r.follow_up_date_and_time);
    if (!fu) f.noFu++;
    else if (fu < ctx.now - DAY_MS) f.overdueFu++;
  }
  const cAt = ctx.counselAt(r);
  if (cAt) f.counselled++;
  const e = ctx.enrol(r);
  if (e) {
    f.enrolled++;
    f.revenue += e.revenue;
    if (cAt) f.enrolledCounselled++;
  }
}

function median(a){
  if (!a.length) return null;
  const s = a.slice().sort(function(x, y){ return x - y; });
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/* Rates, and drop the raw sample so the payload stays small. */
function finishFunnel(f){
  const pct = function(n, d){ return d ? n / d : null; };
  f.ttfMedianH = median(f.ttfHours);
  f.ttfN = f.ttfHours.length;
  delete f.ttfHours;
  f.staged = f.total - f.fresh;
  f.touchedPct = pct(f.touched, f.total);
  f.touched24Pct = pct(f.touched24, f.total);
  f.churnPct = pct(f.churned, f.staged);
  f.l2c = pct(f.counselled, f.total);
  f.c2e = pct(f.enrolledCounselled, f.counselled);
  f.l2e = pct(f.enrolled, f.total);
  return f;
}

module.exports = { WORKABLE, CHURN, PACE, tsOf, istDay, istMonth, daysIn, monthStartMs, prevMonth, monthInfo,
  pace, enrolIndex, normPhone, bucketOf, emptyFunnel, addLead, finishFunnel, median };
