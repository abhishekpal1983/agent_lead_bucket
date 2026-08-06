"use strict";
/* Call Now v2 logic, kept as pure functions with no HubSpot and no Express in sight, so
   the whole model can be exercised locally against fixtures before it goes anywhere.
   server.js supplies the leads; everything below only reads plain objects. */

// Sunday off by default. A follow-up that lands on a non-working day rolls forward to the
// next working day as due, rather than being counted as a miss nobody could have made.
const DEFAULT_WORK_DAYS = "1,2,3,4,5,6";
const IST_OFFSET = 5.5 * 3600000;

function workDaySet(spec){
  const s = {};
  String(spec || DEFAULT_WORK_DAYS).split(",").forEach(function(x){
    const n = parseInt(String(x).trim(), 10);
    if (n >= 0 && n <= 6) s[n] = true;
  });
  return s;
}
function istDayIndex(ms){ return Math.floor((ms + IST_OFFSET) / 86400000); }
function istDayStart(idx){ return idx * 86400000 - IST_OFFSET; }
function istWeekday(idx){
  // 1970-01-01 was a Thursday, so day index 0 is weekday 4.
  return (((idx + 4) % 7) + 7) % 7;
}
function dayBoundsFor(nowMs){
  const idx = istDayIndex(nowMs);
  return { idx: idx, start: istDayStart(idx), end: istDayStart(idx + 1) };
}
// How many working days a lead has had to be called since its follow-up fell due, not
// counting today. Zero means it has not yet had a chance and is not overdue.
function workDaysMissed(fuIdx, todayIdx, work){
  let n = 0;
  for (let i = fuIdx; i < todayIdx; i++) if (work[istWeekday(i)]) n++;
  return n;
}

const STAGE_DNP = "dnp_did_not_pick";
const STAGE_DNP_OTHER = "dnp_other";
const STAGE_FRESH = "__fresh";
const STAGE_IFC = "IFC";
// A refill on a lead that already bought, or one that was disqualified, is noise.
const REFILL_EXCLUDED = ["deal_won", "disqualified"];

/* Has this lead filled the form again since anyone last spoke to it. That is a lead
   asking a second time into silence, which is why it outranks the stage it is sitting in.
   A form with no call at all also counts. */
function isRefill(r){
  if (!r.formLast) return false;
  if (REFILL_EXCLUDED.indexOf(r.stage) >= 0) return false;
  if (!r.last) return true;
  return r.formLast > r.last;
}

function timingOf(r, day, work){
  if (!r.fu) return r.stage === STAGE_FRESH ? "newlead" : "nofu";
  const fuIdx = istDayIndex(r.fu);
  if (fuIdx > day.idx) return "sched";
  if (fuIdx === day.idx) return "due";
  // The day itself must have crossed, and at least one working day must have passed.
  // A 2pm follow-up on the 6th is due all of the 6th and overdue on the 7th, and a
  // Sunday follow-up is simply due on Monday.
  return workDaysMissed(fuIdx, day.idx, work) > 0 ? "over" : "due";
}

const REASONS = ["form", "score", "intl", "fresh", "refill", "ifc", "needs", "over", "nofu"];

function reasonsOf(r, timing, opts){
  const scoreMin = (opts && opts.scoreMin) || 6;
  return {
    form: !!(r.forms && r.forms.length),
    score: (r.score || 0) >= scoreMin,
    intl: !!r.intl,
    fresh: r.stage === STAGE_FRESH,
    refill: isRefill(r),
    ifc: r.stage === STAGE_IFC && (timing === "due" || timing === "over"),
    // Nobody is working this lead: it has no owner, or the owner is deactivated. v1 shows
    // these and so must v2, or a whole bucket of work quietly stops existing.
    needs: !!r.needsOwner,
    over: timing === "over",
    nofu: timing === "nofu"
  };
}

const SEC_ACTION = "n";     // needs action today
const SEC_AHEAD = "a";      // has a future follow-up
const SEC_PARKED = "d";     // DNP with no priority signal, held apart on purpose

function sectionOf(r, timing, why){
  const priority = why.form || why.score || why.intl || why.fresh || why.refill;
  // A DNP lead with no priority signal is never presented as today's work and never
  // inflates overdue or no-FU. It gets its own section so the calls made on it are
  // still visible.
  if ((r.stage === STAGE_DNP || r.stage === STAGE_DNP_OTHER) && !priority) return SEC_PARKED;
  if (timing === "sched") return SEC_AHEAD;
  if (timing === "due" || timing === "over" || timing === "nofu" || timing === "newlead") {
    if (priority || why.ifc || timing === "due" || timing === "over" || timing === "nofu" || timing === "newlead") {
      return SEC_ACTION;
    }
  }
  return SEC_AHEAD;
}

function classify(r, day, opts){
  const work = (opts && opts.work) || workDaySet();
  const timing = timingOf(r, day, work);
  const why = reasonsOf(r, timing, opts);
  return {
    id: r.id,
    stage: r.stage,
    sec: sectionOf(r, timing, why),
    t: timing,
    why: why,
    owner: r.owner || "",
    creator: r.creator || "",
    source: r.source || "",
    // Parking buckets and unassigned leads are shown but never counted, exactly as v1
    // treats them. Dropping them from the pool made a real pile of work invisible.
    counted: r.counted !== false,
    fuIdx: r.fu ? istDayIndex(r.fu) : null,
    lateBy: r.fu ? workDaysMissed(istDayIndex(r.fu), day.idx, work) : 0
  };
}

// ---- packing, so a day's base is a few hundred kB rather than a few MB -------------
function pack(c){
  let mask = 0;
  REASONS.forEach(function(k, i){ if (c.why[k]) mask |= (1 << i); });
  return [c.stage, c.sec, c.t, mask, c.owner, c.creator, c.source || "", c.counted === false ? "0" : "1"].join("|");
}
function unpack(v){
  const a = String(v).split("|");
  const mask = parseInt(a[3], 10) || 0;
  const why = {};
  REASONS.forEach(function(k, i){ why[k] = !!(mask & (1 << i)); });
  // a[6] is absent on a list locked by an older build, which is harmless: it reads as
  // no source rather than throwing.
  return { stage: a[0], sec: a[1], t: a[2], why: why, owner: a[4] || "", creator: a[5] || "",
    source: a[6] || "", counted: a[7] !== "0" };
}

// ---- aggregation -------------------------------------------------------------------
const TIMING = ["due", "over", "nofu", "newlead", "sched"];
const COLUMNS = ["form", "score", "intl", "fresh", "refill", "ifc", "needs", "any", "all"];

function hit(c, col){
  if (col === "all") return true;
  if (col === "any") {
    // needsOwner is a reason to act, but on its own it is a routing job rather than a
    // call, so it does not make a lead part of the priority queue by itself.
    return !!(c.why.form || c.why.score || c.why.intl || c.why.fresh || c.why.refill || c.why.ifc);
  }
  return !!c.why[col];
}
function cell(){
  const o = {};
  TIMING.forEach(function(k){ o[k] = 0; o[k + "W"] = 0; });
  COLUMNS.forEach(function(k){ o[k] = 0; o[k + "W"] = 0; });
  return o;
}
function addTo(o, c, worked){
  o[c.t]++; if (worked) o[c.t + "W"]++;
  COLUMNS.forEach(function(k){
    if (!hit(c, k)) return;
    o[k]++; if (worked) o[k + "W"]++;
  });
}

/* One pass over the frozen base. `live` is the current pool by id, used only to ask
   whether the lead has been called today and where it has moved to. The base itself is
   never rewritten, which is what keeps "100 due, 60 worked" honest through the day. */
function aggregate(base, live, day, stageOrder){
  const sections = { n: {}, a: {}, d: {} };
  const totals = { n: cell(), a: cell(), d: cell() };
  const excluded = { n: cell(), a: cell(), d: cell() };
  const move = { called: 0, stage: 0, fu: 0, owner: 0, gone: 0, still: 0 };
  const byAgent = {};
  stageOrder.forEach(function(s){
    sections.n[s] = cell(); sections.a[s] = cell(); sections.d[s] = cell();
  });

  Object.keys(base).forEach(function(id){
    const c = typeof base[id] === "string" ? unpack(base[id]) : base[id];
    const cur = live[id] || null;
    const worked = !!(cur && cur.last >= day.start && cur.last < day.end);
    if (!sections.n[c.stage]) {
      sections.n[c.stage] = cell(); sections.a[c.stage] = cell(); sections.d[c.stage] = cell();
    }
    // Shown but not counted: they appear per agent so the pile is visible, and they are
    // kept out of every headline total so one parking bucket cannot swamp the floor.
    if (c.counted) {
      addTo(sections[c.sec][c.stage], c, worked);
      addTo(totals[c.sec], c, worked);
    } else {
      addTo(excluded[c.sec], c, worked);
    }

    // Accountability follows the morning owner. If a lead is handed over at 4pm the
    // base does not move, so nobody's percentage improves by reshuffling.
    const aid = c.owner || "none";
    if (!byAgent[aid]) byAgent[aid] = { n: cell(), a: cell(), d: cell(), counted: c.counted,
      offBase: 0, offBaseCalls: 0 };
    byAgent[aid].counted = c.counted;
    addTo(byAgent[aid][c.sec], c, worked);

    if (worked) move.called++;
    if (cur && cur.stage !== c.stage) move.stage++;
    if (cur && cur.owner !== c.owner) move.owner++;
    if (!cur) move.gone++;
    if (cur && !worked && cur.stage === c.stage && cur.owner === c.owner) move.still++;
  });

  return { sections: sections, totals: totals, excluded: excluded, movement: move, byAgent: byAgent };
}

/* Work done today on leads that were not in this morning's list at all: created today,
   or moved into the pool. Without this, coverage and effort never reconcile and the
   HubSpot total always looks bigger than the dashboard. */
function offBase(base, liveRows, day){
  const out = [];
  liveRows.forEach(function(r){
    if (base[r.id]) return;
    if (!(r.last >= day.start && r.last < day.end)) return;
    out.push(r);
  });
  return out;
}

module.exports = {
  DEFAULT_WORK_DAYS, workDaySet, istDayIndex, istDayStart, istWeekday, dayBoundsFor,
  workDaysMissed, isRefill, timingOf, reasonsOf, sectionOf, classify, pack, unpack,
  hit, cell, addTo, aggregate, offBase,
  REASONS, TIMING, COLUMNS, SEC_ACTION, SEC_AHEAD, SEC_PARKED, REFILL_EXCLUDED
};
