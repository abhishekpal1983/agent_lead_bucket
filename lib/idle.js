"use strict";
/* Shift arithmetic and call de-duplication for the agent idle tracker.

   Kept out of server.js and free of any I/O so the awkward parts, which are all
   arithmetic, can be tested without a HubSpot token or a running server.

   Three things here are not obvious and cost real accuracy if got wrong.

   One: a call arrives twice. FreJun logs the dial as an INTEGRATION record, then the agent
   writes the same call up in the CRM and HubSpot logs it again. On a sampled agent that
   was 101 records for 55 conversations. Counting records inflates every number by nearly
   half.

   Two: idle time has to be measured in working minutes. An agent whose last call was at
   14:20 has been idle for 22 minutes at 15:12, not 52, because lunch sits in between.
   Wall-clock subtraction would make every agent look idle after every break.

   Three: a connected call is not a conversation. Voicemail answers, so it has a duration.
   The floor marked exactly one call "Left voicemail" in two days, so the disposition
   cannot separate it. Only duration can, and only as a proxy. */

const MIN = 60 * 1000;
// IST has no daylight saving, so a fixed offset is exact rather than merely convenient.
const IST_OFFSET = 5.5 * 60 * MIN;

const DEFAULTS = {
  shiftStart: "12:30",
  shiftEnd: "22:00",
  breaks: "14:30-15:00,17:00-17:30",
  // 1 is Monday. Sunday is 0 and is deliberately absent.
  workDays: [1, 2, 3, 4, 5, 6],
  dedupeMs: 2 * MIN,
  conversationMs: 60 * 1000,
  quietMs: 15 * MIN,
  idleMs: 40 * MIN,
  // A record landing within this long of now means they are probably still on the call:
  // FreJun writes it about a minute after the call starts.
  onCallMs: 3 * MIN,
  minGapMs: 15 * MIN
};

function toMin(s){
  const p = String(s || "").split(":");
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}
function parseBreaks(s){
  return String(s || "").split(",").map(function(x){ return x.trim(); }).filter(Boolean)
    .map(function(x){
      const p = x.split("-");
      return { start: toMin(p[0]), end: toMin(p[1]) };
    }).filter(function(b){ return b.end > b.start; })
    .sort(function(a, b){ return a.start - b.start; });
}
// Midnight IST of a YYYY-MM-DD key, as a UTC epoch.
function istMidnight(dateKey){
  const p = String(dateKey || "").split("-");
  return Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1) - IST_OFFSET;
}
function istDateKey(ms){
  return new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
}
// 0 is Sunday, matching getUTCDay, read in IST.
function istWeekday(dateKey){
  return new Date(istMidnight(dateKey) + IST_OFFSET).getUTCDay();
}

/* The shift for one IST date, as absolute instants. */
function shiftFor(dateKey, cfg){
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const base = istMidnight(dateKey);
  return {
    date: dateKey,
    start: base + toMin(c.shiftStart) * MIN,
    end: base + toMin(c.shiftEnd) * MIN,
    isWorkDay: c.workDays.indexOf(istWeekday(dateKey)) >= 0,
    breaks: parseBreaks(c.breaks).map(function(b){
      return { start: base + b.start * MIN, end: base + b.end * MIN };
    })
  };
}

function overlap(a1, a2, b1, b2){
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/* Working milliseconds between two instants: clipped to the shift, breaks removed.

   This is the function that makes an idle clock fair. Everything else about idle time is
   presentation. */
function workedBetween(from, to, shift){
  if (!shift || !shift.isWorkDay) return 0;
  const a = Math.max(from, shift.start);
  const b = Math.min(to, shift.end);
  if (b <= a) return 0;
  let ms = b - a;
  (shift.breaks || []).forEach(function(br){ ms -= overlap(a, b, br.start, br.end); });
  return Math.max(0, ms);
}

function inBreak(ms, shift){
  return (shift.breaks || []).some(function(b){ return ms >= b.start && ms < b.end; });
}
function inShift(ms, shift){
  return !!shift.isWorkDay && ms >= shift.start && ms < shift.end;
}

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

/* Stretches of the shift with no call in them, measured in working minutes.

   The stretch before the first call counts: an agent who starts at 15:00 was idle from
   12:30, and leaving that out would reward turning up late. */
function gapsFor(acts, shift, now, cfg){
  const c = Object.assign({}, DEFAULTS, cfg || {});
  if (!shift.isWorkDay) return [];
  const upto = Math.min(now, shift.end);
  if (upto <= shift.start) return [];
  const rows = (acts || []).slice().sort(function(a, b){ return a.at - b.at; });
  const gaps = [];
  let cursor = shift.start;
  rows.forEach(function(a){
    if (a.at > cursor) {
      const to = Math.min(a.at, upto);
      const ms = workedBetween(cursor, to, shift);
      if (ms >= c.minGapMs) gaps.push({ from: cursor, to: to, ms: ms });
    }
    if ((a.endAt || a.at) > cursor) cursor = a.endAt || a.at;
  });
  if (cursor < upto) {
    const ms = workedBetween(cursor, upto, shift);
    if (ms >= c.minGapMs) gaps.push({ from: cursor, to: upto, ms: ms, open: true });
  }
  return gaps;
}

/* What an agent is doing right now, in one word plus the number behind it. */
function stateFor(acts, shift, now, cfg){
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const rows = (acts || []).slice().sort(function(a, b){ return a.at - b.at; });
  const last = rows[rows.length - 1] || null;
  if (!shift.isWorkDay || now < shift.start || now >= shift.end) {
    return { state: "offshift", idleMs: 0, last: last };
  }
  if (inBreak(now, shift)) return { state: "break", idleMs: 0, last: last };
  if (!last) return { state: "none", idleMs: workedBetween(shift.start, now, shift), last: null };
  // Still talking: the record landed moments ago and carries no duration yet.
  if (now - last.at <= c.onCallMs && !last.durMs) return { state: "oncall", idleMs: 0, last: last };
  const idleMs = workedBetween(last.endAt || last.at, now, shift);
  const state = idleMs >= c.idleMs ? "idle" : (idleMs >= c.quietMs ? "quiet" : "between");
  return { state: state, idleMs: idleMs, last: last };
}

/* Everything a day summary needs about one agent, from their deduped calls. */
function summarise(acts, shift, now, cfg){
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const rows = (acts || []).slice().sort(function(a, b){ return a.at - b.at; });
  const gaps = gapsFor(rows, shift, now, c);
  return {
    dialled: rows.length,
    answered: rows.filter(function(a){ return a.answered; }).length,
    conversations: rows.filter(function(a){ return a.conversation; }).length,
    talkMs: rows.reduce(function(n, a){ return n + (a.durMs || 0); }, 0),
    records: rows.reduce(function(n, a){ return n + a.ids.length; }, 0),
    first: rows.length ? rows[0].at : 0,
    last: rows.length ? rows[rows.length - 1].at : 0,
    lastEnd: rows.length ? rows[rows.length - 1].endAt : 0,
    lastDurMs: rows.length ? rows[rows.length - 1].durMs : 0,
    gaps: gaps,
    gapMs: gaps.reduce(function(n, g){ return n + g.ms; }, 0),
    shiftMs: workedBetween(shift.start, Math.min(now, shift.end), shift)
  };
}

module.exports = {
  DEFAULTS, MIN, IST_OFFSET,
  toMin, parseBreaks, istMidnight, istDateKey, istWeekday,
  shiftFor, workedBetween, inBreak, inShift,
  dedupe, gapsFor, stateFor, summarise
};
