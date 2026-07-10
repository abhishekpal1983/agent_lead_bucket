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
const SYNC_MINUTES = parseInt(process.env.SYNC_MINUTES || "10", 10);
const REFRESH_KEY = process.env.REFRESH_KEY || "";
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

const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

let CACHE = { contacts: [], owners: {}, loadedAt: null, syncing: false, error: null };
let SHEET = { rows: [], loadedAt: null, error: null };

function parseCSV(text){
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (inQ){
      if (ch === '"'){ if (text[i+1] === '"'){ cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r"){
      if (ch === "\r" && text[i+1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function syncSheet(){
  if (!SHEET_CSV_URL) { SHEET.error = "SHEET_CSV_URL env var is not set"; return; }
  try {
    const res = await fetch(SHEET_CSV_URL, { redirect: "follow" });
    if (!res.ok) throw new Error("Sheet fetch " + res.status);
    const grid = parseCSV(await res.text());
    if (grid.length < 2) throw new Error("Sheet is empty");
    const head = grid[0].map(h => h.trim().toLowerCase());
    const rows = grid.slice(1).map(r => {
      const o = {};
      head.forEach((h, i) => o[h] = (r[i] || "").trim());
      o.price = parseFloat(String(o.price_inr).replace(/[^0-9.\-]/g, "")) || 0;
      return o;
    }).filter(o => o.date);
    SHEET = { rows, loadedAt: new Date().toISOString(), error: null };
    console.log("Sheet synced: " + rows.length + " rows");
  } catch (e) {
    SHEET.error = e.message;
    console.error("Sheet sync failed: " + e.message);
  }
}

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

/* ---------- payment-analysis cohort data (HubSpot contacts per sheet creator) ---------- */
const COHORT_MINUTES = parseInt(process.env.COHORT_MINUTES || "60", 10);
let COHORT = { emails: new Map(), phones: new Map(), counts: {}, loadedAt: null, syncing: false, error: null };

function ymOf(ms){ if (!ms) return ""; const d = new Date(ms); return isNaN(d) ? "" : d.toISOString().slice(0, 7); }
function normPhone(v){ const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; }
function normSrc(v){
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "unknown";
  const main = ["import","digital product","marketing webinar","forms","1:1 video call","revspot","webinar","integration","thinksage webinar","topmate","crm ui","text query"];
  return main.indexOf(s) >= 0 ? s : "other";
}
function segOf(v){
  const c = (function(s){
    s = (s || "").trim().toLowerCase();
    if (!s || s === "na" || s === "n/a" || s === "none" || s === "-" || s === "no") return "?";
    if (/(student|fresher|intern|graduat|college|final year|^yes$|^s$)/.test(s)) return "S";
    if (/(professional|working|^pro$|freelanc|employe|engineer|developer|analyst|manager|consultant)/.test(s)) return "P";
    return "?";
  })(v);
  return c === "S" ? "Student" : c === "P" ? "Professional" : "Unknown";
}

async function fetchCohortRange(creator, from, to, sink){
  // recursive: split window if it would hit the 10k search cap
  const filters = [{ propertyName: "topmate_username", operator: "EQ", value: creator }];
  if (from) filters.push({ propertyName: "createdate", operator: "GTE", value: String(from) });
  if (to) filters.push({ propertyName: "createdate", operator: "LT", value: String(to) });
  const probe = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters }], properties: ["createdate"], limit: 1 }) });
  const total = probe.total || 0;
  if (total === 0) return;
  if (total > 9500 && from && to && (to - from) > 86400000) {
    const mid = Math.floor((from + to) / 2);
    await fetchCohortRange(creator, from, mid, sink);
    await fetchCohortRange(creator, mid, to, sink);
    return;
  }
  let after;
  do {
    const body = { filterGroups: [{ filters }],
      properties: ["createdate", "actual_source", "tm_student_or_professional", "email", "phone"],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], limit: 100, after };
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(r => sink(r.properties));
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
  } while (after);
}

async function syncCohorts(){
  if (!TOKEN || COHORT.syncing) return;
  if (!SHEET.rows.length) return; // needs sheet creators
  COHORT.syncing = true;
  try {
    const creators = Array.from(new Set(SHEET.rows.map(r => r.creator_username).filter(Boolean)));
    const emails = new Map(), phones = new Map(), counts = {};
    const now = Date.now();
    for (const cr of creators) {
      const sink = p => {
        const ym = ymOf(parseInt(p.createdate) || Date.parse(p.createdate));
        if (!ym) return;
        const src = normSrc(p.actual_source), seg = segOf(p.tm_student_or_professional);
        if (!counts[cr]) counts[cr] = {};
        if (!counts[cr][ym]) counts[cr][ym] = {};
        if (!counts[cr][ym][src]) counts[cr][ym][src] = {};
        counts[cr][ym][src][seg] = (counts[cr][ym][src][seg] || 0) + 1;
        const rec = ym + "|" + src + "|" + seg + "|" + cr;
        const em = (p.email || "").toLowerCase();
        if (em && !emails.has(em)) emails.set(em, rec);
        const ph = normPhone(p.phone);
        if (ph && !phones.has(ph)) phones.set(ph, rec);
      };
      try { await fetchCohortRange(cr, Date.parse("2024-01-01"), now + 86400000, sink); }
      catch (e) { console.error("cohort " + cr + ": " + e.message); }
    }
    COHORT = { emails, phones, counts, loadedAt: new Date().toISOString(), syncing: false, error: null };
    console.log("Cohort sync: " + emails.size + " contacts across " + creators.length + " creators");
  } catch (e) {
    COHORT.syncing = false; COHORT.error = e.message;
    console.error("Cohort sync failed: " + e.message);
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
  contacts: CACHE.contacts.length, portalId: PORTAL_ID, uiDomain: UI_DOMAIN,
  sheetLoadedAt: SHEET.loadedAt, sheetRows: SHEET.rows.length, sheetError: SHEET.error,
  cohortLoadedAt: COHORT.loadedAt, cohortContacts: COHORT.emails.size, cohortSyncing: COHORT.syncing, cohortError: COHORT.error }));

app.get("/api/enrolments", (req, res) => {
  const creator = req.query.creator || "";
  const month = req.query.month || "";
  const agentId = req.query.agent || "";
  let agentEmail = (req.query.agentEmail || "").toLowerCase();
  if (!agentEmail && agentId && CACHE.owners[agentId]) agentEmail = (CACHE.owners[agentId].email || "").toLowerCase();
  const rows = SHEET.rows.filter(r =>
    (!creator || (r.creator_username || "") === creator) &&
    (!agentEmail || (r.owner_email || "").toLowerCase() === agentEmail) &&
    (!month || (r.date || "").slice(0, 7) === month)
  );
  const optMonths = {}, optAgents = {}, optCreators = {};
  SHEET.rows.forEach(r => {
    const m = (r.date || "").slice(0, 7);
    if (m) optMonths[m] = 1;
    const em = (r.owner_email || "").toLowerCase();
    if (em) optAgents[em] = r.sales_rep || em;
    if (r.creator_username) optCreators[r.creator_username] = (optCreators[r.creator_username] || 0) + 1;
  });
  const thisMonth = new Date().toISOString().slice(0, 7);
  function bucketize(keyFn){
    const m = {};
    rows.forEach(r => {
      const k = keyFn(r) || "(unknown)";
      if (!m[k]) m[k] = { key: k, enrol: 0, revenue: 0, students: {}, completed: 0, ongoing: 0, loan: 0, monthRev: 0, monthEnrol: 0 };
      const b = m[k];
      b.enrol++; b.revenue += r.price;
      if (r.consumer_email) b.students[r.consumer_email.toLowerCase()] = 1;
      const st = (r.status || "").toLowerCase();
      if (st === "completed") b.completed++; else if (st === "ongoing") b.ongoing++; else if (st === "loan" || (r.booking_type||"").toLowerCase() === "loan") b.loan++;
      if ((r.date || "").slice(0, 7) === thisMonth) { b.monthRev += r.price; b.monthEnrol++; }
    });
    return Object.values(m).map(b => { b.students = Object.keys(b.students).length; return b; })
      .sort((a, b) => b.revenue - a.revenue);
  }
  const byDay = {};
  rows.forEach(r => {
    const d = (r.date || "").slice(0, 10);
    if (!d) return;
    if (!byDay[d]) byDay[d] = { d, n: 0, rev: 0 };
    byDay[d].n++; byDay[d].rev += r.price;
  });
  const students = {};
  rows.forEach(r => { if (r.consumer_email) students[r.consumer_email.toLowerCase()] = 1; });
  res.json({
    loadedAt: SHEET.loadedAt, error: SHEET.error,
    options: {
      months: Object.keys(optMonths).sort().reverse(),
      agents: Object.entries(optAgents).map(([email, name]) => ({ email, name })).sort((a, b) => a.name.localeCompare(b.name)),
      creators: Object.entries(optCreators).sort((a, b) => b[1] - a[1]).map(([u, n]) => ({ u, n }))
    },
    totals: {
      enrol: rows.length,
      students: Object.keys(students).length,
      revenue: rows.reduce((t, r) => t + r.price, 0),
      monthEnrol: rows.filter(r => (r.date || "").slice(0, 7) === thisMonth).length,
      monthRevenue: rows.filter(r => (r.date || "").slice(0, 7) === thisMonth).reduce((t, r) => t + r.price, 0)
    },
    byAgent: bucketize(r => r.owner_email ? (r.sales_rep || r.owner_email) + "|" + r.owner_email : r.sales_rep),
    byCreator: bucketize(r => r.creator_username),
    byDay: Object.values(byDay).sort((a, b) => a.d < b.d ? -1 : 1).slice(-45),
    recent: rows.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30).map(r => ({
      date: r.date, rep: r.sales_rep, creator: r.creator_username, consumer: r.consumer_name,
      service: r.service_title, price: r.price, status: r.status, type: r.booking_type, source: r.source
    }))
  });
});

app.post("/api/refresh", (req, res) => {
  if (REFRESH_KEY && req.query.key !== REFRESH_KEY) return res.status(403).json({ ok: false, error: "bad key" });
  sync(); syncSheet();
  res.json({ ok: true, syncing: true });
});

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

app.get("/api/payment-analysis", (req, res) => {
  const fCreator = req.query.creator || "", fSource = req.query.source || "", fSegment = req.query.segment || "";
  // enrich payments: match to HubSpot contact, classify, mark first payment (enrolment)
  const seen = new Set();
  const pays = SHEET.rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map(r => {
    const em = (r.consumer_email || "").toLowerCase(), ph = normPhone(r.consumer_phone);
    const rec = (em && COHORT.emails.get(em)) || (ph && COHORT.phones.get(ph)) || "";
    const [cym, src, seg] = rec ? rec.split("|") : ["", "", ""];
    const pym = (r.date || "").slice(0, 7);
    let cls = "Not in HubSpot";
    if (rec) cls = cym === pym ? "New Lead" : (cym < pym ? "Old Lead" : "Lead After Payment");
    const key = (r.creator_username || "") + "|" + (em || ph || r.id);
    const isEnrol = !seen.has(key); seen.add(key);
    return { pym, cym, price: r.price, creator: r.creator_username || "(none)", agent: r.sales_rep || r.owner_email || "(none)",
      src: rec ? src : "Not in HubSpot", seg: rec ? seg : "Unknown", cls, isEnrol };
  }).filter(p => p.pym &&
    (!fCreator || p.creator === fCreator) &&
    (!fSource || p.src === fSource) &&
    (!fSegment || p.seg === fSegment));

  const CLS = ["New Lead", "Old Lead", "Lead After Payment", "Not in HubSpot"];
  function blank(){ const o = { total:0, enrol:0, bal:0, revenue:0, enrolRev:0, balRev:0 }; CLS.forEach(c => o[c] = 0); return o; }
  function acc(o, p){
    o.total++; o.revenue += p.price; o[p.cls]++;
    if (p.isEnrol) { o.enrol++; o.enrolRev += p.price; } else { o.bal++; o.balRev += p.price; }
  }
  const byMonth = {}, bySrc = {}, byCreator = {}, byAgent = {};
  pays.forEach(p => {
    if (!byMonth[p.pym]) byMonth[p.pym] = blank(); acc(byMonth[p.pym], p);
    const mSel = req.query.month || "";
    if (!mSel || p.pym === mSel) {
      if (!bySrc[p.src]) bySrc[p.src] = blank(); acc(bySrc[p.src], p);
      if (!byCreator[p.creator]) byCreator[p.creator] = blank(); acc(byCreator[p.creator], p);
      if (!byAgent[p.agent]) byAgent[p.agent] = blank(); acc(byAgent[p.agent], p);
    }
  });

  // cohort matrix: rows = contact create month, cols = enrolment (first payment) month
  const payMonths = Object.keys(byMonth).sort();
  const cohortEnrol = {}; // cym -> pym -> n
  pays.forEach(p => {
    if (!p.isEnrol || !p.cym) return;
    if (!cohortEnrol[p.cym]) cohortEnrol[p.cym] = { _n: 0 };
    cohortEnrol[p.cym][p.pym] = (cohortEnrol[p.cym][p.pym] || 0) + 1;
    cohortEnrol[p.cym]._n++;
  });
  const hsByYm = {};
  Object.keys(COHORT.counts).forEach(cr => {
    if (fCreator && cr !== fCreator) return;
    Object.keys(COHORT.counts[cr]).forEach(ym => {
      Object.keys(COHORT.counts[cr][ym]).forEach(src => {
        if (fSource && src !== fSource) return;
        Object.keys(COHORT.counts[cr][ym][src]).forEach(seg => {
          if (fSegment && seg !== fSegment) return;
          hsByYm[ym] = (hsByYm[ym] || 0) + COHORT.counts[cr][ym][src][seg];
        });
      });
    });
  });
  const cohortMonths = Array.from(new Set(Object.keys(hsByYm).concat(Object.keys(cohortEnrol)))).sort();
  const cohort = cohortMonths.map(cym => {
    const row = { cym, hs: hsByYm[cym] || 0, enrol: (cohortEnrol[cym] && cohortEnrol[cym]._n) || 0, cols: {} };
    payMonths.forEach(pm => { row.cols[pm] = (cohortEnrol[cym] && cohortEnrol[cym][pm]) || 0; });
    row.conv = row.hs ? +(100 * row.enrol / row.hs).toFixed(2) : null;
    return row;
  });

  const srcOptions = Array.from(new Set(pays.map(p => p.src))).sort();
  const crOptions = Array.from(new Set(SHEET.rows.map(r => r.creator_username).filter(Boolean))).sort();
  res.json({
    sheetLoadedAt: SHEET.loadedAt, cohortLoadedAt: COHORT.loadedAt, cohortSyncing: COHORT.syncing,
    sheetError: SHEET.error, cohortError: COHORT.error,
    options: { months: payMonths.slice().reverse(), sources: srcOptions, creators: crOptions, segments: ["Student", "Professional", "Unknown"] },
    byMonth: payMonths.map(m => Object.assign({ month: m }, byMonth[m])),
    bySrc: Object.entries(bySrc).map(([k, v]) => Object.assign({ name: k }, v)).sort((a, b) => b.revenue - a.revenue),
    byCreator: Object.entries(byCreator).map(([k, v]) => Object.assign({ name: k }, v)).sort((a, b) => b.revenue - a.revenue),
    byAgent: Object.entries(byAgent).map(([k, v]) => Object.assign({ name: k }, v)).sort((a, b) => b.revenue - a.revenue),
    cohort, payMonths
  });
});

app.get("/api/leads-created", (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const out = {};
  Object.keys(COHORT.counts).forEach(cr => {
    const ym = COHORT.counts[cr][month];
    if (!ym) return;
    const bySrc = {}; let total = 0;
    Object.keys(ym).forEach(src => {
      Object.keys(ym[src]).forEach(seg => { bySrc[src] = (bySrc[src] || 0) + ym[src][seg]; total += ym[src][seg]; });
    });
    out[cr] = { total, bySrc };
  });
  res.json({ month, loadedAt: COHORT.loadedAt, syncing: COHORT.syncing, error: COHORT.error, creators: out });
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
  syncSheet().then(() => syncCohorts());
  setInterval(sync, SYNC_MINUTES * 60 * 1000);
  setInterval(syncSheet, SYNC_MINUTES * 60 * 1000);
  setInterval(syncCohorts, COHORT_MINUTES * 60 * 1000);
});
