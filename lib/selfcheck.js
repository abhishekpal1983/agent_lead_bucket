"use strict";
/* What is broken right now, said out loud.

   Every failure this codebase has shipped had the same shape: it was quiet. A watermark
   that stopped matching looked like a quiet floor. A sweep running four copies of itself
   looked like normal load. A lock that froze a stale build looked like thirty agents
   editing records. None of them announced anything; somebody noticed a number that felt
   wrong, days later, and only then went looking.

   So the checks live here, pure, and the page shows them in red at the top rather than
   burying them in a health endpoint nobody opens. A check that nobody sees is a comment.

   Severity means something specific:
     fail  the numbers on screen are wrong or missing right now
     warn  they are right but something is degrading and will not stay right
     ok    checked and fine, worth showing so silence is not mistaken for health */
function chk(level, name, detail, hint){
  return { level: level, name: name, detail: detail || "", hint: hint || "" };
}

function run(o){
  const out = [];
  o = o || {};

  /* The lock is the whole contract of this report: closed at 23:59 and kept as it stood.
     If what was frozen does not match what the day actually held, every figure published
     from it is wrong and the change log will blame the floor for the difference. */
  if (o.lock && o.lock.verified === false) {
    out.push(chk("fail", "A locked day does not match what the day actually held",
      o.lock.day + ": " + o.lock.movedFigures + " figures differ from a fresh read" +
      (o.lock.worstMs ? ", the largest by " + Math.round(o.lock.worstMs / 60000) + " minutes" : ""),
      "Re-lock that day. The published figures are understated until you do."));
  } else if (o.lock && o.lock.verified === true) {
    out.push(chk("ok", "The last lock matches a fresh read of that day", o.lock.day));
  }

  if (o.lock && o.lock.late) {
    out.push(chk("warn", "A day was closed late",
      o.lock.day + " closed " + Math.round((o.lock.lateMin || 0) / 60) + " hours after it ended",
      "Calls logged in between were still counted, but the lock is not doing its job on time."));
  }

  /* A lock nobody can trust is worse than no lock. */
  if (o.store && o.store.persistent === false) {
    out.push(chk("fail", "Locks are not being saved",
      "No writable volume, so every lock vanishes on the next deploy",
      "Attach a Railway volume at the data directory."));
  } else if (o.store && o.store.loadedFromDisk === false && o.store.lockedDays > 0) {
    out.push(chk("warn", "The store started empty on this boot",
      "Locked days exist now but none were read from disk",
      "If a day was locked before the last deploy, it did not survive."));
  }

  /* A sync that dies stays dead and its numbers quietly stop moving. */
  (o.syncs || []).forEach(function(s){
    if (s.error) {
      out.push(chk("fail", "The " + s.name + " sync is failing", String(s.error).slice(0, 160),
        "Its numbers are frozen at whatever they were when it last worked."));
    } else if (s.behindMin != null && s.staleAfterMin && s.behindMin > s.staleAfterMin) {
      out.push(chk("warn", "The " + s.name + " sync is behind",
        s.behindMin + " minutes since it last completed, expected every " +
          s.everyMinutes + ""));
    }
  });

  /* Retries are invisible until they are most of the traffic. */
  if (o.hubspot && o.hubspot.total > 200) {
    const pct = Math.round(100 * (o.hubspot.retries || 0) / o.hubspot.total);
    if (pct >= 25) {
      out.push(chk("warn", "One in " + Math.max(2, Math.round(100 / pct)) +
        " HubSpot requests is a retry",
        pct + "% of " + o.hubspot.total + " requests since boot",
        "Something is being rate limited and silently resent."));
    }
  }

  /* An empty day is either a quiet day or a broken read, and they look identical. */
  if (o.day && o.day.isPast && o.day.agents === 0) {
    out.push(chk("fail", "A past day has no agents on it at all", o.day.date,
      "A finished working day with nobody on it is a failed read, not a quiet day."));
  }

  return out;
}

function worst(checks){
  const levels = (checks || []).map(function(c){ return c.level; });
  if (levels.indexOf("fail") >= 0) return "fail";
  if (levels.indexOf("warn") >= 0) return "warn";
  return "ok";
}

module.exports = { run, worst, chk };
