"use strict";
/* Revenue attribution, kept away from HubSpot and Express so it can be tested.

   One rule decides everything here: a payment follows the AGENT, not the creator.
   Whoever coaches the agent gets the revenue. The creator mapping decides which
   team a creator's TARGET sits against, and nothing else.

   That distinction matters because the two often disagree. An agent on Priya's
   team books a sale for a creator mapped to Rahul. The money is Priya's, because
   Priya runs that agent. Rahul's creator target is untouched, because Rahul did
   not do the work.

   Before this module the row was simply dropped: the aggregate is bucketed by the
   agent's team, so it could never reach Rahul, and the mapped-creator filter kept
   it off Priya. It landed on nobody and the floor total silently undershot the
   payment sheet. */

const KEYS = ["revenue", "enrolments", "queue", "due", "done", "missed", "overdue", "uncalled",
  "touched", "churned", "worked", "counsellings", "created", "cohortCounselled", "risk",
  "form", "score", "intl", "needs", "counsToday",
  "queueT", "formT", "scoreT", "intlT", "needsT", "overdueT"];

function zero(){
  const o = {};
  KEYS.forEach(function(k){ o[k] = 0; });
  return o;
}
function addInto(a, b){
  Object.keys(b).forEach(function(k){ if (typeof b[k] === "number") a[k] = (a[k] || 0) + b[k]; });
  return a;
}

const OFFMAP_LABEL = "Creators mapped to another team";

/* byCreator   : { creatorUsername: { agentId: counters } } for ONE team, already
                 bucketed by the agent's team upstream.
   mapped      : the creator usernames mapped to this team.
   targetOf(cu): this month's revenue target for a creator, or 0.
   ownerOf(id) : { name, email, active } for an agent.

   Returns creatorRows (mapped ones first, then one off-map row), the team totals,
   the set of agents who did something, and an offmap summary for the header. */
function teamRows(o){
  const byCreator = o.byCreator || {};
  const mapped = o.mapped || [];
  const targetOf = o.targetOf || function(){ return 0; };
  const ownerOf = o.ownerOf || function(){ return {}; };

  const isMapped = {};
  mapped.forEach(function(cu){ isMapped[cu] = 1; });
  const totals = zero();
  const agentTouched = {};

  const agentRow = function(aid, counters){
    const w = ownerOf(aid) || {};
    return Object.assign({ id: aid, name: w.name || ("Owner " + aid), email: w.email || "",
      active: w.active !== false }, counters);
  };
  const byRevenue = function(a, b){ return b.revenue - a.revenue || b.queue - a.queue; };

  const creatorRows = Object.keys(byCreator).filter(function(cu){ return !!isMapped[cu]; }).map(function(cu){
    const perAgent = byCreator[cu];
    const ctot = zero();
    const agents = Object.keys(perAgent).map(function(aid){
      if (perAgent[aid].touched > 0) agentTouched[aid] = 1;
      addInto(ctot, perAgent[aid]);
      return agentRow(aid, perAgent[aid]);
    }).sort(byRevenue);
    addInto(totals, ctot);
    return Object.assign({ u: cu, target: targetOf(cu), mapped: true, agents: agents }, ctot);
  }).sort(byRevenue);

  // A mapped creator with no activity still deserves a line, or a manager cannot
  // see that the creator they were given has produced nothing.
  mapped.forEach(function(cu){
    if (!byCreator[cu]) creatorRows.push(Object.assign({ u: cu, target: targetOf(cu), mapped: true, agents: [] }, zero()));
  });

  const offAgents = {}, offTot = zero(), offNames = [];
  Object.keys(byCreator).filter(function(cu){ return !isMapped[cu]; }).forEach(function(cu){
    const perAgent = byCreator[cu];
    let any = false;
    Object.keys(perAgent).forEach(function(aid){
      const src = perAgent[aid];
      if (src.touched > 0) agentTouched[aid] = 1;
      addInto(offTot, src);
      if (!offAgents[aid]) offAgents[aid] = agentRow(aid, zero());
      addInto(offAgents[aid], src);
      if (src.revenue || src.queue || src.enrolments) any = true;
    });
    if (any) offNames.push(cu);
  });
  offNames.sort();

  const offHas = !!(offTot.revenue || offTot.enrolments || offTot.queue || offTot.counsellings);
  if (offHas) {
    addInto(totals, offTot);
    // No target: the target lives with whoever the creator is mapped to, so the gap
    // column stays blank rather than inventing a shortfall against nothing.
    creatorRows.push(Object.assign({ u: OFFMAP_LABEL, target: 0, mapped: false, offmap: true,
      creators: offNames, agents: Object.values(offAgents).sort(byRevenue) }, offTot));
  }

  return {
    creatorRows: creatorRows,
    totals: totals,
    agentTouched: agentTouched,
    offmap: offHas ? { revenue: offTot.revenue, enrolments: offTot.enrolments,
      queue: offTot.queue, creators: offNames } : null
  };
}

module.exports = { KEYS: KEYS, zero: zero, addInto: addInto, teamRows: teamRows, OFFMAP_LABEL: OFFMAP_LABEL };
