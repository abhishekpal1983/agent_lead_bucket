/* Agent Lead Bucket Health - HubSpot dashboard backend
 * Syncs staged, owned contacts from HubSpot into memory and serves
 * aggregated JSON to the frontend in /public.
 *
 * Required env vars:
 *   HUBSPOT_TOKEN  - HubSpot private app token (scopes: crm.objects.contacts.read, crm.objects.owners.read)
 * Optional:
 *   PORT           - default 3000
 *   SYNC_MINUTES   - cache refresh interval, default 30
 *   HS_PORTAL_ID   - portal id for record links, default 244132076
 *   HS_UI_DOMAIN   - default app-na2.hubspot.com
 */
const express = require("express");
const app = express();

const TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY;
const PORT = process.env.PORT || 3000;
const SYNC_MINUTES = parseInt(process.env.SYNC_MINUTES || "30", 10);
const PORTAL_ID = process.env.HS_PORTAL_ID || "244132076";
const UI_DOMAIN = process.env.HS_UI_DOMAIN || "app-na2.hubspot.com";
const HS = "https://api.hubapi.com";

const PROPS = [
  "hubspot_owner_id","contact_engagement_stage","topmate_username",
  "callscurrent_stage","call_in_current_stage_by_current_owner",
  "createdate","follow_up_date_and_time","last_call_date_and_time",
  "engagement_stage_last_changed_at","tm_student_or_professional",
  "not_interested_reason","counselling_done","previous_engagement_stage",
  "firstname","lastname"
];
const WORKABLE = ["rcb_requested_callback","discovery","program_pitched","pricing_pitched","counselled","Follow up","FU_DNP","FU_RCB","payment_prospect"];
const CHURN = ["dnp_did_not_pick","ghosted","ni_not_interested","disqualified"];
const POST_STAGES = ["discovery","program_pitched","pricing_pitched","counselled","payment_prospect","IFC","FU_DNP","FU_RCB","Follow up"];

let CACHE = { contacts: [], owners: {}, loadedAt: null, syncing: false, error: null };

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
async function hs(path, opts, attempt){
  attempt = attempt || 0;
  const res = await fetch(HS + path, Object.assign({
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }
  }, opts || {}));
  if (res.status === 429 && attempt < 5) { await sleep(1200); return hs(path, opts, attempt + 1); }
  if (!res.ok) throw new Error("HubSpot " + res.status + " on " + path + ": " + (await res.text()).slice(0, 300));
  return res.json();
}

async function fetchOwners(){
  const map = {};
  let after;
  do {
    const j = await hs("/crm/v3/owners?limit=100&archived=false" + (after ? "&after=" + after : ""));
    (j.results || []).forEach(o => { map[String(o.id)] = { name: ((o.firstName||"")+" "+(o.lastName||"")).trim() || ("Owner "+o.id), email: o.email || "", active: !o.archived }; });
    after = j.paging && j.paging.next && j.paging.next.after;
  } while (after);
  // archived owners too, so deactivated agents get names
  after = undefined;
  do {
    const j = await hs("/crm/v3/owners?limit=100&archived=true" + (after ? "&after=" + after : ""));
    (j.results || []).forEach(o => { if (!map[String(o.id)]) map[String(o.id)] = { name: ((o.firstName||"")+" "+(o.lastName||"")).trim() || ("Owner "+o.id), email: o.email || "", active: false }; });
    after = j.paging && j.paging.next && j.paging.next.after;
  } while (after);
  return map;
}

async function fetchContactsForOwner(ownerId){
  const out = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: "contact_engagement_stage", operator: "HAS_PROPERTY" },
        { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
      ]}],
      properties: PROPS,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 100,
      after: after
    };
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(r => out.push(Object.assign({ id: r.id }, r.properties)));
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120); // stay well under search rate limits
    if (out.length >= 9900) break; // search API caps at 10k per query
  } while (after);
  return out;
}

async function sync(){
  if (!TOKEN) { CACHE.error = "HUBSPOT_TOKEN (or HUBSPOT_ACCESS_TOKEN) env var is not set"; return; }
  if (CACHE.syncing) return;
  CACHE.syncing = true;
  try {
    const owners = await fetchOwners();
    const ids = Object.keys(owners);
    const contacts = [];
    for (const id of ids) {
      try { const rows = await fetchContactsForOwner(id); contacts.push(...rows); }
      catch (e) { console.error("owner " + id + " sync failed: " + e.message); }
    }
    CACHE = { contacts, owners, loadedAt: new Date().toISOString(), syncing: false, error: null };
    console.log("Synced " + contacts.length + " staged contacts across " + ids.length + " owners");
  } catch (e) {
    CACHE.syncing = false; CACHE.error = e.message;
    console.error("Sync failed: " + e.message);
  }
}

/* ---------- aggregation helpers ---------- */
function ts(v){ if (!v) return 0; const n = Date.parse(v); if (!isNaN(n)) return n; const f = parseFloat(v); return (!isNaN(f) && f > 1e11) ? f : 0; }
function num(v){ const f = parseFloat(v); return isNaN(f) ? 0 : f; }
function classifySP(v){
  const s = (v || "").trim().toLowerCase();
  if (!s || s === "na" || s === "n/a" || s === "none" || s === "-" || s === "no") return "?";
  if (/(student|fresher|intern|graduat|college|final year|^yes$|^s$)/.test(s)) return "S";
  if (/(professional|working|^pro$|freelanc|employe|engineer|developer|analyst|manager|consultant)/.test(s)) return "P";
  return "?";
}
function isPostCouns(c){
  return POST_STAGES.indexOf(c.previous_engagement_stage) >= 0 || String(c.counselling_done) === "true";
}
function filt(creator, agent){
  return CACHE.contacts.filter(c =>
    (!creator || c.topmate_username === creator) &&
    (!agent || c.hubspot_owner_id === agent)
  );
}
function agentMetrics(rows){
  const now = Date.now(), d30 = now - 30 * 86400000, d90 = now - 90 * 86400000, w7 = now - 7 * 86400000;
  const per = {};
  rows.forEach(c => {
    const id = c.hubspot_owner_id;
    if (!per[id]) per[id] = { id, total:0, workable:0, churned:0, overdue:0, nofu:0, stale:0, churnEffort:0, freshRcb:0,
      ownCalls:0, totCalls:0, age30:0, age90:0, ni:0, niPost:0, dq:0, stu:0, pro:0 };
    const a = per[id], st = c.contact_engagement_stage;
    const own = num(c.call_in_current_stage_by_current_owner), all = num(c.callscurrent_stage);
    const isW = WORKABLE.indexOf(st) >= 0, isC = CHURN.indexOf(st) >= 0;
    a.total++; a.ownCalls += own; a.totCalls += all;
    if (isW) a.workable++;
    if (isC) { a.churned++; if (own >= 3) a.churnEffort++; }
    if (isW) {
      const fu = ts(c.follow_up_date_and_time);
      if (!fu) a.nofu++; else if (fu < now) a.overdue++;
      const lc = ts(c.last_call_date_and_time);
      if (lc && lc < w7) a.stale++;
    }
    if (st === "rcb_requested_callback" && !ts(c.last_call_date_and_time)) a.freshRcb++;
    const cd = ts(c.createdate);
    if (cd > d30) a.age30++; else if (cd > d90) a.age90++;
    if (st === "ni_not_interested") { a.ni++; if (isPostCouns(c)) a.niPost++; }
    if (st === "disqualified") a.dq++;
    const sp = classifySP(c.tm_student_or_professional);
    if (sp === "S") a.stu++; else if (sp === "P") a.pro++;
  });
  return Object.values(per).map(a => {
    const o = CACHE.owners[a.id] || {};
    a.name = o.name || ("Owner " + a.id); a.email = o.email || ""; a.active = o.active !== false;
    a.old90 = Math.max(0, a.total - a.age30 - a.age90);
    a.niPre = Math.max(0, a.ni - a.niPost);
    return a;
  });
}

/* ---------- API ---------- */
app.get("/api/meta", (req, res) => res.json({ loadedAt: CACHE.loadedAt, syncing: CACHE.syncing, error: CACHE.error,
  contacts: CACHE.contacts.length, portalId: PORTAL_ID, uiDomain: UI_DOMAIN }));

app.post("/api/refresh", (req, res) => { sync(); res.json({ ok: true }); });

app.get("/api/agents", (req, res) => {
  const rows = filt(req.query.creator, null);
  const creators = {};
  CACHE.contacts.forEach(c => { const u = c.topmate_username; if (u) creators[u] = (creators[u] || 0) + 1; });
  res.json({ loadedAt: CACHE.loadedAt, error: CACHE.error,
    agents: agentMetrics(rows),
    creators: Object.entries(creators).map(([u, n]) => ({ u, n })).sort((a, b) => b.n - a.n).slice(0, 300) });
});

app.get("/api/drill/:id", (req, res) => {
  const rows = filt(req.query.creator, req.params.id);
  const now = Date.now();
  const creators = {}, stageAgg = {}, months = {}, allR = {}, postR = {}, spTopMap = {};
  let spS = 0, spP = 0, spU = 0;
  const niAll = { S:0, P:0, U:0 }, niPost = { S:0, P:0, U:0 };
  rows.forEach(c => {
    const st = c.contact_engagement_stage;
    const u = c.topmate_username || "(no creator)";
    if (!creators[u]) creators[u] = { u, t:0, w:0, c:0, rcb:0, dnp:0, ni:0, dq:0, couns:0, ifc:0, won:0 };
    const k = creators[u]; k.t++;
    if (WORKABLE.indexOf(st) >= 0) k.w++; else if (CHURN.indexOf(st) >= 0) k.c++;
    if (st === "rcb_requested_callback") k.rcb++;
    if (st === "dnp_did_not_pick") k.dnp++;
    if (st === "ni_not_interested") k.ni++;
    if (st === "disqualified") k.dq++;
    if (st === "counselled") k.couns++;
    if (st === "IFC") k.ifc++;
    if (st === "deal_won") k.won++;
    if (!stageAgg[st]) stageAgg[st] = { n:0, calls:0, own:0, tsSum:0, tsN:0 };
    const sa = stageAgg[st];
    sa.n++; sa.calls += num(c.callscurrent_stage); sa.own += num(c.call_in_current_stage_by_current_owner);
    const ent = ts(c.engagement_stage_last_changed_at) || ts(c.createdate);
    if (ent) { sa.tsSum += ent; sa.tsN++; }
    const cd = ts(c.createdate);
    if (cd) { const m = new Date(cd).toISOString().slice(0, 7); months[m] = (months[m] || 0) + 1; }
    const spRaw = c.tm_student_or_professional, sp = classifySP(spRaw);
    if (sp === "S") spS++; else if (sp === "P") spP++; else spU++;
    if (spRaw) spTopMap[spRaw] = (spTopMap[spRaw] || 0) + 1;
    if (st === "ni_not_interested") {
      const key = c.not_interested_reason || "No reason captured";
      allR[key] = (allR[key] || 0) + 1;
      const cls = sp === "S" ? "S" : sp === "P" ? "P" : "U";
      niAll[cls]++;
      if (isPostCouns(c)) { postR[key] = (postR[key] || 0) + 1; niPost[cls]++; }
    }
  });
  Object.values(stageAgg).forEach(sa => {
    sa.days = sa.tsN ? Math.max(1, (now - sa.tsSum / sa.tsN) / 86400000) : 0;
    delete sa.tsSum; delete sa.tsN;
  });
  const post = [], pre = [];
  Object.keys(allR).forEach(k => {
    const p = postR[k] || 0, rest = allR[k] - p;
    if (p > 0) post.push({ l: k, n: p });
    if (rest > 0) pre.push({ l: k, n: rest });
  });
  post.sort((a, b) => b.n - a.n); pre.sort((a, b) => b.n - a.n);
  res.json({
    creators: Object.values(creators).sort((a, b) => b.t - a.t),
    stageAgg, post, pre,
    months: Object.entries(months).map(([m, n]) => ({ m, n })).sort((a, b) => a.m < b.m ? -1 : 1),
    sp: { S: spS, P: spP, U: spU },
    spTop: Object.entries(spTopMap).map(([l, n]) => ({ l: l + " (" + classifySP(l) + ")", n })).filter(x => x.n > 2).sort((a, b) => b.n - a.n).slice(0, 6),
    niPostSP: niPost, niPreSP: { S: niAll.S - niPost.S, P: niAll.P - niPost.P, U: niAll.U - niPost.U }
  });
});

app.get("/api/leads", (req, res) => {
  const rows = filt(req.query.creator, req.query.owner)
    .filter(c => c.contact_engagement_stage === req.query.stage)
    .slice(0, 200)
    .map(c => ({
      id: c.id,
      name: ((c.firstname || "") + " " + (c.lastname || "")).trim() || "(no name)",
      cred: c.topmate_username || "",
      spRaw: c.tm_student_or_professional || "",
      created: ts(c.createdate),
      calls: num(c.callscurrent_stage),
      own: num(c.call_in_current_stage_by_current_owner),
      entered: ts(c.engagement_stage_last_changed_at) || ts(c.createdate),
      last: ts(c.last_call_date_and_time),
      fu: ts(c.follow_up_date_and_time)
    }));
  res.json({ rows });
});

app.get("/api/summary", (req, res) => {
  const rows = filt(req.query.creator, req.query.agent);
  const now = Date.now(), d30 = now - 30 * 86400000;
  const cells = {};
  rows.forEach(c => {
    const cr = c.topmate_username || "(no creator)";
    const key = c.hubspot_owner_id + "|" + cr;
    if (!cells[key]) cells[key] = { owner: c.hubspot_owner_id, cred: cr, total:0, work:0, churn:0, fresh:0, overdue:0, nofu:0, rcbun:0, own:0, tot:0 };
    const x = cells[key], st = c.contact_engagement_stage;
    const isW = WORKABLE.indexOf(st) >= 0;
    x.total++; x.own += num(c.call_in_current_stage_by_current_owner); x.tot += num(c.callscurrent_stage);
    if (isW) {
      x.work++;
      const fu = ts(c.follow_up_date_and_time);
      if (!fu) x.nofu++; else if (fu < now) x.overdue++;
    }
    if (CHURN.indexOf(st) >= 0) x.churn++;
    if (st === "rcb_requested_callback" && !ts(c.last_call_date_and_time)) x.rcbun++;
    if (ts(c.createdate) > d30) x.fresh++;
  });
  res.json({ cells: Object.values(cells) });
});

app.use(express.static("public"));
app.listen(PORT, () => {
  console.log("Listening on " + PORT);
  sync();
  setInterval(sync, SYNC_MINUTES * 60 * 1000);
});
