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

/* Which day is owed a lock, if any.

   `locked` is the set of days already locked. Returns null when nothing is due, otherwise
   the day and whether the window was missed. Yesterday is checked before today because a
   restart spanning midnight owes both, and the older one matters more: it is the one about
   to be edited. */
function pendingLock(today, hm, locked, opts){
  const o = opts || {};
  const at = o.lockHm || "23:59";
  const has = function(d){ return !!(locked || {})[d]; };
  const y = prevDay(today);
  if (!has(y) && (o.since ? y >= o.since : true)) return { day: y, late: true };
  if (hm >= at && !has(today)) return { day: today, late: false };
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
