"use strict";
/* Locking a day's talktime, and noticing when somebody changes it afterwards.

   Two ideas, both kept away from I/O so the awkward parts can be tested without a volume,
   a token or a clock.

   The first is that a lock has to survive a restart. Firing at 23:59 works until the one
   night the server is redeploying at 23:58, and then the day is simply never locked and
   nobody finds out for a week. So the decision is "which day is owed a lock", not "is it
   23:59 now", and a lock that happens late says so rather than quietly presenting itself
   as an on-time one.

   The second is that HubSpot has no record lock and this cannot invent one. An agent can
   edit yesterday's call tomorrow and nothing here can stop them. What it can do is refuse
   to let the edit change the number, and say who changed what. Detection is the honest
   version of prevention, and naming a change is a better deterrent than a block that does
   not exist. */

function toMin(hm){
  const p = String(hm || "0:0").split(":");
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}
function daysBetween(a, b){
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

/* Which day is owed a lock, if any, and how far past its moment we are.

   The first version asked "is it 23:59 now", which is a one minute target polled every five
   minutes, so it missed roughly four nights in five. Every miss then fell through to the
   catch-up branch a few minutes after midnight and got stamped "late, the window was
   missed", which was alarming and wrong: the day was closed four minutes after it ended and
   nothing was lost. It made the one signal that should mean something mean nothing.

   So this asks which day is OWED a lock, and reports how many minutes past its 23:59 the
   clock now is. Late means substantially late, past `graceMin`, which is a genuine incident
   worth reading. Four minutes after midnight is not.

   Yesterday is checked before today because a restart spanning midnight owes both, and the
   older one matters more: it is the one about to be edited. */
function pendingLock(today, hm, locked, opts){
  const o = opts || {};
  const at = o.lockHm || "23:59";
  const grace = o.graceMin == null ? 30 : o.graceMin;
  const has = function(d){ return !!(locked || {})[d]; };
  const owed = function(day){
    // Minutes from that day's lock moment to now.
    const mins = daysBetween(day, today) * 1440 + toMin(hm) - toMin(at);
    return { day: day, lateMin: mins, late: mins > grace };
  };
  const y = prevDay(today);
  if (!has(y) && (o.since ? y >= o.since : true)) return owed(y);
  if (toMin(hm) >= toMin(at) && !has(today)) return owed(today);
  return null;
}

function prevDay(day){
  const t = Date.parse(day + "T00:00:00Z");
  return new Date(t - 86400000).toISOString().slice(0, 10);
}

/* A day reduced to the numbers worth guarding, keyed so two captures can be compared.

   Only the agent-entered figures are kept per call. FreJun durations and meeting
   recordings are written by machines and cannot be argued with, so logging every one of
   fourteen hundred calls landing would bury the two entries that matter. */
function snapshotOf(built, opts){
  const o = opts || {};
  const rows = {};
  (built.rows || []).forEach(function(r){
    rows[String(r.id)] = {
      name: r.name, callMs: r.callMs || 0, meetMs: r.meetMs || 0,
      declaredMs: r.declaredTotalMs || 0, talkMs: r.talkMs || 0,
      calls: r.calls || 0, waCalls: r.waCalls || 0, waMissing: r.waMissing || 0,
      declaredCalls: r.declaredCalls || 0, needLength: r.needLength || 0,
      meetings: r.meetings || 0
    };
  });
  const declared = {};
  (o.calls || []).forEach(function(c){
    const ms = (c.declaredMs || 0) + (c.noteMs || 0);
    if (!ms && !c.isWa) return;                  // nothing an agent typed, nothing to guard
    declared[String(c.id)] = { owner: String(c.owner || ""), ms: ms,
      contact: String(c.contact || "") };
  });
  return { rows: rows, declared: declared };
}

/* What changed between two captures of the same day.

   Per call, because "this agent's total went up by half an hour" invites an argument and
   "call 396778580729 went from 20 minutes to 48" ends one. */
function diff(prev, next, opts){
  const o = opts || {};
  const out = [];
  const a = (prev && prev.declared) || {}, b = (next && next.declared) || {};
  const nameOf = function(owner){
    const r = ((next && next.rows) || {})[owner] || ((prev && prev.rows) || {})[owner] || {};
    return r.name || ("Owner " + owner);
  };
  Object.keys(b).forEach(function(id){
    const to = b[id];
    const from = a[id];
    if (!from) {
      /* A call that did not exist in the earlier capture. Before the lock this is just an
         agent logging their work. After it, it is a call added to a closed day. */
      if (to.ms > 0) out.push({ kind: "added", callId: id, owner: to.owner,
        name: nameOf(to.owner), from: 0, to: to.ms, contact: to.contact });
      return;
    }
    if (from.ms !== to.ms) out.push({ kind: "changed", callId: id, owner: to.owner,
      name: nameOf(to.owner), from: from.ms, to: to.ms, contact: to.contact });
  });
  Object.keys(a).forEach(function(id){
    if (b[id]) return;
    const from = a[id];
    if (from.ms > 0) out.push({ kind: "removed", callId: id, owner: from.owner,
      name: nameOf(from.owner), from: from.ms, to: 0, contact: from.contact });
  });
  /* Newest first is wrong for a trail, which is read in the order things happened. */
  out.sort(function(x, y){ return String(x.callId).localeCompare(String(y.callId)); });
  return out.map(function(e){
    return Object.assign({ at: o.at || new Date().toISOString(), day: o.day || "",
      phase: o.phase || "open" }, e);
  });
}

/* The per agent effect of a set of changes, for the row flag. */
function byOwner(entries){
  const out = {};
  (entries || []).forEach(function(e){
    const o = out[e.owner] || (out[e.owner] = { owner: e.owner, name: e.name, n: 0, deltaMs: 0 });
    o.n++;
    o.deltaMs += (e.to || 0) - (e.from || 0);
  });
  return out;
}

module.exports = { pendingLock, prevDay, snapshotOf, diff, byOwner };
