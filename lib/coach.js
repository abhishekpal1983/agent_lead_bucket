"use strict";
/* Choosing the day's audits, kept away from HubSpot and Express so it can be tested.

   One rule: an audit needs a call. An agent who took no reviewable call is not a
   coaching slot, they are an agent with nothing to listen to. Putting them on the
   list manufactures a miss that no manager can fix, and a cadence that reports
   failures nobody caused stops being read.

   So the list walks the whole rotation, takes the first `perDay` agents who have a
   call, and names the rest without counting them. A thin day owes three, not five. */

/* order : the full roster in today's rotation order.
   pick(id, taken) : the chosen call for that agent, or null.
   perDay : how many audits a full day asks for.

   Returns the chosen rows and the agents passed over. The walk continues past an
   agent with nothing to review, so a manager handed two blanks still gets five
   agents to coach if five have calls. */
function chooseDay(order, pick, perDay){
  const rows = [], skipped = [], taken = [];
  (order || []).forEach(function(id){
    if (rows.length >= perDay) return;
    const call = pick(String(id), taken);
    if (!call) { skipped.push(String(id)); return; }
    taken.push(call.id);
    rows.push({ agentId: String(id), callId: call.id, call: call });
  });
  return { rows: rows, skipped: skipped, taken: taken };
}

/* The same rule with a cheap test, for the preview before the day is locked. */
function eligible(order, hasCall, perDay){
  return (order || []).filter(function(id){ return hasCall(String(id)); }).slice(0, perDay);
}

/* A lock written under the old rule padded the day to five with blank rows, and the
   walk stopped at five INCLUDING blanks, so a reviewable agent further down could be
   left out. A lock is legacy exactly when it still holds a row with no call. */
function isLegacyLock(lock){
  return !!(lock && (lock.rows || []).some(function(r){ return !r.callId; }));
}

module.exports = { chooseDay: chooseDay, eligible: eligible, isLegacyLock: isLegacyLock };
