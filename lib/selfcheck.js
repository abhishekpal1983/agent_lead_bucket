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
     ok    checked and fine, worth showing so silence is not mistaken for health

   Written for whoever is reading the report, which is HR and managers, not engineers. Every
   line has to answer "is the number in front of me wrong, and what do I do". "One in 3
   HubSpot requests is a retry" told the reader nothing they could act on and made them ask
   what it meant, which is the same as saying nothing. */
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
    out.push(chk("fail", "The numbers saved for " + o.lock.day + " do not match what that day really held",
      o.lock.movedFigures + " of them are wrong" +
      (o.lock.worstMs ? ", the worst by " + Math.round(o.lock.worstMs / 60000) + " minutes" : ""),
      "Open that date and press Re-lock this day. Until you do, the talktime shown for it is too low."));
  } else if (o.lock && o.lock.verified === true) {
    out.push(chk("ok", "The saved numbers for " + o.lock.day + " were checked and match HubSpot",
      "Checked by reading the whole day again after it closed"));
  }

  if (o.lock && o.lock.late) {
    out.push(chk("warn", o.lock.day + " was closed late",
      "It should close at midnight and closed " +
        Math.round((o.lock.lateMin || 0) / 60) + " hours afterwards",
      "The numbers are still right. Anything logged in between was counted."));
  }

  /* A lock nobody can trust is worse than no lock. */
  if (o.store && o.store.persistent === false) {
    out.push(chk("fail", "Nothing is being saved",
      "Each day's numbers are being kept in memory only",
      "They will all disappear the next time the app restarts. This needs fixing before anybody relies on the report."));
  } else if (o.store && o.store.loadedFromDisk === false && o.store.lockedDays > 0) {
    out.push(chk("warn", "Saved days were not found when the app last restarted",
      "It started with nothing and has saved " + o.store.lockedDays + " day(s) since",
      "Any day closed before that restart has been lost and will need closing again."));
  }

  /* A sync that dies stays dead and its numbers quietly stop moving. */
  (o.syncs || []).forEach(function(s){
    if (s.error) {
      out.push(chk("fail", "The " + s.name + " data has stopped updating",
        "HubSpot is returning an error: " + String(s.error).slice(0, 120),
        "Anything on this page that depends on it is stuck at the last value that worked."));
    } else if (s.behindMin != null && s.staleAfterMin && s.behindMin > s.staleAfterMin) {
      out.push(chk("warn", "The " + s.name + " data is running behind",
        "Last updated " + s.behindMin + " minutes ago, expected every " + s.everyMinutes,
        "Today's figures may be a little out of date. Days already closed are unaffected."));
    }
  });

  /* Retries are invisible until they are most of the traffic. */
  if (o.hubspot && o.hubspot.total > 200) {
    const pct = Math.round(100 * (o.hubspot.retries || 0) / o.hubspot.total);
    if (pct >= 25) {
      out.push(chk("warn", "HubSpot is asking us to slow down",
        pct + " out of every 100 requests are being refused and sent again",
        "Nothing on this page is wrong because of it. Pages may load slowly, and if it gets " +
        "worse some data could start arriving late."));
    }
  }

  /* An empty day is either a quiet day or a broken read, and they look identical. */
  if (o.day && o.day.isPast && o.day.agents === 0) {
    out.push(chk("fail", "No agents at all appear on " + o.day.date,
      "A finished working day with nobody on it",
      "This is a failed read rather than a quiet day. The figures for it cannot be trusted."));
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
