"use strict";
/* Bakes the page, the model and a set of made-up leads into one HTML file that runs with
   no server and no HubSpot. Open it in a browser and every filter, cell and drill down
   works, just against invented data. */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const page = fs.readFileSync(path.join(ROOT, "public/callnow2.html"), "utf8");
const model = fs.readFileSync(path.join(ROOT, "lib/cn2.js"), "utf8")
  .replace(/^"use strict";\s*/, "")
  .replace(/module\.exports\s*=\s*\{[\s\S]*?\};\s*$/m, "");
const fixture = require(path.join(ROOT, "fixtures/make.js"));

const LABELS = {
  counselled: "Counselled", program_pitched: "Program pitched", discovery: "Discovery",
  pricing_pitched: "Pricing pitched", "Follow up": "Follow up", payment_prospect: "Payment prospect",
  FU_DNP: "FU - DNP", FU_RCB: "FU - RCB", rcb_requested_callback: "RCB - Requested callback",
  dnp_did_not_pick: "DNP", __fresh: "Fresh leads", IFC: "Interested in future",
  ghosted: "Ghosted", ni_not_interested: "NI - Not interested"
};
const STAGES = ["counselled","program_pitched","discovery","pricing_pitched","Follow up","payment_prospect",
  "FU_DNP","FU_RCB","rcb_requested_callback","dnp_did_not_pick","__fresh","IFC","ghosted","ni_not_interested"];

const shim = `
<script>
/* ---- preview harness: no server, no HubSpot, invented leads ---- */
${model}
var PREVIEW = {
  rows: ${JSON.stringify(fixture.rows)},
  now: ${fixture.now},
  teams: ${JSON.stringify(fixture.teams)},
  agents: ${JSON.stringify(fixture.agents)},
  labels: ${JSON.stringify(LABELS)},
  stages: ${JSON.stringify(STAGES)}
};
(function(){
  var EXTRA = ["IFC","ghosted","ni_not_interested"];
  var WORK = workDaySet();
  var day = dayBoundsFor(PREVIEW.now);
  function qualifies(r){
    if (PREVIEW.stages.indexOf(r.stage) < 0) return false;
    if (EXTRA.indexOf(r.stage) < 0) return true;
    if (isRefill(r)) return true;
    if (r.stage === "IFC") { var t = timingOf(r, day, WORK); return t === "due" || t === "over"; }
    return false;
  }
  var rows = PREVIEW.rows.filter(qualifies);
  var base = {}, live = {};
  rows.forEach(function(r){
    live[r.id] = r;
    if (r.arrivedToday) return;               // arrived after the list was locked
    base[r.id] = pack(classify(r, day, { work: WORK, scoreMin: 6 }));
  });
  var teamOf = {}, teamName = {};
  PREVIEW.teams.forEach(function(t){
    teamName[t.id] = t.name;
    (t.agentIds || []).forEach(function(id){ teamOf[String(id)] = t.id; });
  });
  function nameOf(id){
    var a = PREVIEW.agents.filter(function(x){ return x.id === String(id); })[0];
    return a ? a.name : (id ? "Owner " + id : "(unassigned)");
  }
  function scoped(q){
    var out = {};
    Object.keys(base).forEach(function(id){
      var c = unpack(base[id]);
      if (q.agent && String(c.owner) !== q.agent) return;
      if (q.team) {
        var tt = PREVIEW.teams.filter(function(t){ return t.id === q.team; })[0];
        if (!tt || (tt.agentIds || []).map(String).indexOf(String(c.owner)) < 0) return;
      }
      if (q.creator && c.creator !== q.creator) return;
      out[id] = base[id];
    });
    return out;
  }
  function parse(url){
    var q = {}, s = String(url).split("?")[1] || "";
    s.split("&").forEach(function(kv){
      if (!kv) return;
      var p = kv.split("=");
      q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || "");
    });
    return q;
  }
  function matrix(q){
    var b = scoped(q);
    var order = PREVIEW.stages.filter(function(s){
      return Object.keys(b).some(function(id){ return unpack(b[id]).stage === s; });
    });
    var agg = aggregate(b, live, day, order);
    var off = offBase(b, rows, day);
    var ag = {}, cr = {};
    Object.keys(b).forEach(function(id){
      var c = unpack(b[id]);
      ag[c.owner || "none"] = (ag[c.owner || "none"] || 0) + 1;
      if (c.creator) cr[c.creator] = (cr[c.creator] || 0) + 1;
    });
    return {
      stages: order.map(function(s){
        return { stage: s, label: PREVIEW.labels[s] || s,
          n: agg.sections.n[s], a: agg.sections.a[s], d: agg.sections.d[s] };
      }),
      totals: agg.totals, movement: agg.movement, offBase: { leads: off.length },
      timing: TIMING, columns: COLUMNS, frozen: true,
      frozenAt: new Date(day.start + 300000).toISOString(), freezeHour: "00:05",
      workDays: "1,2,3,4,5,6", baseSize: Object.keys(b).length, fixtures: true,
      teamOptions: PREVIEW.teams.map(function(t){ return { id: t.id, name: t.name }; }),
      agentOptions: Object.keys(ag).map(function(id){
        return { id: id === "none" ? "" : id, name: nameOf(id === "none" ? "" : id), n: ag[id] };
      }).sort(function(x, y){ return y.n - x.n; }),
      creatorOptions: Object.keys(cr).map(function(u){ return { u: u, n: cr[u] }; })
        .sort(function(x, y){ return y.n - x.n; }),
      loadedAt: "fixtures"
    };
  }
  function agents(q){
    var b = scoped(q);
    var order = PREVIEW.stages;
    var agg = aggregate(b, live, day, order);
    var off = {};
    offBase(b, rows, day).forEach(function(r){ var k = String(r.owner || "none"); off[k] = (off[k] || 0) + 1; });
    var arows = Object.keys(agg.byAgent).map(function(id){
      var tid = teamOf[id];
      return { id: id, name: nameOf(id === "none" ? "" : id), team: tid ? teamName[tid] : "",
        teamId: tid || "", n: agg.byAgent[id].n, a: agg.byAgent[id].a, d: agg.byAgent[id].d,
        offBase: off[id] || 0 };
    }).sort(function(x, y){ return y.n.all - x.n.all; });
    var tm = {};
    arows.forEach(function(r){
      var k = r.teamId || "";
      if (!tm[k]) tm[k] = { id: k, name: r.team || "Unmapped", n: cell(), a: cell(), d: cell(), offBase: 0, agents: 0 };
      ["n","a","d"].forEach(function(sec){
        Object.keys(tm[k][sec]).forEach(function(key){ tm[k][sec][key] += r[sec][key]; });
      });
      tm[k].offBase += r.offBase; tm[k].agents++;
    });
    return { agents: arows, teams: Object.keys(tm).map(function(k){ return tm[k]; })
      .sort(function(x, y){ return y.n.all - x.n.all; }), frozen: true };
  }
  function leads(q){
    var b = scoped(q), out = [];
    Object.keys(b).forEach(function(id){
      var c = unpack(b[id]);
      if (q.stage && c.stage !== q.stage) return;
      if (q.sec && c.sec !== q.sec) return;
      if (q.t && c.t !== q.t) return;
      if (!hit(c, q.col || "all")) return;
      var cur = live[id] || null;
      var w = !!(cur && cur.last >= day.start && cur.last < day.end);
      if (q.worked === "1" && !w) return;
      if (q.worked === "0" && w) return;
      var nowC = cur ? classify(cur, day, { work: WORK, scoreMin: 6 }) : null;
      if (q.moved === "stage" && !(nowC && nowC.stage !== c.stage)) return;
      if (q.moved === "fu" && !(nowC && nowC.t !== c.t)) return;
      if (q.moved === "owner" && !(nowC && nowC.owner !== c.owner)) return;
      if (q.moved === "gone" && cur) return;
      if (q.moved === "still" && (w || !cur || nowC.stage !== c.stage || nowC.t !== c.t)) return;
      var r = cur || {};
      out.push({ id: id, worked: w, gone: !cur, name: r.name || "(no longer in the list)",
        openStage: c.stage, openTiming: c.t, section: c.sec, why: c.why,
        nowStage: nowC ? nowC.stage : "", nowTiming: nowC ? nowC.t : "",
        movedStage: !!(nowC && nowC.stage !== c.stage), movedFu: !!(nowC && nowC.t !== c.t),
        movedOwner: !!(nowC && nowC.owner !== c.owner),
        ownerName: nameOf(c.owner), creator: c.creator, phone: r.phone || "",
        last: r.last || 0, fu: r.fu || 0, formLast: r.formLast || 0,
        calls: r.calls || 0, own: r.own || 0, score: r.score || 0, intl: !!r.intl,
        outcome: "", aiSummary: "", needsOwner: !!r.needsOwner });
    });
    var total = out.length;
    out.sort(function(x, y){
      if (x.worked !== y.worked) return x.worked ? 1 : -1;
      return (x.fu || Infinity) - (y.fu || Infinity);
    });
    return { total: total, shown: Math.min(out.length, 500), rows: out.slice(0, 500), frozen: true,
      portal: { uiDomain: "app.hubspot.com", portalId: "0" } };
  }
  window.fetch = function(url, opts){
    var q = parse(url), body;
    if (String(url).indexOf("/api/callnow2/agents") === 0) body = agents(q);
    else if (String(url).indexOf("/api/callnow2/leads") === 0) body = leads(q);
    else if (String(url).indexOf("/api/callnow2/refreeze") === 0) body = { ok: true };
    else body = matrix(q);
    return Promise.resolve({ status: 200, ok: true, text: function(){ return Promise.resolve(JSON.stringify(body)); } });
  };
})();
</script>`;

const out = page.replace("<script>\nvar J=null", shim + "\n<script>\nvar J=null");
const dest = process.argv[2] || path.join(ROOT, "callnow2-preview.html");
fs.writeFileSync(dest, out);
console.log("wrote " + dest + " (" + Math.round(out.length / 1024) + " kB)");
