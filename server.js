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
app.use(function(req, res, next){ return authGate(req, res, next); });
app.use(express.json());

const TOKEN = process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY;
const PORT = process.env.PORT || 3000;
const SYNC_MINUTES = parseInt(process.env.SYNC_MINUTES || "30", 10);
const REFRESH_KEY = process.env.REFRESH_KEY || "";
const PORTAL_ID = process.env.HS_PORTAL_ID || "244132076";
const UI_DOMAIN = process.env.HS_UI_DOMAIN || "app-na2.hubspot.com";
const HS = "https://api.hubapi.com";

const PROPS = [
  "email","phone","international_number","actual_source",
  "hubspot_owner_id","contact_engagement_stage","topmate_username",
  "callscurrent_stage","call_in_current_stage_by_current_owner",
  "createdate","follow_up_date_and_time","last_call_date_and_time",
  "engagement_stage_last_changed_at","tm_student_or_professional",
  "not_interested_reason","counselling_done","previous_engagement_stage",
  "conversion_probability_score","recent_conversion_event_name","first_conversion_event_name",
  "conversion_probability_reason","tm_last_booking_title", "tm_last_booking_type", "tm_last_booking_timestamp", "tm_total_bookings",
  "ryl_aicall_summary","ryl_aicall_hotness","ryl_aicall_optout",
  "call_outcome","reason_for_notinteresteddisqualifiedghosted","notes_last_contacted",
  "hs_timezone","country",
  "firstname","lastname"
];
const WORKABLE = ["rcb_requested_callback","discovery","program_pitched","pricing_pitched","counselled","Follow up","FU_DNP","FU_RCB","payment_prospect"];
const CHURN = ["dnp_did_not_pick","ghosted","ni_not_interested","disqualified"];
const POST_STAGES = ["discovery","program_pitched","pricing_pitched","counselled","payment_prospect","IFC","FU_DNP","FU_RCB","Follow up"];

/* ---------- Leads-Today checkpoint tracker ---------- */
const LEADS_TODAY_LIST_ID = process.env.LEADS_TODAY_LIST_ID || "1623"; // ILS segment id for "Leads-Today"
const CLOSED_STAGES = ["ni_not_interested", "disqualified", "IFC"];
const CHECKPOINT_TIMES = ["10:00", "15:30", "17:30", "19:30", "21:30"]; // IST, HH:MM 24h
const LT_PROPS = [
  "contact_engagement_stage", "follow_up_date_and_time", "last_call_date_and_time",
  "engagement_stage_last_changed_at", "hubspot_owner_id", "topmate_username",
  "llm_personalised_email_clicked", "personalised_email_link_clicked_date",
  "firstname", "lastname"
];
let LEADS_TODAY = { date: null, byId: {}, ranToday: {}, loadedAt: null, syncing: false, error: null };

/* ---------- Agent bucket refill: leads parked with Abhishek Pal, tagged to a backup owner ---------- */
const ABHISHEK_OWNER_ID = process.env.ABHISHEK_OWNER_ID || "165087274";
const BACKUP_PROPS = [
  "contact_engagement_stage", "backup_owner", "topmate_username", "createdate",
  "follow_up_date_and_time", "firstname", "lastname", "international_number", "actual_source"
];
let BACKUP = { rows: [], loadedAt: null, syncing: false, error: null };
let ASSIGN_LOG = [];

const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

let CACHE = { contacts: [], owners: {}, fresh: {}, loadedAt: null, syncing: false, error: null };
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
    rows.forEach((o, i) => { o._row = i; });
    SHEET = { rows, loadedAt: new Date().toISOString(), error: null };
    console.log("Sheet synced: " + rows.length + " rows");
  } catch (e) {
    SHEET.error = e.message;
    console.error("Sheet sync failed: " + e.message);
  }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
const HS_TIMEOUT_MS = parseInt(process.env.HS_TIMEOUT_MS || "30000", 10);
async function hs(path, opts, attempt){
  attempt = attempt || 0;
  let res;
  try {
    // Without a timeout a hung socket stalls a sync forever. Without catching the throw,
    // a single transient "fetch failed" kills an eighty page walk, because undici raises
    // before there is any status to inspect and the 429 branch never sees it.
    const ac = new AbortController();
    const timer = setTimeout(function(){ ac.abort(); }, HS_TIMEOUT_MS);
    try {
      res = await fetch(HS + path, Object.assign({
        signal: ac.signal,
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }
      }, opts || {}));
    } finally { clearTimeout(timer); }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (attempt < 4) {
      await sleep(800 * Math.pow(2, attempt));
      return hs(path, opts, attempt + 1);
    }
    throw new Error("HubSpot unreachable on " + path + " after " + (attempt + 1) + " tries: " + msg);
  }
  if (res.status === 429 && attempt < 5) { await sleep(1200); return hs(path, opts, attempt + 1); }
  if (res.status >= 500 && attempt < 4) { await sleep(800 * Math.pow(2, attempt)); return hs(path, opts, attempt + 1); }
  if (!res.ok) throw new Error("HubSpot " + res.status + " on " + path + ": " + (await res.text()).slice(0, 300));
  return res.json();
}

// A HubSpot user who never filled in a name would otherwise render as "Owner 166827115".
// Their email is far more useful than the internal id.
function ownerLabel(o){
  const n = ((o.firstName || "") + " " + (o.lastName || "")).trim();
  if (n) return n;
  const e = String(o.email || "").trim();
  if (e) return e.split("@")[0];
  return "Owner " + o.id;
}
async function fetchOwners(){
  const map = {};
  let after;
  do {
    const j = await hs("/crm/v3/owners?limit=100&archived=false" + (after ? "&after=" + after : ""));
    (j.results || []).forEach(o => { map[String(o.id)] = { name: ownerLabel(o), email: o.email || "", active: !o.archived }; });
    after = j.paging && j.paging.next && j.paging.next.after;
  } while (after);
  // archived owners too, so deactivated agents get names
  after = undefined;
  do {
    const j = await hs("/crm/v3/owners?limit=100&archived=true" + (after ? "&after=" + after : ""));
    (j.results || []).forEach(o => { if (!map[String(o.id)]) map[String(o.id)] = { name: ownerLabel(o), email: o.email || "", active: false }; });
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

async function fetchFreshForOwner(ownerId){
  // fresh leads: engagement stage NOT set, any create month
  const out = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: "contact_engagement_stage", operator: "NOT_HAS_PROPERTY" },
        { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
      ]}],
      properties: ["firstname", "lastname", "topmate_username", "createdate", "international_number", "actual_source",
        "email", "phone", "conversion_probability_score", "recent_conversion_event_name", "first_conversion_event_name",
        "follow_up_date_and_time", "last_call_date_and_time", "tm_student_or_professional",
        "hs_timezone", "country", "conversion_probability_reason"],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: 100, after
    };
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(r => out.push(Object.assign({ id: r.id }, r.properties)));
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
    if (out.length >= 9500) break;
  } while (after);
  return out;
}

/* Progress, so a ten minute wait after a restart is something you can watch rather than
   something you have to trust. The cache is only published at the end of the loop, which
   is why every page is empty until then. */
const { mapLimit } = require("./lib/pool");
// Four at a time keeps well inside HubSpot's limits and cuts the boot wait by about that
// much. Raise with SYNC_CONCURRENCY if the portal tolerates more.
const SYNC_CONCURRENCY = Math.max(1, parseInt(process.env.SYNC_CONCURRENCY || "4", 10));
let SYNC_PROGRESS = { owners: 0, done: 0, contacts: 0, phase: "", startedAt: null, at: null };

async function sync(){
  if (!TOKEN) { CACHE.error = "HUBSPOT_TOKEN (or HUBSPOT_ACCESS_TOKEN) env var is not set"; return; }
  if (CACHE.syncing) return;
  CACHE.syncing = true;
  try {
    const owners = await fetchOwners();
    CACHE.owners = owners; // make owner names available immediately, before the (slower) per-owner contact fetch below finishes
    const ids = Object.keys(owners);
    const contacts = [];
    const fresh = {};
    let freshTotal = 0;
    SYNC_PROGRESS = { owners: ids.length, done: 0, contacts: 0, phase: "staged leads",
      startedAt: new Date().toISOString(), at: new Date().toISOString() };

    /* Two changes here, both aimed at the ten minute dead zone after every restart.

       One: owners are fetched several at a time instead of one after another. HubSpot
       is perfectly happy with this and hs() already backs off on a 429, so the wall
       clock drops roughly in proportion to the concurrency.

       Two: staged leads are published as soon as they are all in, before the fresh
       pull starts. Staged leads are what every stage table needs, so the app becomes
       usable at that point rather than at the very end. Fresh leads are folded in a
       moment later and the page picks them up on its next read. */
    const step = function(){
      SYNC_PROGRESS.done++;
      SYNC_PROGRESS.at = new Date().toISOString();
    };
    const staged = await mapLimit(ids, SYNC_CONCURRENCY, async function(id){
      try { const rows = await fetchContactsForOwner(id); step(); return rows; }
      catch (e) { console.error("owner " + id + " sync failed: " + e.message); step(); return []; }
    });
    staged.forEach(function(rows){ contacts.push(...rows); });
    SYNC_PROGRESS.contacts = contacts.length;
    // Publish the half that matters most, then keep going.
    CACHE = { contacts: contacts, owners: owners, fresh: CACHE.fresh || {},
      loadedAt: new Date().toISOString(), syncing: true, error: null, partial: "fresh leads still loading" };
    POOL_REV++;
    console.log("Staged leads published: " + contacts.length + " across " + ids.length + " owners, fresh still loading");

    SYNC_PROGRESS.phase = "fresh leads";
    SYNC_PROGRESS.done = 0;
    const freshRows = await mapLimit(ids, SYNC_CONCURRENCY, async function(id){
      try { const fr = await fetchFreshForOwner(id); step(); return { id: id, rows: fr }; }
      catch (e) { console.error("owner " + id + " fresh sync failed: " + e.message); step(); return { id: id, rows: [] }; }
    });
    freshRows.forEach(function(x){ if (x.rows.length) { fresh[x.id] = x.rows; freshTotal += x.rows.length; } });
    SYNC_PROGRESS.contacts = contacts.length + freshTotal;
    CACHE = { contacts, owners, fresh, loadedAt: new Date().toISOString(), syncing: false, error: null, partial: null };
    POOL_REV++;
    console.log("Synced " + contacts.length + " staged contacts + " + freshTotal + " fresh (no stage) across " + ids.length + " owners");
  } catch (e) {
    CACHE.syncing = false; CACHE.error = e.message;
    console.error("Sync failed: " + e.message);
  }
}

/* ---------- Incremental lead sync ----------
   The full per-owner rebuild reads ~29k contacts every pass to find that a couple of
   hundred changed. This asks HubSpot only for contacts modified since the last run,
   using an hs_object_id cursor so it cannot hit the 10k search ceiling, and merges them
   into the existing cache by id. A full rebuild still runs on boot and nightly, which
   is what catches deletions and merges that a delta can never see. */
const DELTA_MINUTES = parseInt(process.env.DELTA_MINUTES || "10", 10);
const FULL_SYNC_HOURS = parseFloat(process.env.FULL_SYNC_HOURS || "12");
const DELTA_OVERLAP_MIN = parseInt(process.env.DELTA_OVERLAP_MIN || "60", 10);
let DELTA = { at: null, running: false, lastCount: 0, lastMs: 0, error: null, since: null, disabled: String(process.env.DELTA_OFF || "") === "1" };

async function fetchModifiedSince(sinceMs){
  const out = [];
  let lastId = "0", guard = 0;
  while (guard < 800) {
    guard++;
    const filters = [
      { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(sinceMs) },
      { propertyName: "hs_object_id", operator: "GT", value: String(lastId) }
    ];
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
      filterGroups: [{ filters }], properties: PROPS,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], limit: 100 })});
    const rows = j.results || [];
    if (!rows.length) break;
    rows.forEach(function(r){ out.push(Object.assign({ id: r.id }, r.properties)); });
    lastId = rows[rows.length - 1].id;
    if (rows.length < 100) break;
    await sleep(120);
  }
  return out;
}

// Route each changed contact to the right bucket. A lead that gained a stage moves out
// of fresh; one that lost its owner leaves the pool entirely.
function applyDelta(rows){
  const idxStaged = {};
  CACHE.contacts.forEach(function(c, i){ idxStaged[c.id] = i; });
  const fresh = Object.assign({}, CACHE.fresh || {});
  const freshOwnerOf = {};
  Object.keys(fresh).forEach(function(oid){
    (fresh[oid] || []).forEach(function(f){ freshOwnerOf[f.id] = oid; });
  });
  let staged = 0, fr = 0, dropped = 0;
  const dropFromFresh = function(id){
    const oid = freshOwnerOf[id];
    if (oid === undefined) return;
    fresh[oid] = (fresh[oid] || []).filter(function(f){ return f.id !== id; });
    delete freshOwnerOf[id];
  };
  rows.forEach(function(c){
    const owner = String(c.hubspot_owner_id || "");
    const hasStage = !!c.contact_engagement_stage;
    if (!owner) {
      if (idxStaged[c.id] !== undefined) { CACHE.contacts[idxStaged[c.id]] = null; delete idxStaged[c.id]; }
      dropFromFresh(c.id);
      dropped++;
      return;
    }
    if (hasStage) {
      dropFromFresh(c.id);
      if (idxStaged[c.id] !== undefined) CACHE.contacts[idxStaged[c.id]] = c;
      else { CACHE.contacts.push(c); idxStaged[c.id] = CACHE.contacts.length - 1; }
      staged++;
    } else {
      if (idxStaged[c.id] !== undefined) { CACHE.contacts[idxStaged[c.id]] = null; delete idxStaged[c.id]; }
      const prev = freshOwnerOf[c.id];
      if (prev !== undefined && prev !== owner) dropFromFresh(c.id);
      if (!fresh[owner]) fresh[owner] = [];
      const at = fresh[owner].findIndex(function(f){ return f.id === c.id; });
      if (at >= 0) fresh[owner][at] = c; else fresh[owner].push(c);
      freshOwnerOf[c.id] = owner;
      fr++;
    }
  });
  CACHE.contacts = CACHE.contacts.filter(Boolean);
  CACHE.fresh = fresh;
  POOL_REV++;
  return { staged: staged, fresh: fr, dropped: dropped };
}

async function syncDelta(){
  if (!TOKEN || DELTA.disabled || DELTA.running) return;
  if (CACHE.syncing) return;                 // a full rebuild is authoritative, do not fight it
  if (!CACHE.loadedAt) return;               // nothing to merge into yet
  DELTA.running = true;
  const t0 = Date.now();
  try {
    const base = DELTA.at ? Date.parse(DELTA.at) : Date.parse(CACHE.loadedAt);
    const since = base - DELTA_OVERLAP_MIN * 60000;
    const rows = await fetchModifiedSince(since);
    const r = applyDelta(rows);
    DELTA = { at: new Date().toISOString(), running: false, lastCount: rows.length, lastMs: Date.now() - t0,
      error: null, since: new Date(since).toISOString(), disabled: DELTA.disabled };
    console.log("Delta sync: " + rows.length + " changed contacts in " + DELTA.lastMs + "ms (" +
      r.staged + " staged, " + r.fresh + " fresh, " + r.dropped + " unassigned) · pool now " +
      CACHE.contacts.length + " staged");
  } catch (e) {
    DELTA.running = false; DELTA.error = e.message;
    console.error("Delta sync failed: " + e.message);
  }
}

/* ---------- counselling detection via engagement stage history ---------- */
const COUNSELLED_SET = ["discovery","program_pitched","pricing_pitched","counselled","payment_prospect","Follow up","FU_DNP","FU_RCB"];
let COUNSEL = { byId: {}, loadedAt: null, syncing: false, error: null };

async function syncCounsel(){
  if (!TOKEN || COUNSEL.syncing) return;
  if (!CACHE.contacts.length) return;
  COUNSEL.syncing = true;
  try {
    const ids = CACHE.contacts.map(c => c.id);
    const byId = {};
    for (let i = 0; i < ids.length; i += 50) {
      const inputs = ids.slice(i, i + 50).map(id => ({ id }));
      try {
        const j = await hs("/crm/v3/objects/contacts/batch/read", { method: "POST",
          body: JSON.stringify({ propertiesWithHistory: ["contact_engagement_stage"], properties: ["contact_engagement_stage"], inputs }) });
        (j.results || []).forEach(r => {
          const h = (r.propertiesWithHistory && r.propertiesWithHistory.contact_engagement_stage) || [];
          let first = 0;
          h.forEach(e => {
            if (COUNSELLED_SET.indexOf(e.value) >= 0) {
              const t = Date.parse(e.timestamp);
              if (t && (!first || t < first)) first = t;
            }
          });
          if (first) byId[r.id] = first;
        });
      } catch (e) { console.error("counsel batch @" + i + ": " + e.message); }
      await sleep(130);
    }
    COUNSEL = { byId, loadedAt: new Date().toISOString(), syncing: false, error: null };
    console.log("Counsel history: " + Object.keys(byId).length + " counselled of " + ids.length + " owned staged leads");
  } catch (e) {
    COUNSEL.syncing = false; COUNSEL.error = e.message;
    console.error("Counsel sync failed: " + e.message);
  }
}

/* ---------- payment-analysis cohort data (HubSpot contacts per sheet creator) ---------- */
const COHORT_MINUTES = parseInt(process.env.COHORT_MINUTES || "60", 10);
let COHORT = { emails: new Map(), phones: new Map(), counts: {}, loadedAt: null, syncing: false, error: null };

function ymOf(v){
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "string" && /[^0-9.]/.test(v)) { const d = Date.parse(v); return isNaN(d) ? "" : new Date(d).toISOString().slice(0, 7); }
  const n = parseFloat(v);
  if (!isNaN(n) && n > 1e11) return new Date(n).toISOString().slice(0, 7);
  return "";
}
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
  if (total === 0) return { fetched: 0, total: 0, truncated: false };
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
        const ym = ymOf(p.createdate);
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

/* ---------- call logs for connectivity (baseline + current month) ---------- */
const BASELINE_MONTH = process.env.BASELINE_MONTH || "2026-06";
let CALLS = { byMonth: {}, dispositions: {}, loadedAt: null, syncing: false, error: null };

async function fetchCallsRange(fromMs, toMs, sink, depth){
  const filters = [
    { propertyName: "hs_timestamp", operator: "GTE", value: String(fromMs) },
    { propertyName: "hs_timestamp", operator: "LT", value: String(toMs) }
  ];
  const probe = await hs("/crm/v3/objects/calls/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters }], properties: ["hs_timestamp"], limit: 1 }) });
  const total = probe.total || 0;
  if (total === 0) return { fetched: 0, total: 0, truncated: false };
  if (total > 9500 && (toMs - fromMs) > 3600000 && (depth || 0) < 12) {
    const mid = Math.floor((fromMs + toMs) / 2);
    await fetchCallsRange(fromMs, mid, sink, (depth || 0) + 1);
    await fetchCallsRange(mid, toMs, sink, (depth || 0) + 1);
    return;
  }
  let after, pages = 0;
  do {
    const body = { filterGroups: [{ filters }],
      properties: ["hs_call_disposition", "hubspot_owner_id", "hs_timestamp"],
      sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }], limit: 100, after };
    const j = await hs("/crm/v3/objects/calls/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(r => sink(r.properties));
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
    pages++;
  } while (after && pages < 100);
}

async function syncCalls(){
  if (!TOKEN || CALLS.syncing) return;
  CALLS.syncing = true;
  try {
    if (!Object.keys(CALLS.dispositions).length) {
      try {
        const d = await hs("/calling/v1/dispositions");
        (Array.isArray(d) ? d : (d.results || [])).forEach(x => { CALLS.dispositions[x.id] = x.label; });
      } catch (e) { console.error("dispositions: " + e.message); }
    }
    const months = Array.from(new Set([BASELINE_MONTH, new Date().toISOString().slice(0, 7)]));
    const byMonth = {};
    for (const ym of months) {
      // baseline month: don't refetch once loaded (it never changes)
      if (ym === BASELINE_MONTH && CALLS.byMonth[ym] && !CALLS.byMonth[ym].partial) { byMonth[ym] = CALLS.byMonth[ym]; continue; }
      const m0 = Date.parse(ym + "-01T00:00:00Z");
      const m1 = new Date(m0); m1.setUTCMonth(m1.getUTCMonth() + 1);
      const agg = { att: 0, conn: 0, byOwner: {} };
      const sink = p => {
        const oid = p.hubspot_owner_id || "";
        if (!agg.byOwner[oid]) agg.byOwner[oid] = { att: 0, conn: 0 };
        agg.att++; agg.byOwner[oid].att++;
        const label = CALLS.dispositions[p.hs_call_disposition] || p.hs_call_disposition || "";
        if (/connected/i.test(label)) { agg.conn++; agg.byOwner[oid].conn++; }
      };
      try { await fetchCallsRange(m0, m1.getTime(), sink); }
      catch (e) { agg.partial = true; console.error("calls " + ym + ": " + e.message); }
      byMonth[ym] = agg;
    }
    CALLS = { byMonth: Object.assign({}, CALLS.byMonth, byMonth), dispositions: CALLS.dispositions, loadedAt: new Date().toISOString(), syncing: false, error: null };
    console.log("Calls synced: " + months.map(m => m + "=" + (CALLS.byMonth[m] ? CALLS.byMonth[m].att : 0)).join(", "));
  } catch (e) {
    CALLS.syncing = false; CALLS.error = e.message;
    console.error("Calls sync failed: " + e.message);
  }
}

/* ---------- Leads-Today: IST time + list membership + checkpoint job ---------- */
function istParts(d){
  d = d || new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = {};
  fmt.formatToParts(d).forEach(function(p){ parts[p.type] = p.value; });
  // Intl with hour12:false reports midnight as hour 24, not 00. Every scheduler here
  // compares "HH:MM" as text, so "24:05" reads as later than any threshold and fires
  // things at midnight that were meant for the morning. Normalise it.
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return { date: parts.year + "-" + parts.month + "-" + parts.day, hm: hh + ":" + parts.minute };
}

async function fetchListMemberIds(listId){
  const ids = [];
  let after;
  do {
    const j = await hs("/crm/v3/lists/" + listId + "/memberships?limit=100" + (after ? "&after=" + after : ""));
    (j.results || []).forEach(function(r){ ids.push(String(r.recordId || r.id)); });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
  } while (after);
  return ids;
}

async function batchReadLeadsToday(ids){
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const inputs = ids.slice(i, i + 50).map(function(id){ return { id: id }; });
    try {
      const j = await hs("/crm/v3/objects/contacts/batch/read", { method: "POST", body: JSON.stringify({ properties: LT_PROPS, inputs: inputs }) });
      (j.results || []).forEach(function(r){ out.push(Object.assign({ id: r.id }, r.properties)); });
    } catch (e) { console.error("leads-today batch read @" + i + ": " + e.message); }
    await sleep(130);
  }
  return out;
}

async function runLeadsTodayCheckpoint(label){
  if (!TOKEN) { LEADS_TODAY.error = "HUBSPOT_TOKEN not set"; return; }
  if (LEADS_TODAY.syncing) return;
  LEADS_TODAY.syncing = true;
  try {
    const today = istParts().date;
    if (LEADS_TODAY.date !== today) {
      LEADS_TODAY = { date: today, byId: {}, ranToday: {}, loadedAt: null, syncing: true, error: null };
    }
    const listIds = await fetchListMemberIds(LEADS_TODAY_LIST_ID);
    const trackedIds = Object.keys(LEADS_TODAY.byId);
    const idSet = Array.from(new Set(listIds.concat(trackedIds)));
    const rows = await batchReadLeadsToday(idSet);
    const now = Date.now();
    rows.forEach(function(c){
      const stage = c.contact_engagement_stage || "";
      const fu = ts(c.follow_up_date_and_time);
      const lastCall = ts(c.last_call_date_and_time);
      const stageEnteredAt = ts(c.engagement_stage_last_changed_at);
      const clicked = String(c.llm_personalised_email_clicked).toLowerCase() === "true";
      const clickedAt = ts(c.personalised_email_link_clicked_date);
      let rec = LEADS_TODAY.byId[c.id];
      if (!rec) {
        rec = LEADS_TODAY.byId[c.id] = {
          id: c.id,
          name: ((c.firstname || "") + " " + (c.lastname || "")).trim() || ("Contact " + c.id),
          owner: c.hubspot_owner_id || "",
          creator: c.topmate_username || "",
          firstSeenAt: now,
          firstSeenLabel: label,
          baselineStage: stage,
          baselineFollowUp: fu
        };
      }
      rec.currentStage = stage;
      rec.lastCallAt = lastCall;
      rec.stageEnteredAt = stageEnteredAt;
      rec.emailClicked = rec.emailClicked || clicked;
      if (clickedAt && (!rec.emailClickedAt || clickedAt > rec.emailClickedAt)) rec.emailClickedAt = clickedAt;
      rec.lastCheckedAt = now;
      rec.lastCheckedLabel = label;
      if (rec.baselineFollowUp && rec.baselineFollowUp > now) rec.status = "excluded_future_followup";
      else if (rec.lastCallAt && rec.lastCallAt > rec.firstSeenAt) rec.status = "worked";
      else rec.status = "flagged";
    });
    LEADS_TODAY.ranToday[label] = now;
    LEADS_TODAY.loadedAt = new Date().toISOString();
    LEADS_TODAY.syncing = false;
    LEADS_TODAY.error = null;
    console.log("Leads-Today checkpoint [" + label + "]: " + listIds.length + " live list members, " + Object.keys(LEADS_TODAY.byId).length + " tracked today");
  } catch (e) {
    LEADS_TODAY.syncing = false;
    LEADS_TODAY.error = e.message;
    console.error("Leads-Today checkpoint failed: " + e.message);
  }
}

function maybeRunLeadsTodayCheckpoint(){
  const p = istParts();
  if (CHECKPOINT_TIMES.indexOf(p.hm) < 0) return;
  if (LEADS_TODAY.date === p.date && LEADS_TODAY.ranToday[p.hm]) return;
  runLeadsTodayCheckpoint(p.hm);
}

function mostRecentPassedCheckpoint(hm){
  // greatest CHECKPOINT_TIMES entry <= hm (both "HH:MM" strings, safe to compare lexically)
  let best = null;
  CHECKPOINT_TIMES.forEach(function(c){ if (c <= hm) best = c; });
  return best;
}

function bootstrapLeadsTodayOnBoot(){
  // Railway restarts (redeploys, crashes) wipe the in-memory tracker. Rather than
  // leaving today blank until the next scheduled checkpoint, immediately catch up
  // on whichever checkpoint should have already run today.
  const p = istParts();
  const cp = mostRecentPassedCheckpoint(p.hm);
  if (cp) runLeadsTodayCheckpoint(cp);
}

/* ---------- bucket refill: fetch + assign ---------- */
async function fetchBackupRange(from, to, sink){
  const filters = [
    { propertyName: "hubspot_owner_id", operator: "EQ", value: ABHISHEK_OWNER_ID },
    { propertyName: "backup_owner", operator: "HAS_PROPERTY" }
  ];
  if (from) filters.push({ propertyName: "createdate", operator: "GTE", value: String(from) });
  if (to) filters.push({ propertyName: "createdate", operator: "LT", value: String(to) });
  const probe = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters: filters }], properties: ["createdate"], limit: 1 }) });
  const total = probe.total || 0;
  if (total === 0) return { fetched: 0, total: 0, truncated: false };
  if (total > 9500 && from && to && (to - from) > 86400000) {
    const mid = Math.floor((from + to) / 2);
    await fetchBackupRange(from, mid, sink);
    await fetchBackupRange(mid, to, sink);
    return;
  }
  let after;
  do {
    const body = { filterGroups: [{ filters: filters }], properties: BACKUP_PROPS, sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], limit: 100, after: after };
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(function(r){ sink(Object.assign({ id: r.id }, r.properties)); });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
  } while (after);
}

async function syncBackupPool(){
  if (!TOKEN || BACKUP.syncing) return;
  BACKUP.syncing = true;
  try {
    const rows = [];
    await fetchBackupRange(Date.parse("2024-01-01"), Date.now() + 86400000, function(r){ rows.push(r); });
    BACKUP = { rows: rows, loadedAt: new Date().toISOString(), syncing: false, error: null };
    console.log("Backup pool synced: " + rows.length + " contacts parked with Abhishek Pal, tagged to a backup owner");
  } catch (e) {
    BACKUP.syncing = false; BACKUP.error = e.message;
    console.error("Backup pool sync failed: " + e.message);
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
function intlOf(c){ const v = String(c.international_number || "").toLowerCase(); return v === "true" || v === "yes"; }
function intlMatch(c, intl){ return !intl || (intl === "yes" ? intlOf(c) : !intlOf(c)); }
function sheetIntl(r){
  let p = String(r.consumer_phone || "").trim().replace(/[\s\-()]/g, "");
  if (!p) return false;
  if (p.startsWith("+")) return !p.startsWith("+91");
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return false;
  if (d.length === 11 && d[0] === "0") return false;
  if (d.length === 12 && d.startsWith("91")) return false;
  return d.length > 10;
}
function sheetIntlMatch(r, intl){ return !intl || (intl === "yes" ? sheetIntl(r) : !sheetIntl(r)); }
function srcOf(c){ return normSrc(c.actual_source); }
function srcMatch(c, src){ return !src || srcOf(c) === src; }
function sheetSrc(r){
  // source of the matched HubSpot contact via cohort identity maps
  const em = (r.consumer_email || "").toLowerCase(), ph = normPhone(r.consumer_phone);
  const rec = (em && COHORT.emails.get(em)) || (ph && COHORT.phones.get(ph)) || "";
  return rec ? rec.split("|")[1] : "";
}
function sheetSrcMatch(r, src){ return !src || sheetSrc(r) === src; }
function srcOptions(){
  const s = {};
  CACHE.contacts.forEach(c => { s[srcOf(c)] = 1; });
  return Object.keys(s).sort();
}
function sheetCreators(){
  const set = new Set();
  SHEET.rows.forEach(r => { if (r.creator_username) set.add(r.creator_username); });
  return set;
}
function filt(creator, agent, intl, src){
  return CACHE.contacts.filter(c =>
    (!creator || c.topmate_username === creator) &&
    (!agent || c.hubspot_owner_id === agent) &&
    intlMatch(c, intl) && srcMatch(c, src)
  );
}
function agentMetrics(rows){
  const now = Date.now(), d30 = now - 30 * 86400000, d90 = now - 90 * 86400000, w7 = now - 7 * 86400000;
  const per = {};
  rows.forEach(c => {
    const id = c.hubspot_owner_id;
    if (!per[id]) per[id] = { id, total:0, workable:0, churned:0, overdue:0, nofu:0, stale:0, churnEffort:0, freshRcb:0,
      ownCalls:0, totCalls:0, age30:0, age90:0, ni:0, niPost:0, dq:0, stu:0, pro:0, intl:0 };
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
    if (intlOf(c)) a.intl++;
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
const REQUIRED_ROUTES = ["/api/meta", "/api/agents", "/api/callnow", "/api/callnow/leads", "/api/vp", "/api/payment-analysis", "/api/me"];
app.get("/api/health", function(req, res){
  const have = [];
  (app._router && app._router.stack || []).forEach(function(l){
    if (l.route && l.route.path) have.push(l.route.path);
  });
  const missing = REQUIRED_ROUTES.filter(function(r){ return have.indexOf(r) < 0; });
  if (missing.length) return res.status(500).json({ ok: false, missing: missing });
  res.json({ ok: true, routes: have.length, uptimeSec: Math.round(process.uptime()),
    orgPersistent: typeof ORG_PERSISTENT === "undefined" ? null : ORG_PERSISTENT,
    orgTeams: (typeof ORG === "undefined" || !ORG.teams) ? 0 : ORG.teams.length,
    dataDir: typeof DATA_DIR === "undefined" ? null : DATA_DIR,
    // Counts only, no names. Enough to tell from outside why the v2 list is or is not
    // ready, which beats guessing at it through a browser that can only say "loading".
    cn2: (function(){
      try {
        return { ready: cn2Ready(), building: CN2_POOL.building, size: CN2_POOL.rows.length,
          builtAt: CN2_POOL.at, buildMs: CN2_POOL.ms, lastError: CN2_POOL.lastError || null,
          src: { cache: !!CACHE.loadedAt, pfresh: !!PFRESH.loadedAt, unowned: !!UNOWNED.loadedAt,
                 forms: !!FORMS.loadedAt, poolSize: (CACHE.contacts || []).length,
                 trackedCreators: PFRESH_LIST.length },
          delta: (typeof DELTA === "undefined") ? null : { at: DELTA.at, running: !!DELTA.running,
            lastCount: DELTA.lastCount, lastMs: DELTA.lastMs, error: DELTA.error || null,
            disabled: !!DELTA.disabled, everyMinutes: DELTA_MINUTES },
          sync: { running: !!CACHE.syncing, error: CACHE.error || null,
                  agents: SYNC_PROGRESS.owners, agentsDone: SYNC_PROGRESS.done,
                  leadsSoFar: SYNC_PROGRESS.contacts, phase: SYNC_PROGRESS.phase,
                  startedAt: SYNC_PROGRESS.startedAt, partial: CACHE.partial || null } };
      } catch (e) { return { error: (e && e.message) || String(e) }; }
    })(),
    // Whether tomorrow's morning review will have anything to show. Dates and counts
    // only, no lead data, so this stays safe on an endpoint with no login.
    last500: LAST_500,
    daily: (function(){
      try {
        const all = (typeof ORG !== "undefined" && ORG.daily) || {};
        const dates = Object.keys(all).sort();
        const today = istParts(new Date()).date;
        const t = all[today] || null;
        return { days: dates.length, first: dates[0] || null, latest: dates[dates.length - 1] || null,
          today: t ? { capturedAt: t.at, lockedAt: t.openAt || null, pool: t.oPool == null ? t.pool : t.oPool,
            called: t.calls, teams: Object.keys(t.teams || {}).length,
            agents: Object.keys(t.agents || {}).length } : null };
      } catch (e) { return { error: (e && e.message) || String(e) }; }
    })() });
});

app.get("/api/meta", (req, res) => res.json({ loadedAt: CACHE.loadedAt, syncing: CACHE.syncing, error: CACHE.error,
  contacts: CACHE.contacts.length, portalId: PORTAL_ID, uiDomain: UI_DOMAIN,
  sheetLoadedAt: SHEET.loadedAt, sheetRows: SHEET.rows.length, sheetError: SHEET.error,
  cohortLoadedAt: COHORT.loadedAt, cohortContacts: COHORT.emails.size, cohortSyncing: COHORT.syncing, cohortError: COHORT.error,
  counselLoadedAt: COUNSEL.loadedAt, counselled: Object.keys(COUNSEL.byId).length, counselSyncing: COUNSEL.syncing, counselError: COUNSEL.error,
  leadsTodayDate: LEADS_TODAY.date, leadsTodayLoadedAt: LEADS_TODAY.loadedAt, leadsTodayCount: Object.keys(LEADS_TODAY.byId).length, leadsTodayError: LEADS_TODAY.error,
  backupPoolLoadedAt: BACKUP.loadedAt, backupPoolCount: BACKUP.rows.length, backupPoolSyncing: BACKUP.syncing, backupPoolError: BACKUP.error,
  deltaAt: DELTA.at, deltaSince: DELTA.since, deltaCount: DELTA.lastCount, deltaMs: DELTA.lastMs, deltaError: DELTA.error, deltaOff: DELTA.disabled,
  formsLoadedAt: FORMS.loadedAt, formsEmails: FORMS.byEmail.size, formsSource: FORMS.source, formsSyncing: FORMS.syncing, formsError: FORMS.error,
  unownedLoadedAt: UNOWNED.loadedAt, unownedCount: UNOWNED.rows.length, unownedSyncing: UNOWNED.syncing, unownedError: UNOWNED.error,
  pfreshLoadedAt: PFRESH.loadedAt, pfreshCount: PFRESH.rows.length, pfreshByCreator: PFRESH.byCreator, pfreshSyncing: PFRESH.syncing, pfreshError: PFRESH.error }));

app.get("/api/enrolments", (req, res) => {
  const creator = req.query.creator || "";
  const month = req.query.month || "";
  const agentId = req.query.agent || "";
  let agentEmail = (req.query.agentEmail || "").toLowerCase();
  if (!agentEmail && agentId && CACHE.owners[agentId]) agentEmail = (CACHE.owners[agentId].email || "").toLowerCase();
  const fIntlE = req.query.intl || "";
  const fSrcE = req.query.src || "";
  const rows = SHEET.rows.filter(r =>
    (!creator || (r.creator_username || "") === creator) &&
    (!agentEmail || (r.owner_email || "").toLowerCase() === agentEmail) &&
    (!month || (r.date || "").slice(0, 7) === month) &&
    sheetIntlMatch(r, fIntlE) &&
    sheetSrcMatch(r, fSrcE)
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
      creators: Object.entries(optCreators).sort((a, b) => b[1] - a[1]).map(([u, n]) => ({ u, n })),
      sources: Array.from(new Set(SHEET.rows.map(sheetSrc).filter(Boolean))).sort()
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
  sync(); syncSheet(); syncCounsel();
  res.json({ ok: true, syncing: true });
});

app.get("/api/agents", (req, res) => {
  const fc = req.query.creator || "";
  const fIntl = req.query.intl || "";
  const fSrc = req.query.src || "";
  const rows = filt(fc, null, fIntl, fSrc);
  const creators = {};
  CACHE.contacts.forEach(c => { const u = c.topmate_username; if (u) creators[u] = (creators[u] || 0) + 1; });
  const agents = agentMetrics(rows).map(a => {
    a.freshNoStage = ((CACHE.fresh || {})[a.id] || []).filter(f => (!fc || (f.topmate_username || "") === fc) && intlMatch(f, fIntl) && srcMatch(f, fSrc)).length;
    return a;
  });
  res.json({ loadedAt: CACHE.loadedAt, error: CACHE.error,
    agents: agents,
    sources: srcOptions(),
    creators: (function(){
      const sc = sheetCreators();
      let list = Object.entries(creators).map(([u, n]) => ({ u, n }));
      if (sc.size) list = list.filter(x => sc.has(x.u));
      return list.sort((a, b) => b.n - a.n).slice(0, 300);
    })() });
});

app.get("/api/drill/:id", (req, res) => {
  const rows = filt(req.query.creator, req.params.id, req.query.intl, req.query.src);
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
  // fresh (no stage, this month) per creator for this agent
  ((CACHE.fresh || {})[req.params.id] || []).forEach(f => {
    const u = f.topmate_username || "(no creator)";
    if (req.query.creator && u !== req.query.creator) return;
    if (!intlMatch(f, req.query.intl)) return;
    if (!srcMatch(f, req.query.src)) return;
    if (!creators[u]) creators[u] = { u, t: 0, w: 0, c: 0, rcb: 0, dnp: 0, ni: 0, dq: 0, couns: 0, ifc: 0, won: 0 };
    creators[u].fresh = (creators[u].fresh || 0) + 1;
  });
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
  const rows = filt(req.query.creator, req.query.owner, req.query.intl, req.query.src)
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
      fu: ts(c.follow_up_date_and_time),
      intl: intlOf(c),
      src: srcOf(c)
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
    const key = (r.creator_username || "") + "|" + (em || ph || (r.consumer_name || "").trim().toLowerCase() || ("row" + r._row));
    const isEnrol = !seen.has(key); seen.add(key);
    return { pym, cym, price: r.price, creator: r.creator_username || "(none)", agent: r.sales_rep || r.owner_email || "(none)",
      src: rec ? src : "Not in HubSpot", seg: rec ? seg : "Unknown", cls, isEnrol,
      loan: (function(){
        const bt = String(r.booking_type || "").toLowerCase(), st2 = String(r.status || "").toLowerCase();
        return bt.indexOf("loan") >= 0 || st2.indexOf("loan") >= 0;
      })(),
      btype: String(r.booking_type || "").trim() || String(r.status || "").trim() || "(blank)" };
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

  // cohort matrix: rows = contact create month, cols = first-payment month (+ balance payments)
  const payMonths = Object.keys(byMonth).sort();
  const cohortEnrol = {}, cohortBal = {}; // cym -> pym -> n
  pays.forEach(p => {
    if (!p.cym) return;
    const tgt = p.isEnrol ? cohortEnrol : cohortBal;
    if (!tgt[p.cym]) tgt[p.cym] = { _n: 0 };
    tgt[p.cym][p.pym] = (tgt[p.cym][p.pym] || 0) + 1;
    tgt[p.cym]._n++;
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
  // loan vs direct bifurcation, from the sales sheet only (booking_type / status contains "loan")
  const mSel2 = req.query.month || "";
  const loanSplit = { byMonth: {}, byCreator: {}, byAgent: {}, types: {} };
  function lacc(m, k, p){
    if (!m[k]) m[k] = { k, ln: 0, lr: 0, dn: 0, dr: 0, lEnrol: 0, dEnrol: 0 };
    const o = m[k];
    if (p.loan) { o.ln++; o.lr += p.price; if (p.isEnrol) o.lEnrol++; }
    else { o.dn++; o.dr += p.price; if (p.isEnrol) o.dEnrol++; }
  }
  pays.forEach(p => {
    lacc(loanSplit.byMonth, p.pym, p);
    if (!mSel2 || p.pym === mSel2) {
      lacc(loanSplit.byCreator, p.creator, p);
      lacc(loanSplit.byAgent, p.agent, p);
      if (!loanSplit.types[p.btype]) loanSplit.types[p.btype] = { t: p.btype, n: 0, rev: 0 };
      loanSplit.types[p.btype].n++; loanSplit.types[p.btype].rev += p.price;
    }
  });
  const loanOut = {
    byMonth: Object.values(loanSplit.byMonth).sort((a, b) => (a.k < b.k ? -1 : 1)),
    byCreator: Object.values(loanSplit.byCreator).sort((a, b) => (b.lr + b.dr) - (a.lr + a.dr)),
    byAgent: Object.values(loanSplit.byAgent).sort((a, b) => (b.lr + b.dr) - (a.lr + a.dr)),
    types: Object.values(loanSplit.types).sort((a, b) => b.rev - a.rev)
  };

  const cohortMonths = Array.from(new Set(Object.keys(hsByYm).concat(Object.keys(cohortEnrol)).concat(Object.keys(cohortBal)))).sort();
  const cohort = cohortMonths.map(cym => {
    const row = { cym, hs: hsByYm[cym] || 0,
      enrol: (cohortEnrol[cym] && cohortEnrol[cym]._n) || 0,
      bal: (cohortBal[cym] && cohortBal[cym]._n) || 0, cols: {}, balCols: {} };
    payMonths.forEach(pm => {
      row.cols[pm] = (cohortEnrol[cym] && cohortEnrol[cym][pm]) || 0;
      row.balCols[pm] = (cohortBal[cym] && cohortBal[cym][pm]) || 0;
    });
    row.conv = row.hs ? +(100 * row.enrol / row.hs).toFixed(2) : null;
    return row;
  });
  const notMatched = pays.filter(p => !p.cym).length;

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
    cohort, payMonths, notMatched, loanSplit: loanOut
  });
});

app.get("/api/conversion", (req, res) => {
  const fCreator = req.query.creator || "", fAgent = req.query.agent || "", fMonth = req.query.cmonth || "";
  const fSegment = req.query.segment || "", fCreate = req.query.createMonth || "", fPay = req.query.pmonth || "";
  const fIntl = req.query.intl || "";
  const fSrc = req.query.src || "";
  // unfiltered option lists for the UI
  const optM = {}, optA = {}, optC = {}, optCr = {};
  CACHE.contacts.forEach(c => {
    const ts = COUNSEL.byId[c.id];
    if (!ts) return;
    const m = ymOf(ts); if (m) optM[m] = 1;
    const crm = ymOf(c.createdate); if (crm) optCr[crm] = 1;
    optA[c.hubspot_owner_id] = 1;
    optC[c.topmate_username || "(no creator)"] = 1;
  });
  const optP = {};
  SHEET.rows.forEach(r => { const m = (r.date || "").slice(0, 7); if (m) optP[m] = 1; });
  const options = {
    months: Object.keys(optM).sort().reverse(),
    createMonths: Object.keys(optCr).sort().reverse(),
    payMonths: Object.keys(optP).sort().reverse(),
    segments: ["Student", "Professional", "Unknown"],
    agents: Object.keys(optA).map(id => ({ id, name: (CACHE.owners[id] || {}).name || ("Owner " + id) })).sort((a, b) => a.name.localeCompare(b.name)),
    creators: (function(){
      const sc = sheetCreators();
      let list = Object.keys(optC);
      if (sc.size) list = list.filter(u => sc.has(u));
      return list.sort();
    })(),
    sources: srcOptions()
  };
  // enrolment identity sets from the payment tracker (first payment per consumer per creator)
  const seen = new Set(), eEmailDate = {}, ePhoneDate = {};
  SHEET.rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(r => {
    const em = (r.consumer_email || "").toLowerCase(), ph = normPhone(r.consumer_phone);
    const key = (r.creator_username || "") + "|" + (em || ph || (r.consumer_name || "").trim().toLowerCase() || ("row" + r._row));
    if (seen.has(key)) return;
    seen.add(key);
    if (em && !eEmailDate[em]) eEmailDate[em] = r.date;
    if (ph && !ePhoneDate[ph]) ePhoneDate[ph] = r.date;
  });
  const byAgent = {}, byCreator = {}, byMonth = {}, bySegment = {}, bySource = {}, byCreateMonth = {};
  const enrolMonthsSet = {};
  let tot = 0, conv = 0;
  CACHE.contacts.forEach(c => {
    const ts = COUNSEL.byId[c.id];
    if (!ts) return;
    if (fCreator && (c.topmate_username || "") !== fCreator) return;
    if (fAgent && c.hubspot_owner_id !== fAgent) return;
    if (fMonth && ymOf(ts) !== fMonth) return;
    if (!intlMatch(c, fIntl)) return;
    if (!srcMatch(c, fSrc)) return;
    const seg = segOf(c.tm_student_or_professional);
    if (fSegment && seg !== fSegment) return;
    const crm = ymOf(c.createdate) || "(unknown)";
    if (fCreate && crm !== fCreate) return;
    const em = (c.email || "").toLowerCase(), ph = normPhone(c.phone);
    const eDate = (em && eEmailDate[em]) || (ph && ePhoneDate[ph]) || "";
    let eMonth = eDate ? eDate.slice(0, 7) : "";
    let converted = !!eDate;
    if (fPay && eMonth !== fPay) { converted = false; eMonth = ""; }
    if (eMonth) enrolMonthsSet[eMonth] = 1;
    tot++; if (converted) conv++;
    const add = (m, k) => { if (!m[k]) m[k] = { counselled: 0, converted: 0, cols: {} }; m[k].counselled++; if (converted) { m[k].converted++; m[k].cols[eMonth] = (m[k].cols[eMonth] || 0) + 1; } };
    add(byAgent, c.hubspot_owner_id);
    add(byCreator, c.topmate_username || "(no creator)");
    add(byMonth, ymOf(ts) || "(unknown)");
    add(bySegment, seg);
    add(bySource, srcOf(c));
    add(byCreateMonth, crm);
  });
  const enrolMonths = Object.keys(enrolMonthsSet).sort();
  // L2E: lead -> enrolment over ALL owned staged leads in scope (counselled-month filter does not apply)
  const l2e = { byAgent: {}, byCreator: {}, bySegment: {}, bySource: {}, byCreateMonth: {}, tot: 0, conv: 0 };
  CACHE.contacts.forEach(c => {
    if (fCreator && (c.topmate_username || "") !== fCreator) return;
    if (fAgent && c.hubspot_owner_id !== fAgent) return;
    if (!intlMatch(c, fIntl)) return;
    if (!srcMatch(c, fSrc)) return;
    const seg = segOf(c.tm_student_or_professional);
    if (fSegment && seg !== fSegment) return;
    const crm = ymOf(c.createdate) || "(unknown)";
    if (fCreate && crm !== fCreate) return;
    const em = (c.email || "").toLowerCase(), ph = normPhone(c.phone);
    const eDate = (em && eEmailDate[em]) || (ph && ePhoneDate[ph]) || "";
    let converted = !!eDate;
    if (fPay && (eDate ? eDate.slice(0, 7) : "") !== fPay) converted = false;
    l2e.tot++; if (converted) l2e.conv++;
    const bump = (m, k) => { if (!m[k]) m[k] = { n: 0, c: 0 }; m[k].n++; if (converted) m[k].c++; };
    bump(l2e.byAgent, c.hubspot_owner_id);
    bump(l2e.byCreator, c.topmate_username || "(no creator)");
    bump(l2e.bySegment, seg);
    bump(l2e.bySource, srcOf(c));
    bump(l2e.byCreateMonth, crm);
  });
  // day-by-day conversion view: enrolments per payment day with lead create + counselling lags
  const contactBy = new Map();
  CACHE.contacts.forEach(c => {
    if (fCreator && (c.topmate_username || "") !== fCreator) return;
    if (fAgent && c.hubspot_owner_id !== fAgent) return;
    if (!intlMatch(c, fIntl)) return;
    if (fSegment && segOf(c.tm_student_or_professional) !== fSegment) return;
    if (!srcMatch(c, fSrc)) return;
    const crm = ymOf(c.createdate) || "(unknown)";
    if (fCreate && crm !== fCreate) return;
    const kts = COUNSEL.byId[c.id] || 0;
    if (fMonth && ymOf(kts) !== fMonth) return;
    const rec = { created: ts(c.createdate), couns: kts };
    const em2 = (c.email || "").toLowerCase(); if (em2 && !contactBy.has(em2)) contactBy.set(em2, rec);
    const ph2 = normPhone(c.phone); if (ph2 && !contactBy.has(ph2)) contactBy.set(ph2, rec);
  });
  const anyContactFilter = !!(fCreator || fAgent || fSegment || fCreate || fMonth || fIntl || fSrc);
  const dayMap = {}, seenD = new Set();
  SHEET.rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(r => {
    const em2 = (r.consumer_email || "").toLowerCase(), ph2 = normPhone(r.consumer_phone);
    const key = (r.creator_username || "") + "|" + (em2 || ph2 || (r.consumer_name || "").trim().toLowerCase() || ("row" + r._row));
    const isEnrolD = !seenD.has(key);
    seenD.add(key);
    const d = (r.date || "").slice(0, 10);
    if (!d) return;
    if (fPay && d.slice(0, 7) !== fPay) return;
    const m = (em2 && contactBy.get(em2)) || (ph2 && contactBy.get(ph2)) || null;
    if (anyContactFilter && !m) return;
    if (!dayMap[d]) dayMap[d] = { d, n: 0, rev: 0, balN: 0, balRev: 0, matched: 0, lagCSum: 0, lagCN: 0, lagKSum: 0, lagKN: 0, items: [] };
    const dm = dayMap[d];
    const payTs = Date.parse(d);
    let lagC = null, lagK = null;
    if (m) {
      if (m.created) lagC = Math.max(0, Math.round((payTs - m.created) / 86400000));
      if (m.couns) lagK = Math.max(0, Math.round((payTs - m.couns) / 86400000));
    }
    if (!isEnrolD) {
      // balance payment: counted so the day total ties to the sales sheet, but kept out of enrolment metrics
      dm.balN++; dm.balRev += r.price;
      if (dm.items.length < 25) dm.items.push({ name: r.consumer_name || "", creator: r.creator_username || "", agent: r.sales_rep || "", price: r.price,
        created: m && m.created ? new Date(m.created).toISOString().slice(0, 10) : "", couns: m && m.couns ? new Date(m.couns).toISOString().slice(0, 10) : "",
        lagC, lagK, bal: 1 });
      return;
    }
    dm.n++; dm.rev += r.price;
    if (m) {
      dm.matched++;
      if (lagC !== null) { dm.lagCSum += lagC; dm.lagCN++; }
      if (lagK !== null) { dm.lagKSum += lagK; dm.lagKN++; }
    }
    if (dm.items.length < 25) dm.items.push({ name: r.consumer_name || "", creator: r.creator_username || "", agent: r.sales_rep || "", price: r.price,
      created: m && m.created ? new Date(m.created).toISOString().slice(0, 10) : "", couns: m && m.couns ? new Date(m.couns).toISOString().slice(0, 10) : "",
      lagC, lagK });
  });
  const days = Object.values(dayMap).sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 62).map(x => ({
    d: x.d, n: x.n, rev: x.rev, balN: x.balN, balRev: x.balRev, total: x.rev + x.balRev, totalN: x.n + x.balN, matched: x.matched,
    avgLagC: x.lagCN ? Math.round(x.lagCSum / x.lagCN) : null,
    avgLagK: x.lagKN ? Math.round(x.lagKSum / x.lagKN) : null,
    items: x.items
  }));

  const out = (m, keyName, labelFn, l2eMap) => Object.entries(m).map(([k, v]) => {
    const o = { counselled: v.counselled, converted: v.converted, conv: v.counselled ? +(100 * v.converted / v.counselled).toFixed(1) : 0, cols: v.cols };
    o[keyName] = k; o.label = labelFn ? labelFn(k) : k;
    if (l2eMap) {
      const x = l2eMap[k] || { n: 0, c: 0 };
      o.leads = x.n; o.l2eConv = x.c; o.l2e = x.n ? +(100 * x.c / x.n).toFixed(2) : 0;
    }
    return o;
  }).sort((a, b) => b.counselled - a.counselled);
  res.json({
    loadedAt: COUNSEL.loadedAt, syncing: COUNSEL.syncing, error: COUNSEL.error,
    totals: { counselled: tot, converted: conv, conv: tot ? +(100 * conv / tot).toFixed(1) : 0,
      leads: l2e.tot, l2eConv: l2e.conv, l2e: l2e.tot ? +(100 * l2e.conv / l2e.tot).toFixed(2) : 0 },
    enrolMonths, options, days,
    byAgent: out(byAgent, "id", id => (CACHE.owners[id] || {}).name || ("Owner " + id), l2e.byAgent),
    byCreator: out(byCreator, "creator", null, l2e.byCreator),
    bySegment: out(bySegment, "segment", null, l2e.bySegment),
    bySource: out(bySource, "source", null, l2e.bySource),
    byCreateMonth: out(byCreateMonth, "month", null, l2e.byCreateMonth).sort((a, b) => (a.month < b.month ? -1 : 1)),
    byMonth: out(byMonth, "month").sort((a, b) => (a.month < b.month ? -1 : 1))
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

app.get("/api/agent/:id", (req, res) => {
  const id = req.params.id;
  const fCreator = req.query.creator || "";
  const fIntl = req.query.intl || "";
  const fSrc = req.query.src || "";
  const o = CACHE.owners[id] || {};
  const email = (o.email || "").toLowerCase();
  const now = Date.now(), month = new Date().toISOString().slice(0, 7), w7 = now - 7 * 86400000, d30 = now - 30 * 86400000;
  const mineAll = CACHE.contacts.filter(c => c.hubspot_owner_id === id);
  const crCounts = {};
  mineAll.forEach(c => { const u = c.topmate_username || "(no creator)"; crCounts[u] = (crCounts[u] || 0) + 1; });
  const creatorOptions = Object.entries(crCounts).map(([u, n]) => ({ u, n })).sort((a, b) => b.n - a.n);
  const mine = mineAll.filter(c => (!fCreator || (c.topmate_username || "(no creator)") === fCreator) && intlMatch(c, fIntl) && srcMatch(c, fSrc));
  const allAgents = agentMetrics(CACHE.contacts);
  const me = agentMetrics(mine).filter(a => a.id === id)[0] || { id, total: 0, workable: 0, churned: 0, overdue: 0, nofu: 0, stale: 0, churnEffort: 0, freshRcb: 0, age30: 0, age90: 0, old90: 0, ni: 0, niPost: 0, niPre: 0, ownCalls: 0, totCalls: 0, stu: 0, pro: 0 };
  // revenue from payment tracker
  const pays = SHEET.rows.filter(r => (r.owner_email || "").toLowerCase() === email && email &&
    (!fCreator || (r.creator_username || "(no creator)") === fCreator) && sheetIntlMatch(r, fIntl) && sheetSrcMatch(r, fSrc));
  const revenue = {
    total: pays.reduce((t, r) => t + r.price, 0),
    payments: pays.length,
    month: pays.filter(r => (r.date || "").slice(0, 7) === month).reduce((t, r) => t + r.price, 0),
    monthPayments: pays.filter(r => (r.date || "").slice(0, 7) === month).length,
    recent: pays.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6).map(r => ({ date: r.date, consumer: r.consumer_name, creator: r.creator_username, service: (r.service_title || "").slice(0, 50), price: r.price, status: r.status }))
  };
  // conversion (counselling -> enrolment) for this agent + all for rank
  const seen = new Set(), eEmails = new Set(), ePhones = new Set();
  SHEET.rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(r => {
    const em = (r.consumer_email || "").toLowerCase(), ph = normPhone(r.consumer_phone);
    const key = (r.creator_username || "") + "|" + (em || ph || (r.consumer_name || "").trim().toLowerCase() || ("row" + r._row));
    if (seen.has(key)) return;
    seen.add(key);
    if (em) eEmails.add(em);
    if (ph) ePhones.add(ph);
  });
  const convByAgent = {};
  CACHE.contacts.forEach(c => {
    if (!COUNSEL.byId[c.id]) return;
    const k = c.hubspot_owner_id;
    if (!convByAgent[k]) convByAgent[k] = { counselled: 0, converted: 0 };
    convByAgent[k].counselled++;
    const em = (c.email || "").toLowerCase(), ph = normPhone(c.phone);
    if ((em && eEmails.has(em)) || (ph && ePhones.has(ph))) convByAgent[k].converted++;
  });
  const myConv = { counselled: 0, converted: 0 };
  mine.forEach(c => {
    if (!COUNSEL.byId[c.id]) return;
    myConv.counselled++;
    const em2 = (c.email || "").toLowerCase(), ph2 = normPhone(c.phone);
    if ((em2 && eEmails.has(em2)) || (ph2 && ePhones.has(ph2))) myConv.converted++;
  });
  myConv.conv = myConv.counselled ? +(100 * myConv.converted / myConv.counselled).toFixed(1) : null;
  // ranks among agents with >=30 staged leads
  const revByEmail = {};
  SHEET.rows.forEach(r => {
    const em = (r.owner_email || "").toLowerCase();
    if (!em) return;
    if ((r.date || "").slice(0, 7) === month) revByEmail[em] = (revByEmail[em] || 0) + r.price;
  });
  const eligible = allAgents.filter(a => a.total >= 30 && a.active !== false);
  function rankOf(list, val){ return list.filter(x => x > val).length + 1; }
  const ranks = {
    peers: eligible.length,
    revenue: rankOf(eligible.map(a => revByEmail[(a.email || "").toLowerCase()] || 0), revByEmail[email] || 0),
    workable: rankOf(eligible.map(a => a.workable), me.workable),
    conversion: myConv.conv === null ? null : rankOf(eligible.map(a => { const cx = convByAgent[a.id]; return cx && cx.counselled >= 10 ? 100 * cx.converted / cx.counselled : -1; }), myConv.conv)
  };
  // stage aggregates + creator cells
  const stageAgg = {}, creators = {};
  mine.forEach(c => {
    const st = c.contact_engagement_stage;
    if (!stageAgg[st]) stageAgg[st] = { n: 0, calls: 0, own: 0, tsSum: 0, tsN: 0 };
    const sa = stageAgg[st];
    sa.n++; sa.calls += num(c.callscurrent_stage); sa.own += num(c.call_in_current_stage_by_current_owner);
    const ent = ts(c.engagement_stage_last_changed_at) || ts(c.createdate);
    if (ent) { sa.tsSum += ent; sa.tsN++; }
    const u = c.topmate_username || "(no creator)";
    if (!creators[u]) creators[u] = { u, total: 0, work: 0, churn: 0, fresh: 0, overdue: 0, nofu: 0, rcbun: 0, own: 0, tot: 0 };
    const k = creators[u], isW = WORKABLE.indexOf(st) >= 0;
    k.total++; k.own += num(c.call_in_current_stage_by_current_owner); k.tot += num(c.callscurrent_stage);
    if (isW) {
      k.work++;
      const fu = ts(c.follow_up_date_and_time);
      if (!fu) k.nofu++; else if (fu < now) k.overdue++;
    }
    if (CHURN.indexOf(st) >= 0) k.churn++;
    if (st === "rcb_requested_callback" && !ts(c.last_call_date_and_time)) k.rcbun++;
    if (ts(c.createdate) > d30) k.fresh++;
  });
  Object.values(stageAgg).forEach(sa => {
    sa.days = sa.tsN ? Math.max(1, (now - sa.tsSum / sa.tsN) / 86400000) : 0;
    delete sa.tsSum; delete sa.tsN;
  });
  // action queues
  const lead = c => ({ id: c.id, name: (((c.firstname || "") + " " + (c.lastname || "")).trim()) || "(no name)", creator: c.topmate_username || "",
    stage: c.contact_engagement_stage, days: Math.max(1, Math.round((now - (ts(c.engagement_stage_last_changed_at) || ts(c.createdate))) / 86400000)),
    fu: ts(c.follow_up_date_and_time) || 0, last: ts(c.last_call_date_and_time) || 0, calls: num(c.callscurrent_stage) });
  const isWork = c => WORKABLE.indexOf(c.contact_engagement_stage) >= 0;
  const freshMine = ((CACHE.fresh || {})[id] || []).filter(f => (!fCreator || ((f.topmate_username || "(no creator)") === fCreator)) && intlMatch(f, fIntl) && srcMatch(f, fSrc));
  me.freshNoStage = freshMine.length;
  const queues = {
    fresh: freshMine.slice(0, 15).map(f => ({ id: f.id, name: (((f.firstname || "") + " " + (f.lastname || "")).trim()) || "(no name)",
      creator: f.topmate_username || "", stage: "", days: Math.max(1, Math.round((now - ts(f.createdate)) / 86400000)), fu: 0, last: 0, calls: 0 })),
    rcb: mine.filter(c => c.contact_engagement_stage === "rcb_requested_callback" && !ts(c.last_call_date_and_time)).map(lead).sort((a, b) => b.days - a.days).slice(0, 15),
    overdue: mine.filter(c => isWork(c) && ts(c.follow_up_date_and_time) && ts(c.follow_up_date_and_time) < now).map(lead).sort((a, b) => a.fu - b.fu).slice(0, 15),
    nofu: mine.filter(c => isWork(c) && !ts(c.follow_up_date_and_time)).map(lead).sort((a, b) => b.days - a.days).slice(0, 15),
    hot: mine.filter(c => ["payment_prospect", "pricing_pitched", "program_pitched"].indexOf(c.contact_engagement_stage) >= 0).map(lead).sort((a, b) => b.days - a.days).slice(0, 15)
  };
  // activity: counsellings / new leads / payments over time windows
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const d0 = dayStart.getTime(), wk = now - 7 * 86400000, mo0 = Date.parse(month + "-01");
  const todayStr = new Date().toISOString().slice(0, 10), wkStr = new Date(wk).toISOString().slice(0, 10);
  const activity = { counsel: { today: 0, week: 0, month: 0, total: 0 }, newLeads: { today: 0, week: 0 },
    payments: { today: 0, week: 0, todayRev: 0, weekRev: 0 } };
  mine.forEach(c => {
    const cts = COUNSEL.byId[c.id];
    if (cts) {
      activity.counsel.total++;
      if (cts >= mo0) activity.counsel.month++;
      if (cts >= wk) activity.counsel.week++;
      if (cts >= d0) activity.counsel.today++;
    }
    const cr = ts(c.createdate);
    if (cr >= d0) activity.newLeads.today++;
    if (cr >= wk) activity.newLeads.week++;
  });
  pays.forEach(r => {
    const d = (r.date || "").slice(0, 10);
    if (d === todayStr) { activity.payments.today++; activity.payments.todayRev += r.price; }
    if (d >= wkStr) { activity.payments.week++; activity.payments.weekRev += r.price; }
  });
  res.json({
    loadedAt: CACHE.loadedAt, sheetLoadedAt: SHEET.loadedAt, counselLoadedAt: COUNSEL.loadedAt,
    agent: { id, name: o.name || ("Owner " + id), email: o.email || "", active: o.active !== false },
    creatorOptions, sourceOptions: srcOptions(), filterCreator: fCreator, filterSrc: fSrc, activity,
    metrics: me, revenue, conversion: myConv, ranks, stageAgg,
    creators: Object.values(creators).sort((a, b) => b.total - a.total),
    queues, month,
    portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID }
  });
});

app.get("/api/summary", (req, res) => {
  const rows = filt(req.query.creator, req.query.agent, req.query.intl, req.query.src);
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
  // fresh no-stage leads per owner x creator
  Object.keys(CACHE.fresh || {}).forEach(oid => {
    if (req.query.agent && oid !== req.query.agent) return;
    (CACHE.fresh[oid] || []).forEach(f => {
      const cr = f.topmate_username || "(no creator)";
      if (req.query.creator && cr !== req.query.creator) return;
      if (!intlMatch(f, req.query.intl)) return;
      if (!srcMatch(f, req.query.src)) return;
      const key = oid + "|" + cr;
      if (!cells[key]) cells[key] = { owner: oid, cred: cr, total: 0, work: 0, churn: 0, fresh: 0, overdue: 0, nofu: 0, rcbun: 0, own: 0, tot: 0 };
      cells[key].freshNS = (cells[key].freshNS || 0) + 1;
    });
  });
  res.json({ cells: Object.values(cells) });
});

app.get("/api/leads-today", (req, res) => {
  const rows = Object.values(LEADS_TODAY.byId);
  const leads = rows.map(function(r){
    return {
      id: r.id, name: r.name, creator: r.creator,
      owner: r.owner, ownerName: (CACHE.owners[r.owner] && CACHE.owners[r.owner].name) || r.owner || "(unassigned)",
      ownerEmail: (CACHE.owners[r.owner] && CACHE.owners[r.owner].email) || "",
      firstSeenAt: r.firstSeenAt, firstSeenLabel: r.firstSeenLabel,
      baselineStage: r.baselineStage, currentStage: r.currentStage,
      baselineFollowUp: r.baselineFollowUp, lastCallAt: r.lastCallAt,
      status: r.status, emailClicked: r.emailClicked, emailClickedAt: r.emailClickedAt,
      emailOk: r.emailClicked ? (CLOSED_STAGES.indexOf(r.currentStage) >= 0 && r.stageEnteredAt > r.emailClickedAt) : null
    };
  });
  const summary = {
    total: leads.length,
    worked: leads.filter(function(l){ return l.status === "worked"; }).length,
    flagged: leads.filter(function(l){ return l.status === "flagged"; }).length,
    excluded: leads.filter(function(l){ return l.status === "excluded_future_followup"; }).length
  };
  const moves = {};
  leads.forEach(function(l){
    const key = (l.baselineStage || "(fresh/blank)") + "|" + (l.currentStage || "(fresh/blank)");
    moves[key] = (moves[key] || 0) + 1;
  });
  const movement = Object.entries(moves).map(function(e){
    const k = e[0], n = e[1], parts = k.split("|");
    return { from: parts[0], to: parts[1], count: n, changed: parts[0] !== parts[1] };
  }).sort(function(a, b){ return b.count - a.count; });
  const clicked = leads.filter(function(l){ return l.emailClicked; });
  const emailClicks = {
    total: clicked.length,
    flagged: clicked.filter(function(l){ return !l.emailOk; }).length,
    rows: clicked.map(function(l){ return { id: l.id, name: l.name, creator: l.creator, ownerName: l.ownerName, currentStage: l.currentStage, emailClickedAt: l.emailClickedAt, ok: l.emailOk }; })
  };
  res.json({
    date: LEADS_TODAY.date, loadedAt: LEADS_TODAY.loadedAt, syncing: LEADS_TODAY.syncing, error: LEADS_TODAY.error,
    checkpoints: CHECKPOINT_TIMES, ranToday: LEADS_TODAY.ranToday,
    summary: summary, movement: movement, leads: leads, emailClicks: emailClicks,
    portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID }
  });
});

app.post("/api/leads-today/checkpoint", (req, res) => {
  if (REFRESH_KEY && req.query.key !== REFRESH_KEY) return res.status(403).json({ ok: false, error: "bad key" });
  const label = req.query.label || istParts().hm;
  runLeadsTodayCheckpoint(label);
  res.json({ ok: true, label: label });
});

app.get("/api/leads-today/checkpoint", (req, res) => {
  if (REFRESH_KEY && req.query.key !== REFRESH_KEY) return res.status(403).json({ ok: false, error: "bad key" });
  const label = req.query.label || istParts().hm;
  runLeadsTodayCheckpoint(label);
  res.json({ ok: true, label: label, note: "manual test run; visit /leads_today.html shortly after to see results" });
});

app.get("/api/bucket-refill", (req, res) => {
  const poolByAgent = {};
  BACKUP.rows.forEach(function(r){
    const agent = r.backup_owner || "";
    if (!agent) return;
    if (!poolByAgent[agent]) poolByAgent[agent] = { total: 0, byStage: {} };
    const p = poolByAgent[agent];
    p.total++;
    const st = r.contact_engagement_stage || "(fresh/no stage)";
    p.byStage[st] = (p.byStage[st] || 0) + 1;
  });
  const workableByAgent = {};
  CACHE.contacts.forEach(function(c){
    if (WORKABLE.indexOf(c.contact_engagement_stage) >= 0) workableByAgent[c.hubspot_owner_id] = (workableByAgent[c.hubspot_owner_id] || 0) + 1;
  });
  const freshByAgent = {};
  Object.keys(CACHE.fresh || {}).forEach(function(oid){ freshByAgent[oid] = (CACHE.fresh[oid] || []).length; });
  const agents = Object.keys(CACHE.owners).filter(function(id){ return id !== ABHISHEK_OWNER_ID; }).map(function(id){
    const o = CACHE.owners[id];
    const workable = workableByAgent[id] || 0;
    const fresh = freshByAgent[id] || 0;
    const pool = poolByAgent[id] || { total: 0, byStage: {} };
    return {
      id: id, name: o.name, active: o.active,
      workable: workable, serviceable: workable + fresh,
      target: 100, needsRefill: workable < 30,
      pool: pool
    };
  }).sort(function(a, b){
    if (a.needsRefill !== b.needsRefill) return a.needsRefill ? -1 : 1;
    return b.pool.total - a.pool.total;
  });
  res.json({
    loadedAt: BACKUP.loadedAt, syncing: BACKUP.syncing, error: BACKUP.error,
    abhishekOwnerId: ABHISHEK_OWNER_ID, totalPool: BACKUP.rows.length,
    agents: agents,
    portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID }
  });
});

app.get("/api/bucket-refill/leads", (req, res) => {
  const agent = req.query.agent || "";
  const rows = BACKUP.rows.filter(function(r){ return r.backup_owner === agent; }).map(function(r){
    return {
      id: r.id, name: ((r.firstname || "") + " " + (r.lastname || "")).trim() || ("Contact " + r.id),
      creator: r.topmate_username || "", stage: r.contact_engagement_stage || "(fresh/no stage)",
      createdate: r.createdate, followUp: r.follow_up_date_and_time,
      workable: WORKABLE.indexOf(r.contact_engagement_stage) >= 0
    };
  });
  res.json({ agent: agent, leads: rows });
});

app.post("/api/bucket-refill/assign", async (req, res) => {
  if (REFRESH_KEY && req.query.key !== REFRESH_KEY) return res.status(403).json({ ok: false, error: "bad key" });
  const agentId = String((req.body && req.body.agentOwnerId) || "");
  const leadIds = Array.isArray(req.body && req.body.leadIds) ? req.body.leadIds.map(String) : [];
  if (!agentId || !leadIds.length) return res.status(400).json({ ok: false, error: "agentOwnerId and leadIds required" });
  const p = istParts();
  const tempTagMs = Date.UTC(parseInt(p.date.slice(0, 4), 10), parseInt(p.date.slice(5, 7), 10) - 1, parseInt(p.date.slice(8, 10), 10));
  try {
    for (let i = 0; i < leadIds.length; i += 100) {
      const inputs = leadIds.slice(i, i + 100).map(function(id){
        return { id: id, properties: { hubspot_owner_id: agentId, temp_tag: String(tempTagMs) } };
      });
      await hs("/crm/v3/objects/contacts/batch/update", { method: "POST", body: JSON.stringify({ inputs: inputs }) });
      await sleep(150);
    }
    const assignedAt = new Date().toISOString();
    const agentName = (CACHE.owners[agentId] && CACHE.owners[agentId].name) || agentId;
    ASSIGN_LOG.unshift({ agentId: agentId, agentName: agentName, count: leadIds.length, leadIds: leadIds, assignedAt: assignedAt, tempTagDate: p.date });
    ASSIGN_LOG = ASSIGN_LOG.slice(0, 200);
    BACKUP.rows = BACKUP.rows.filter(function(r){ return leadIds.indexOf(r.id) < 0; });
    res.json({ ok: true, assigned: leadIds.length, agentId: agentId, tempTagDate: p.date });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/bucket-refill/log", (req, res) => res.json({ log: ASSIGN_LOG }));

/* ---------- Call-now: waitlist form leads, conversion score, international ---------- */
const WAITLIST_FORMS = [
  { guid: "09fd2bc5-c716-4e70-ae2c-18aaec35eb4a", label: "Payal Waitlist", match: "payal waitlist" },
  { guid: "5bed7f99-9a35-4355-8695-23df4bab2618", label: "Ayush Waitlist", match: "ayush waitlist" },
  { guid: "f56bd773-4d5b-43bb-b4c4-6bfe657bcd10", label: "Priyanka Waitlist", match: "priyanka waitlist" }
];
// HubSpot list 1611 ("Conversion score > 6") == conversion_probability_score >= 6 (verified: both 1,722 contacts)
const CONV_SCORE_MIN = parseInt(process.env.CONV_SCORE_MIN || "6", 10);
// Above this many leads owed in a day, an agent cannot realistically work the queue,
// so the manager view flags them for parking and reassignment.
const OVERLOAD_LIMIT = parseInt(process.env.OVERLOAD_LIMIT || "100", 10);
let FORMS = { byEmail: new Map(), labels: {}, source: "", counts: {}, loadedAt: null, syncing: false, error: null };

/* The submission carries every answer the lead gave. Keeping only the email and the
   timestamp threw away the single most useful thing on a form lead: what they actually
   said about their role, their goal and how soon they want to move. */
const FORM_SKIP_FIELDS = ["email", "firstname", "lastname", "phone", "mobilephone",
  "hs_context", "topmate_username", "creator_username"];
async function fetchFormSubmissions(guid){
  const out = [];
  let after, pages = 0;
  do {
    const j = await hs("/form-integrations/v1/submissions/forms/" + guid + "?limit=50" + (after ? "&after=" + encodeURIComponent(after) : ""));
    (j.results || []).forEach(function(r){
      let em = "";
      const answers = [];
      (r.values || []).forEach(function(v){
        const nm = String(v.name || "").toLowerCase();
        if (nm === "email") { em = String(v.value || "").trim().toLowerCase(); return; }
        if (FORM_SKIP_FIELDS.indexOf(nm) >= 0) return;
        const val = String(v.value == null ? "" : v.value).trim();
        if (!val) return;
        // Multi-select answers arrive semicolon separated, which reads badly on one line.
        answers.push({ name: nm, value: val.split(";").map(function(x){ return x.trim(); }).filter(Boolean) });
      });
      if (em) out.push({ email: em, at: r.submittedAt || 0, answers: answers });
    });
    after = j.paging && j.paging.next && j.paging.next.after;
    pages++;
    await sleep(150);
  } while (after && pages < 200);
  return out;
}

/* Field names on a submission are internal ("what_is_your_current_role"). The question as
   the lead saw it lives on the form definition, so it is fetched once per form. */
async function fetchFormLabels(guid){
  const map = {};
  const take = function(f){
    if (!f) return;
    const n = String(f.name || "").toLowerCase();
    const l = String(f.label || "").trim();
    if (n && l) map[n] = l;
  };
  try {
    const j = await hs("/marketing/v3/forms/" + guid);
    (j.fieldGroups || []).forEach(function(g){ (g.fields || []).forEach(take); });
    if (Object.keys(map).length) return map;
  } catch (e) { /* fall through to the older shape below */ }
  try {
    const j2 = await hs("/forms/v2/forms/" + guid);
    (j2.formFieldGroups || []).forEach(function(g){ (g.fields || []).forEach(take); });
  } catch (e) { console.error("form labels " + guid + ": " + e.message); }
  return map;
}

const FORMS_HOURS = parseFloat(process.env.FORMS_HOURS || "6");
async function syncForms(force){
  if (!TOKEN || FORMS.syncing) return;
  const ageH = FORMS.loadedAt ? (Date.now() - Date.parse(FORMS.loadedAt)) / 3600000 : 1e9;
  // Waitlist submissions barely change and the endpoint is quota-expensive: refresh at most
  // every FORMS_HOURS, and never discard a good snapshot because a later pull failed.
  if (!force && FORMS.byEmail.size > 0 && ageH < FORMS_HOURS && !FORMS.error) return;
  FORMS.syncing = true;
  try {
  const map = new Map();
  const counts = {}, labels = {};
  let ok = 0, err = "";
  for (const f of WAITLIST_FORMS) {
    try {
      const subs = await fetchFormSubmissions(f.guid);
      if (!labels[f.guid]) labels[f.guid] = await fetchFormLabels(f.guid);
      subs.forEach(function(s){
        const k = String(s.email || "").toLowerCase();
        if (!k) return;
        if (!map.has(k)) map.set(k, { labels: {}, n: 0, last: 0, subs: [] });
        const e = map.get(k), at = ts(s.at);
        e.n++;
        if (at > e.last) e.last = at;
        if (!e.labels[f.label] || at > e.labels[f.label]) e.labels[f.label] = at;
        // Keep the latest submission per form. Someone who filled the same form three
        // times does not need three copies of the same answers on screen.
        const prev = e.subs.filter(function(x){ return x.form === f.label; })[0];
        if (!prev) e.subs.push({ form: f.label, guid: f.guid, at: at, answers: s.answers });
        else if (at > prev.at) { prev.at = at; prev.answers = s.answers; }
      });
      counts[f.label] = subs.length;
      ok++;
    } catch (e) { counts[f.label] = null; err = e.message; }
  }
  const quota = /429|daily limit|rate limit/i.test(err);
  const denied = /\b40[13]\b|scope/i.test(err);
  let note = null;
  if (ok < WAITLIST_FORMS.length) {
    note = quota
      ? "HubSpot daily API limit reached, so waitlist form data was not refreshed this cycle. Showing the last good snapshot; it retries automatically."
      : denied
        ? "Forms submissions API denied: the private app is missing the 'forms' scope. Falling back to first and recent conversion event names."
        : ("Waitlist form refresh failed: " + err);
    note = note.slice(0, 300);
  }
  // A failed pull must never wipe a good snapshot.
  const keepOld = ok === 0 && FORMS.byEmail.size > 0;
  FORMS = {
    byEmail: keepOld ? FORMS.byEmail : map,
    labels: Object.keys(labels).length ? labels : FORMS.labels,
    counts: keepOld ? FORMS.counts : counts,
    source: ok === WAITLIST_FORMS.length ? "forms-api" : (keepOld ? "forms-api (cached)" : (ok > 0 ? "forms-api (partial)" : "conversion-event fallback only")),
    loadedAt: keepOld ? FORMS.loadedAt : new Date().toISOString(),
    syncing: false, error: note
  };
  console.log("Forms synced: " + map.size + " emails across " + ok + "/" + WAITLIST_FORMS.length + " waitlist forms (" + FORMS.source + ")");
  } finally { FORMS.syncing = false; }
}

// A lead counts as a form lead if the Forms API saw a submission on its email, OR its first/recent
// conversion event names it. The union keeps the view working even without the forms scope.
function formsOf(c){
  const out = {};
  const em = String(c.email || "").trim().toLowerCase();
  const hit = em && FORMS.byEmail.has(em) ? FORMS.byEmail.get(em) : null;
  if (hit) Object.keys(hit.labels || {}).forEach(function(k){ out[k] = 1; });
  const names = (String(c.recent_conversion_event_name || "") + " ~ " + String(c.first_conversion_event_name || "")).toLowerCase();
  WAITLIST_FORMS.forEach(function(f){ if (names.indexOf(f.match) >= 0) out[f.label] = 1; });
  return Object.keys(out);
}
// How many waitlist submissions this person made, and when the latest one was.
// More than one means they raised their hand again, which matters whatever stage they sit in.
function formMeta(c){
  const em = String(c.email || "").trim().toLowerCase();
  const hit = em && FORMS.byEmail.has(em) ? FORMS.byEmail.get(em) : null;
  return { n: hit ? (hit.n || 0) : 0, last: hit ? (hit.last || 0) : 0 };
}
// What the lead actually wrote on the form, with the question worded the way they saw it.
function formAnswers(c){
  const em = String(c.email || "").trim().toLowerCase();
  const hit = em && FORMS.byEmail.has(em) ? FORMS.byEmail.get(em) : null;
  if (!hit || !hit.subs || !hit.subs.length) return [];
  return hit.subs.slice().sort(function(a, b){ return b.at - a.at; }).map(function(sub){
    const lab = (FORMS.labels || {})[sub.guid] || {};
    return { form: sub.form, at: sub.at,
      answers: (sub.answers || []).map(function(a){
        return { q: lab[a.name] || a.name.replace(/_/g, " ").replace(/^\w/, function(m){ return m.toUpperCase(); }),
          a: a.value };
      }) };
  });
}

/* Leads that no active agent is working: unassigned, or held by a deactivated owner.
   Unassigned leads are NOT in CACHE (that sync is partitioned per owner), so pull the
   priority ones separately: conversion score >= threshold, plus any waitlist form
   submitter we could not match to a pooled contact. Both sets are bounded (~200 + ~60). */
let UNOWNED = { rows: [], loadedAt: null, syncing: false, error: null };

async function fetchUnownedScored(){
  const out = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" },
        { propertyName: "conversion_probability_score", operator: "GTE", value: String(CONV_SCORE_MIN) }
      ]}],
      properties: PROPS,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 100, after: after
    };
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(function(r){ out.push(Object.assign({ id: r.id }, r.properties)); });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(140);
    if (out.length >= 9500) break;
  } while (after);
  return out;
}

async function fetchContactsByEmails(emails){
  const out = [];
  for (let i = 0; i < emails.length; i += 50) {
    const batch = emails.slice(i, i + 50);
    try {
      const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: batch }] }],
        properties: PROPS, limit: 100
      })});
      (j.results || []).forEach(function(r){ out.push(Object.assign({ id: r.id }, r.properties)); });
    } catch (e) { console.error("form email lookup failed: " + e.message); }
    await sleep(140);
  }
  return out;
}

async function syncUnowned(){
  if (!TOKEN || UNOWNED.syncing) return;
  UNOWNED.syncing = true;
  try {
    const rows = [];
    const seen = {};
    const push = function(r){ if (!seen[r.id]) { seen[r.id] = 1; rows.push(r); } };
    (await fetchUnownedScored()).forEach(push);
    const emails = Array.from(FORMS.byEmail.keys());
    if (emails.length) (await fetchContactsByEmails(emails)).forEach(push);
    UNOWNED = { rows: rows, loadedAt: new Date().toISOString(), syncing: false, error: null };
    console.log("Unowned/priority pool synced: " + rows.length + " contacts");
  } catch (e) {
    UNOWNED.syncing = false; UNOWNED.error = e.message;
    console.error("Unowned sync failed: " + e.message);
  }
}

const CN_DEFAULT_STAGES = ["counselled","program_pitched","discovery","pricing_pitched","Follow up","payment_prospect","FU_DNP","FU_RCB","rcb_requested_callback","dnp_did_not_pick","dnp_other","__fresh"];
const CN_OTHER_STAGES = ["IFC","ghosted","ni_not_interested","disqualified","deal_won"];
// Rescue stages: churned stages that still belong in the must-call set, but ONLY for leads that
// qualify on form submission or conversion score. International alone does not rescue a lead here.
const CN_RESCUE_STAGES = ["dnp_did_not_pick"];
function cnRescued(r){ return r.forms.length > 0 || r.score >= CONV_SCORE_MIN; }
const CN_STAGE_LABELS = {
  counselled: "Counselled", program_pitched: "Program pitched", discovery: "Discovery",
  pricing_pitched: "Pricing pitched", "Follow up": "Follow up", payment_prospect: "Payment prospect",
  FU_DNP: "FU - DNP", FU_RCB: "FU - RCB", rcb_requested_callback: "RCB - Requested callback",
  __fresh: "Fresh leads", IFC: "Interested in future", dnp_did_not_pick: "DNP (form or score)", dnp_other: "DNP (everything else)",
  ghosted: "Ghosted", ni_not_interested: "NI - Not interested", disqualified: "Disqualified", deal_won: "Deal won"
};

/* On-demand single-owner refresh: a bulk reassignment in HubSpot otherwise takes a full
   10-minute sync pass to show up. Re-pulling one owner is 1-2 API pages, so an agent can
   see their current bucket in seconds. */
let OWNER_REFRESH = {};
let POOL_REV = 0;
async function refreshOwner(ownerId){
  const rows = await fetchContactsForOwner(ownerId);
  let fr = [];
  try { fr = await fetchFreshForOwner(ownerId); } catch (e) { console.error("fresh refresh failed: " + e.message); }
  CACHE.contacts = CACHE.contacts.filter(function(c){ return String(c.hubspot_owner_id || "") !== String(ownerId); }).concat(rows);
  const nf = Object.assign({}, CACHE.fresh || {});
  if (fr.length) nf[ownerId] = fr; else delete nf[ownerId];
  CACHE.fresh = nf;
  POOL_REV++;
  OWNER_REFRESH[ownerId] = new Date().toISOString();
  return { staged: rows.length, fresh: fr.length };
}

/* Fresh leads for the creators the floor actually works. The per-owner fresh pull caps at
   9,500, and one parking-bucket owner holds >500k fresh leads, so creator-scoped fresh is
   the only way these become visible. ~20k rows total, recursive date-window split for the
   creators that exceed the 10k search cap. */
const PRIORITY_FRESH_CREATORS = (process.env.PRIORITY_FRESH_CREATORS ||
  "ayush_singh13,payalineurope,wanderess_priyanka,saurav_chaudhary_1,ankita_gulati,vijaychandola,technomanagers,kartikkapoorconsultation")
  .split(",").map(function(x){ return x.trim(); }).filter(Boolean);
const PFRESH_PROPS = ["firstname","lastname","topmate_username","createdate","international_number","actual_source",
  "email","phone","conversion_probability_score","recent_conversion_event_name","first_conversion_event_name",
  "follow_up_date_and_time","last_call_date_and_time","hubspot_owner_id","tm_student_or_professional",
  "hs_timezone","country","conversion_probability_reason"];
let PFRESH = { rows: [], byCreator: {}, loadedAt: null, syncing: false, error: null };
let PFRESH_LIST = PRIORITY_FRESH_CREATORS.slice();
// Loaded from the org store once it is available, so adding a creator survives a deploy
// without touching Railway. See adoptStoredCreators() below.
function adoptStoredCreators(){
  try {
    if (typeof ORG !== "undefined" && Array.isArray(ORG.creators) && ORG.creators.length) {
      PFRESH_LIST = ORG.creators.slice();
      console.log("Tracked creators loaded from store: " + PFRESH_LIST.length);
    }
  } catch (e) {}
}
function persistCreators(who){
  try {
    if (typeof ORG === "undefined") return;
    ORG.creators = PFRESH_LIST.slice();
    if (typeof orgSave === "function") orgSave("creators.set", PFRESH_LIST.join(","), who || "");
  } catch (e) {}
}

// Paged by hs_object_id cursor rather than HubSpot's `after` token. The token walk
// dies at 10,000 results with a 400, and date-window splitting cannot rescue a bulk
// import that lands thousands of contacts inside the same day. Filtering on
// hs_object_id GT lastSeen starts each query fresh, so there is no ceiling.
const PFRESH_MAX = parseInt(process.env.PFRESH_MAX || "60000", 10);
async function fetchFreshForCreator(creator, from, to, sink){
  const base = [
    { propertyName: "contact_engagement_stage", operator: "NOT_HAS_PROPERTY" },
    { propertyName: "topmate_username", operator: "EQ", value: creator }
  ];
  const probe = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
    filterGroups: [{ filters: base }], properties: ["createdate"], limit: 1 })});
  const total = probe.total || 0;
  if (!total) return { fetched: 0, total: 0, truncated: false };

  let lastId = "0", got = 0, guard = 0;
  while (got < PFRESH_MAX && guard < 1200) {
    guard++;
    const filters = base.concat([{ propertyName: "hs_object_id", operator: "GT", value: String(lastId) }]);
    let j;
    try {
      j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
        filterGroups: [{ filters }], properties: PFRESH_PROPS,
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], limit: 100 })});
    } catch (e) {
      console.error("fresh page failed for " + creator + " at id " + lastId + " (" + got + "/" + total + "): " + e.message);
      return { fetched: got, total: total, truncated: true };
    }
    const rows = j.results || [];
    if (!rows.length) break;
    rows.forEach(function(r){ sink(Object.assign({ id: r.id }, r.properties)); got++; });
    lastId = rows[rows.length - 1].id;
    if (rows.length < 100) break;
    await sleep(130);
  }
  return { fetched: got, total: total, truncated: got < total };
}

async function syncPriorityFresh(){
  if (!TOKEN || PFRESH.syncing) return;
  PFRESH.syncing = true;
  const from = Date.parse("2020-01-01T00:00:00Z"), to = Date.now() + 86400000;
  const rows = [], seen = {}, byCreator = {};
  let err = "";
  for (const c of PFRESH_LIST) {
    try {
      await fetchFreshForCreator(c, from, to, function(r){
        if (seen[r.id]) return;
        seen[r.id] = 1;
        rows.push(r);
        byCreator[c] = (byCreator[c] || 0) + 1;
      });
    } catch (e) { err = e.message; console.error("priority fresh " + c + " failed: " + e.message); }
  }
  PFRESH = { rows: rows, byCreator: byCreator, loadedAt: new Date().toISOString(), syncing: false, error: err || null };
  POOL_REV++;
  PFRESH.syncing = false;
  console.log("Priority fresh synced: " + rows.length + " across " + PFRESH_LIST.length + " creators");
}

let CN_POOL = { at: null, rows: [] };
function callnowPool(){
  const key = String(CACHE.loadedAt) + "|" + String(UNOWNED.loadedAt) + "|" + String(PFRESH.loadedAt) + "|" + POOL_REV;
  if (CN_POOL.at === key && CN_POOL.rows.length) return CN_POOL.rows;
  const rows = CACHE.contacts.slice();
  const seen = {};
  rows.forEach(function(c){ seen[c.id] = 1; });
  Object.keys(CACHE.fresh || {}).forEach(function(oid){
    (CACHE.fresh[oid] || []).forEach(function(f){
      seen[f.id] = 1;
      rows.push(Object.assign({}, f, { hubspot_owner_id: oid, contact_engagement_stage: "" }));
    });
  });
  (UNOWNED.rows || []).forEach(function(c){ if (!seen[c.id]) { seen[c.id] = 1; rows.push(c); } });
  (PFRESH.rows || []).forEach(function(c){
    if (seen[c.id]) return;
    seen[c.id] = 1;
    rows.push(Object.assign({}, c, { contact_engagement_stage: "" }));
  });
  CN_POOL = { at: key, rows: rows };
  return rows;
}

// Call Now scoping. VPs see everyone. A manager sees their team's agents PLUS every
// lead belonging to a creator mapped to their team, whoever holds it: another agent,
// a deactivated owner, or nobody at all. Those are their leads to chase regardless of
// who is sitting on them. An agent is pinned to their own owner id by the auth gate.
// Returns null for "no restriction".
function scopeFor(req){
  if (typeof AUTH_ON === "undefined" || !AUTH_ON) return null;
  const s = req.session || (typeof sessionOf === "function" ? sessionOf(req) : null);
  if (!s) return null;
  if (typeof isVP === "function" && isVP(req)) return null;
  if (s.role === "agent") return { agents: s.ownerId ? [String(s.ownerId)] : [], creators: [] };
  const em = String(s.email || "").toLowerCase();
  const ids = {}, crs = {};
  let owns = false;
  ((typeof ORG !== "undefined" && ORG.teams) || []).forEach(function(t){
    if (String(t.managerEmail || "").toLowerCase() !== em) return;
    owns = true;
    (t.agentIds || []).forEach(function(id){ ids[String(id)] = 1; });
    (t.creators || []).forEach(function(c){ crs[c] = 1; });
  });
  // A manager email that matches no team keeps full visibility rather than seeing nothing.
  return owns ? { agents: Object.keys(ids), creators: Object.keys(crs) } : null;
}
function inScope(sc, c){
  if (!sc) return true;
  if (sc.agents.indexOf(String(c.hubspot_owner_id || "")) >= 0) return true;
  return sc.creators.indexOf(c.topmate_username || "") >= 0;
}

function cnStage(c){ return c.contact_engagement_stage || "__fresh"; }
function cnRow(c){
  const oid = String(c.hubspot_owner_id || "");
  const o = CACHE.owners[oid] || {};
  const unassigned = !oid;
  const inactive = !unassigned && o.active === false;
  return {
    id: c.id,
    unassigned: unassigned,
    inactive: inactive,
    needsOwner: unassigned || inactive,
    name: ((c.firstname || "") + " " + (c.lastname || "")).trim() || "(no name)",
    stage: cnStage(c),
    owner: String(c.hubspot_owner_id || ""),
    ownerName: o.name || (oid ? "Owner " + oid : "(unassigned)"),
    creator: c.topmate_username || "",
    email: String(c.email || "").trim(),
    source: String(c.actual_source || "").trim(),
    last: ts(c.last_call_date_and_time),
    fu: ts(c.follow_up_date_and_time),
    calls: num(c.callscurrent_stage),
    own: num(c.call_in_current_stage_by_current_owner),
    entered: ts(c.engagement_stage_last_changed_at) || ts(c.createdate),
    created: ts(c.createdate),
    score: num(c.conversion_probability_score),
    phone: String(c.phone || "").trim(),
    tz: String(c.hs_timezone || "").trim(),
    country: String(c.country || "").trim(),
    why: clip(c.conversion_probability_reason, 400),
    aiSummary: clip(c.ryl_aicall_summary, 400),
    aiHot: num(c.ryl_aicall_hotness),
    optout: String(c.ryl_aicall_optout || "").toLowerCase() === "true",
    outcome: String(c.call_outcome || "").trim(),
    coldReason: clip(c.reason_for_notinteresteddisqualifiedghosted || c.not_interested_reason, 300),
    lastContact: ts(c.notes_last_contacted),
    paid: (function(){ const p = paidOf(c); return p ? p.at || 1 : 0; })(),
    sp: classifySP(c.tm_student_or_professional),
    forms: formsOf(c),
    formN: formMeta(c).n,
    formLast: formMeta(c).last,
    // What they actually filled in and what they last booked. A form lead with no context
    // is a phone number; with the form name and the booking title it is a conversation.
    convRecent: String(c.recent_conversion_event_name || "").trim(),
    convFirst: String(c.first_conversion_event_name || "").trim(),
    bookTitle: String(c.tm_last_booking_title || "").trim(),
    bookType: String(c.tm_last_booking_type || "").trim(),
    bookAt: ts(c.tm_last_booking_timestamp),
    bookN: num(c.tm_total_bookings),
    formAfterStage: (function(){
      const m = formMeta(c);
      const st = ts(c.engagement_stage_last_changed_at);
      return !!(m.last && st && m.last > st);
    })(),
    intl: intlOf(c),
    src: srcOf(c)
  };
}
// A never-worked lead is itself a call reason: nobody has spoken to it yet.
// Set FRESH_IS_PRIORITY=0 in Railway to revert to signal-only priority.
const FRESH_IS_PRIORITY = String(process.env.FRESH_IS_PRIORITY || "1") !== "0";
// Anyone who already paid must never appear as a must-call prospect. The sheet is the
// source of truth for payments, and deal_won on the contact often lags behind it.
let PAID = { at: null, byEmail: {}, byPhone: {} };
function paidIndex(){
  if (PAID.at === SHEET.loadedAt) return PAID;
  const byEmail = {}, byPhone = {};
  (SHEET.rows || []).forEach(function(r){
    const em = String(r.consumer_email || "").trim().toLowerCase();
    const ph = normPhone(r.consumer_phone);
    const rec = { at: ts(r.date), amount: num(r.price_inr), creator: r.creator_username || "" };
    if (em && (!byEmail[em] || rec.at < byEmail[em].at)) byEmail[em] = rec;
    if (ph && (!byPhone[ph] || rec.at < byPhone[ph].at)) byPhone[ph] = rec;
  });
  PAID = { at: SHEET.loadedAt, byEmail: byEmail, byPhone: byPhone };
  return PAID;
}
function paidOf(c){
  const idx = paidIndex();
  const em = String(c.email || "").trim().toLowerCase();
  if (em && idx.byEmail[em]) return idx.byEmail[em];
  const ph = normPhone(c.phone);
  if (ph && idx.byPhone[ph]) return idx.byPhone[ph];
  return null;
}
function clip(v, n){ const t = String(v || "").trim(); return t.length > n ? t.slice(0, n) + "..." : t; }

function istDayBounds(){
  const off = 5.5 * 3600000;
  const start = Math.floor((Date.now() + off) / 86400000) * 86400000 - off;
  return { start: start, end: start + 86400000 };
}
function cnSegs(r){
  // A paying customer or someone who opted out is never a must-call prospect, whatever
  // signals they carry. They stay visible in All in stage, flagged, but out of the queue.
  if (r.paid || r.optout) return { form: false, score: false, intl: false, fresh: false };
  return { form: r.forms.length > 0, score: r.score >= CONV_SCORE_MIN, intl: r.intl,
    fresh: FRESH_IS_PRIORITY && r.stage === "__fresh" };
}
function cnSort(a, b){
  const now = Date.now();
  const af = a.forms.length ? 1 : 0, bf = b.forms.length ? 1 : 0;
  if (af !== bf) return bf - af;
  if (a.score !== b.score) return b.score - a.score;
  const ao = (a.fu && a.fu < now) ? 1 : 0, bo = (b.fu && b.fu < now) ? 1 : 0;
  if (ao !== bo) return bo - ao;
  const ai = a.intl ? 1 : 0, bi = b.intl ? 1 : 0;
  if (ai !== bi) return bi - ai;
  return (a.last || 0) - (b.last || 0);
}
function cnFilter(q){
  const creator = q.creator || "", agent = q.agent || q.owner || "", intl = q.intl || "";
  const stages = String(q.stages || "").split(",").map(function(s){ return s.trim(); }).filter(Boolean);
  const stageSet = stages.length ? stages : CN_DEFAULT_STAGES;
  const ostate = q.ostate || "";
  const allow = q.__scope || null;
  // Filter by manager: their agents plus the creators mapped to their team.
  let teamScope = null;
  const wantTeam = String(q.team || "");
  if (wantTeam && typeof ORG !== "undefined") {
    const tt = (ORG.teams || []).filter(function(t){ return t.id === wantTeam; })[0];
    if (tt) teamScope = { agents: (tt.agentIds || []).map(String), creators: (tt.creators || []).slice() };
  }
  // Default scope is the tracked creator list: those are the buckets the floor actually works.
  const scoped = String(q.scope || "tracked") !== "all";
  return callnowPool().filter(function(c){
    if (allow && !inScope(allow, c)) return false;
    if (teamScope && !inScope(teamScope, c)) return false;
    if (scoped && PFRESH_LIST.indexOf(c.topmate_username || "") < 0) return false;
    if (creator && (c.topmate_username || "") !== creator) return false;
    if (agent && (agent === "none" ? String(c.hubspot_owner_id || "") !== "" : String(c.hubspot_owner_id || "") !== agent)) return false;
    if (!intlMatch(c, intl)) return false;
    return stageSet.indexOf(cnStage(c)) >= 0;
  }).map(cnRow).map(function(r){
    // DNP splits in two: the rescued ones (form or score) and the remainder, so the
    // rest of the bucket stays visible instead of vanishing behind the rescue rule.
    if (r.stage === "dnp_did_not_pick" && !cnRescued(r)) r.stage = "dnp_other";
    return r;
  }).filter(function(r){
    if (ostate === "needs" && !r.needsOwner) return false;
    if (ostate === "unassigned" && !r.unassigned) return false;
    if (ostate === "inactive" && !r.inactive) return false;
    return true;
  });
}

// Parking buckets and managers hold enormous piles that are not real working queues.
// They still appear in the agent table, but they must not inflate the headline totals.
// Ids: Abhishek Pal, Anand Mehta, Pawanpreet Singh, Hritika Jain, plus unassigned.
const NONCOUNT_OWNERS = (process.env.NONCOUNT_OWNERS || "165087274,163874118,162610237,164253068,none")
  .split(",").map(function(x){ return x.trim(); }).filter(function(x){ return x !== ""; });
function ownerCounted(id){
  const k = String(id || "");
  if (!k) return NONCOUNT_OWNERS.indexOf("none") < 0;
  return NONCOUNT_OWNERS.indexOf(k) < 0;
}

/* ==========================================================================
   Call Now v2. A separate endpoint on purpose: the original /api/callnow is in
   daily use by the floor and by the manager view, and none of the definitions
   below are safe to change underneath it.

   Three things differ from v1:
   1. Every lead lands in exactly one of two sections, so the two add up to the
      stage total column by column, not just on the last column.
   2. Overdue means a whole day has passed, not an hour. A follow-up set for
      11am today is due today until midnight, never overdue at 11:01.
   3. A DNP lead with no priority signal is never presented as work for today,
      whatever its follow-up says. It is held in the second section instead of
      being dropped, so the arithmetic still closes.
   ========================================================================== */
/* ==========================================================================
   Call Now v2. The model lives in lib/cn2.js as pure functions so it can be
   tested locally against fixtures with no HubSpot token; everything here is
   plumbing. v1 is untouched on purpose, the floor uses it every day.
   ========================================================================== */
const CN2 = require("./lib/cn2");
const CN2_WORK_DAYS = process.env.WORK_DAYS || CN2.DEFAULT_WORK_DAYS;
const CN2_WORK = CN2.workDaySet(CN2_WORK_DAYS);
// Midnight, so a call made at 09:00 counts. Nothing the base needs is unknown at 00:05.
const CN2_FREEZE_HM = process.env.CN2_FREEZE_HM || "00:05";
// Leads in these stages only enter v2 when they qualify, otherwise ghosted would swamp it.
const CN2_EXTRA_STAGES = ["IFC", "ghosted", "ni_not_interested"];
/* v1 splits DNP into two rows, "form or score" and "everything else". v2 splits it by
   group instead: the ones worth calling sit in Call today, the rest in their own group.
   So the row label must not claim either kind, or it contradicts the group it is in. */
const CN2_STAGE_LABELS = Object.assign({}, CN_STAGE_LABELS, { dnp_did_not_pick: "DNP", dnp_other: "DNP" });
const CN2_STAGES = CN_DEFAULT_STAGES.filter(function(s){ return s !== "dnp_other"; }).concat(CN2_EXTRA_STAGES);

// Fixtures let the whole page be driven locally. Never set this in Railway.
const CN2_FIXTURES = String(process.env.CN2_FIXTURES || "") === "1";
let CN2_FIXTURE_DATA = null;
if (CN2_FIXTURES) {
  try { CN2_FIXTURE_DATA = require("./fixtures/make.js"); console.log("Call Now v2 running on fixtures"); }
  catch (e) { console.error("fixture load failed: " + e.message); }
}
function cn2Now(){ return CN2_FIXTURE_DATA ? CN2_FIXTURE_DATA.now : Date.now(); }
function cn2Teams(){
  if (CN2_FIXTURE_DATA) return CN2_FIXTURE_DATA.teams;
  return (typeof ORG !== "undefined" && ORG.teams) || [];
}
function cn2OwnerName(id){
  if (CN2_FIXTURE_DATA) {
    const a = CN2_FIXTURE_DATA.agents.filter(function(x){ return x.id === String(id); })[0];
    return a ? a.name : (id ? "Owner " + id : "(unassigned)");
  }
  const o = CACHE.owners[id] || {};
  return o.name || (id ? "Owner " + id : "(unassigned)");
}

/* The v2 population. Every lead in the working stages, plus leads in the closed stages
   only when they have refilled the form or are an IFC that has come due. */
/* Cost control. v1 only ever walks twelve stages; v2 also has to see ghosted, NI and IFC
   so that a refilled form can be caught wherever the lead sits. Building a full row for
   every one of those is far too expensive to do on each request, and the page makes two.
   So: a cheap test on the raw contact first, a full row only for survivors, and the whole
   thing memoised until the pool actually changes. */
function cn2CheapQualify(c, day){
  const st = cnStage(c);
  if (CN2_EXTRA_STAGES.indexOf(st) < 0) return CN2_STAGES.indexOf(st) >= 0;
  if (st === "IFC") {
    const fu = ts(c.follow_up_date_and_time);
    if (!fu) return false;
    const t = CN2.timingOf({ stage: st, fu: fu, last: 0 }, day, CN2_WORK);
    return t === "due" || t === "over";
  }
  if (CN2.REFILL_EXCLUDED.indexOf(st) >= 0) return false;
  const fl = formMeta(c).last;
  if (!fl) return false;
  const last = ts(c.last_call_date_and_time);
  return !last || fl > last;
}

/* Building this list walks the entire lead pool. Doing that inside a request blocks the
   whole Node process: no other page is served, the Railway healthcheck times out, and the
   platform restarts the service. That restart loop is exactly what a spinner that never
   ends looks like from the browser.

   So the list is built by a background job that yields between chunks, and requests only
   ever read the last finished build. A request can now be slow to have data, but it can
   never be slow to answer. */
const CN2_CHUNK = 2000;
let CN2_POOL = { key: "", rows: [], live: {}, at: null, ms: 0, building: false };

function cn2PoolKey(){
  return [CACHE.loadedAt, PFRESH.loadedAt, UNOWNED.loadedAt, FORMS.loadedAt, POOL_REV,
    istParts(new Date(cn2Now())).date].join("|");
}
function cn2Ready(){
  if (CN2_FIXTURE_DATA) return true;
  return !!(CN2_POOL.at && CN2_POOL.rows.length);
}
function yieldToLoop(){ return new Promise(function(r){ setImmediate(r); }); }

async function cn2Build(force){
  if (CN2_FIXTURE_DATA) return;
  if (CN2_POOL.building) return;
  if (!CACHE.loadedAt) { CN2_POOL.lastError = "lead cache not loaded yet"; return; }
  const partial = [];
  if (!PFRESH.loadedAt) partial.push("fresh leads");
  if (!UNOWNED.loadedAt) partial.push("unassigned leads");
  if (!FORMS.loadedAt) partial.push("form submissions");
  const key = cn2PoolKey();
  if (!force && CN2_POOL.key === key && CN2_POOL.rows.length) return;
  CN2_POOL.building = true;
  const t0 = Date.now();
  try {
    const day = CN2.dayBoundsFor(cn2Now());
    const src = callnowPool();
    const out = [], live = {};
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (PFRESH_LIST.indexOf(c.topmate_username || "") >= 0 && cn2CheapQualify(c, day)) {
        const r = cnRow(c);
        // v1 splits DNP into two pseudo stages; v2 does its own parking, so put it back.
        if (r.stage === "dnp_other") r.stage = "dnp_did_not_pick";
        // Shown but not counted, exactly as v1 treats them. Filtering them out entirely
        // made unassigned leads and every parking bucket invisible rather than excluded.
        r.counted = ownerCounted(r.owner);
        out.push(r); live[r.id] = r;
      }
      // Hand the process back often enough that health checks and every other page
      // keep answering while this runs.
      if ((i % CN2_CHUNK) === CN2_CHUNK - 1) await yieldToLoop();
    }
    CN2_POOL = { key: key, rows: out, live: live, at: new Date().toISOString(),
      ms: Date.now() - t0, building: false,
      lastError: partial.length ? "built without " + partial.join(", ") + " yet" : null };
    console.log("Call Now v2 list built: " + out.length + " of " + src.length +
      " leads in " + CN2_POOL.ms + "ms" + (partial.length ? " (without " + partial.join(", ") + ")" : ""));
  } catch (e) {
    CN2_POOL.building = false;
    CN2_POOL.lastError = (e && e.message) || String(e);
    console.error("Call Now v2 build failed: " + CN2_POOL.lastError);
  }
}
function cn2Rows(){
  if (CN2_FIXTURE_DATA) {
    const day = CN2.dayBoundsFor(cn2Now());
    return CN2_FIXTURE_DATA.rows.map(function(r){
      if (r.counted === undefined) r.counted = ownerCounted(r.owner);
      return r;
    }).filter(function(r){
      if (CN2_STAGES.indexOf(r.stage) < 0) return false;
      if (CN2_EXTRA_STAGES.indexOf(r.stage) < 0) return true;
      if (CN2.isRefill(r)) return true;
      if (r.stage === "IFC") { const t = CN2.timingOf(r, day, CN2_WORK); return t === "due" || t === "over"; }
      return false;
    });
  }
  return CN2_POOL.rows;
}
function cn2Live(){
  if (CN2_FIXTURE_DATA) {
    const live = {};
    cn2Rows().forEach(function(r){ live[r.id] = r; });
    return live;
  }
  return CN2_POOL.live;
}

function cn2Store(){
  if (typeof ORG === "undefined") return null;
  if (!ORG.cn2base || typeof ORG.cn2base !== "object") ORG.cn2base = { date: "", at: null, rows: {} };
  return ORG.cn2base;
}
function cn2Freeze(force){
  const st = cn2Store();
  if (!st) return null;
  /* Freezing against a pool that is still loading is worse than not freezing: the
     denominator is wrong all day and looks authoritative. Everything feeding the pool
     has to have landed, and the result has to be in the same league as last time. */
  if (!CN2_FIXTURE_DATA) {
    if (!CACHE.loadedAt || CACHE.syncing) return null;
    if (!cn2Ready()) return null;   // never lock a list that has not finished building
  }
  const date = istParts(new Date(cn2Now())).date;
  if (!force && st.date === date && st.rows && Object.keys(st.rows).length) return st;
  const day = CN2.dayBoundsFor(cn2Now());
  const rows = {}, names = {};
  let n = 0;
  cn2Rows().forEach(function(r){
    rows[r.id] = CN2.pack(CN2.classify(r, day, { work: CN2_WORK, scoreMin: CONV_SCORE_MIN }));
    // Names live in their own map rather than in the packed line, because a name can
    // contain the separator and escaping it would be a bug waiting to happen.
    if (r.name) names[r.id] = String(r.name).slice(0, 60);
    n++;
  });
  if (!n) return null;
  const wasN = st.lastGood || 0;
  if (!force && wasN && n < wasN * 0.6) {
    console.error("Call Now v2 base refused: " + n + " leads against a usual " + wasN +
      ", the pool looks incomplete. Retrying on the next pass.");
    return null;
  }
  ORG.cn2base = { date: date, at: new Date().toISOString(), rows: rows, names: names,
    lastGood: Math.max(n, st.lastGood || 0) };
  if (typeof orgSave === "function") orgSave("cn2.base", date + ":" + n, "system");
  console.log("Call Now v2 base frozen for " + date + ": " + n + " leads");
  return ORG.cn2base;
}
function cn2FreezeDue(){
  const st = cn2Store();
  if (!st) return;
  const date = istParts(new Date(cn2Now())).date;
  if (st.date === date) return;
  if (istParts(new Date(cn2Now())).hm < CN2_FREEZE_HM) return;
  cn2Freeze(false);
}

// One place that decides which leads a v2 request is about, so the matrix, the agent
// table and the drill down can never disagree with each other.
/* Who is allowed to see what. A VP sees the floor, a manager sees the agents on their
   teams, an agent sees only themselves. Returned as a list of owner ids, or null for
   no restriction, so every v2 endpoint applies it the same way. */
function cn2Scope(req){
  if (isVP(req)) return null;
  const s = req.session || (typeof sessionOf === "function" ? sessionOf(req) : null);
  if (!s) return [];
  if (s.role === "agent") return [String(s.ownerId || "")];
  const me = String(s.email || "").toLowerCase();
  const mine = cn2Teams().filter(function(t){ return String(t.managerEmail || "").toLowerCase() === me; });
  if (!mine.length) return [];
  const ids = [];
  mine.forEach(function(t){ (t.agentIds || []).forEach(function(id){ ids.push(String(id)); }); });
  return ids;
}
function cn2Context(req){
  const day = CN2.dayBoundsFor(cn2Now());
  const store = cn2Store();
  const today = istParts(new Date(cn2Now())).date;
  const frozen = !!(store && store.date === today && store.rows && Object.keys(store.rows).length);
  const rows = cn2Rows();
  const live = cn2Live();

  let base = {};
  if (frozen) base = store.rows;
  else rows.forEach(function(r){ base[r.id] = CN2.pack(CN2.classify(r, day, { work: CN2_WORK, scoreMin: CONV_SCORE_MIN })); });

  // Filters are applied to the base, not the live pool, so the denominator a manager
  // sees is the same one the totals were built from.
  const wantAgent = String(req.query.agent || "");
  const wantTeam = String(req.query.team || "");
  const wantCreator = String(req.query.creator || "");
  const wantSource = String(req.query.source || "");
  const wantOstate = String(req.query.ostate || "");
  const wantIntl = String(req.query.intl || "");
  const wantStages = String(req.query.stages || "").split(",").map(function(x){ return x.trim(); }).filter(Boolean);
  const allow = cn2Scope(req);
  let teamAgents = null;
  if (wantTeam) {
    const tt = cn2Teams().filter(function(t){ return t.id === wantTeam; })[0];
    if (tt) teamAgents = (tt.agentIds || []).map(String);
  }
  if (wantAgent || teamAgents || wantCreator || wantSource || wantOstate || wantIntl ||
      wantStages.length || allow) {
    const kept = {};
    Object.keys(base).forEach(function(id){
      const c = CN2.unpack(base[id]);
      if (allow && allow.indexOf(String(c.owner)) < 0) return;   // role scope, not a filter
      if (wantAgent && String(c.owner) !== wantAgent) return;
      if (teamAgents && teamAgents.indexOf(String(c.owner)) < 0) return;
      if (wantCreator && c.creator !== wantCreator) return;
      if (wantSource && (c.source || "(not set)") !== wantSource) return;
      if (wantStages.length && wantStages.indexOf(c.stage) < 0) return;
      if (wantIntl === "yes" && !c.why.intl) return;
      if (wantIntl === "no" && c.why.intl) return;
      if (wantOstate) {
        const o = CACHE.owners[c.owner] || {};
        if (wantOstate === "needs" && !c.why.needs) return;
        if (wantOstate === "unassigned" && c.owner) return;
        if (wantOstate === "inactive" && (!c.owner || o.active !== false)) return;
        // Assigned to somebody who is still with us. The useful complement of the two above.
        if (wantOstate === "active" && (!c.owner || o.active === false)) return;
      }
      kept[id] = base[id];
    });
    base = kept;
  }
  /* The off-base list has to obey the same filters as the base, or filtering to one
     manager leaves them credited with every other manager's calls. */
  let scopedRows = rows;
  if (wantAgent || teamAgents || wantCreator || wantSource || wantOstate || wantIntl ||
      wantStages.length || allow) {
    scopedRows = rows.filter(function(r){
      const o = CACHE.owners[r.owner] || {};
      if (allow && allow.indexOf(String(r.owner)) < 0) return false;
      if (wantAgent && String(r.owner) !== wantAgent) return false;
      if (teamAgents && teamAgents.indexOf(String(r.owner)) < 0) return false;
      if (wantCreator && r.creator !== wantCreator) return false;
      if (wantSource && ((r.source || "(not set)") !== wantSource)) return false;
      if (wantStages.length && wantStages.indexOf(r.stage) < 0) return false;
      if (wantIntl === "yes" && !r.intl) return false;
      if (wantIntl === "no" && r.intl) return false;
      if (wantOstate === "needs" && !r.needsOwner) return false;
      if (wantOstate === "unassigned" && r.owner) return false;
      if (wantOstate === "inactive" && (!r.owner || o.active !== false)) return false;
      if (wantOstate === "active" && (!r.owner || o.active === false)) return false;
      return true;
    });
  }
  return { day: day, base: base, live: live, rows: scopedRows, allRows: rows, frozen: frozen,
    names: (frozen && store.names) || {},
    frozenAt: frozen ? store.at : null };
}

function cn2StageOrder(base){
  const seen = {};
  Object.keys(base).forEach(function(id){ seen[CN2.unpack(base[id]).stage] = 1; });
  const order = CN2_STAGES.filter(function(s){ return seen[s]; });
  Object.keys(seen).forEach(function(s){ if (order.indexOf(s) < 0) order.push(s); });
  return order;
}

app.get("/api/callnow2", function(req, res){
  if (!cn2Ready()) return res.json({ notReady: true,
    error: CACHE.loadedAt
      ? "Leads are loaded, building today's calling list now."
      : "Loading leads from HubSpot after a restart. This takes several minutes because every agent's bucket is fetched one at a time.",
    progress: { agents: SYNC_PROGRESS.owners, agentsDone: SYNC_PROGRESS.done,
      leadsSoFar: SYNC_PROGRESS.contacts, running: !!CACHE.syncing, syncError: CACHE.error || null } });
  const ctx = cn2Context(req);
  const order = cn2StageOrder(ctx.base);
  const agg = CN2.aggregate(ctx.base, ctx.live, ctx.day, order);
  const off = CN2.offBase(ctx.base, ctx.rows, ctx.day);

  const agents = {}, creators = {}, sources = {};
  // How hard the call-today leads have actually been worked, by total attempts in the
  // current stage and by this owner's attempts. Read from the live lead, because effort
  // is a question about now, not about midnight.
  const effort = { total: CN2.effortCounts(), owner: CN2.effortCounts() };
  Object.keys(ctx.base).forEach(function(id){
    const c = CN2.unpack(ctx.base[id]);
    const a = c.owner || "none";
    agents[a] = (agents[a] || 0) + 1;
    if (c.creator) creators[c.creator] = (creators[c.creator] || 0) + 1;
    const src = c.source || "(not set)";
    sources[src] = (sources[src] || 0) + 1;
    if (c.counted && c.sec === "n") {
      const lv = ctx.live[id];
      effort.total[CN2.effortBand(lv ? lv.calls : 0).key]++;
      effort.owner[CN2.effortBand(lv ? lv.own : 0).key]++;
    }
  });

  res.json({
    stages: order.map(function(s){
      return { stage: s, label: CN2_STAGE_LABELS[s] || s,
        n: agg.sections.n[s], a: agg.sections.a[s], d: agg.sections.d[s] };
    }),
    totals: agg.totals, excluded: agg.excluded, movement: agg.movement,
    effort: effort, effortBands: CN2.EFFORT_BANDS.map(function(b){
      return { key: b.key, label: b.label, min: b.min, max: b.max === Infinity ? null : b.max, cls: b.cls }; }),
    offBase: { leads: off.length, calls: off.length },
    timing: CN2.TIMING, columns: CN2.COLUMNS,
    frozen: ctx.frozen, frozenAt: ctx.frozenAt, freezeHour: CN2_FREEZE_HM, workDays: CN2_WORK_DAYS,
    baseSize: Object.keys(ctx.base).length,
    agentOptions: Object.keys(agents).map(function(id){
      return { id: id === "none" ? "" : id, name: cn2OwnerName(id === "none" ? "" : id), n: agents[id] };
    }).sort(function(a, b){ return b.n - a.n; }),
    creatorOptions: Object.keys(creators).map(function(u){ return { u: u, n: creators[u] }; })
      .sort(function(a, b){ return b.n - a.n; }),
    sourceOptions: Object.keys(sources).map(function(u){ return { u: u, n: sources[u] }; })
      .sort(function(a, b){ return b.n - a.n; }),
    teamOptions: cn2Teams().map(function(t){ return { id: t.id, name: t.name || "(unnamed)" }; }),
    scoreMin: CONV_SCORE_MIN, loadedAt: CN2_FIXTURE_DATA ? "fixtures" : CACHE.loadedAt,
    fixtures: !!CN2_FIXTURE_DATA,
    // The page hides anything not meant for the reader rather than relying on the route
    // gate alone, so opening v2 to managers later cannot leak a control by accident.
    isVP: isVP(req), role: (req.session && req.session.role) || "manager",
    scoped: !!cn2Scope(req),
    trackedCreators: PFRESH_LIST.slice(),
    stageOptions: cn2StageOrder(ctx.base).map(function(x){
      return { stage: x, label: CN2_STAGE_LABELS[x] || x }; }),
    listBuiltAt: CN2_POOL.at, listBuildMs: CN2_POOL.ms, listSize: CN2_POOL.rows.length
  });
});

/* Per agent, same locked list. It is the filter as much as a table: clicking a row
   scopes the page to that agent, which is how the v1 page behaves. */
app.get("/api/callnow2/agents", function(req, res){
  if (!cn2Ready()) return res.json({ notReady: true });
  const ctx = cn2Context(req);
  const agg = CN2.aggregate(ctx.base, ctx.live, ctx.day, cn2StageOrder(ctx.base));
  const teamOf = {}, teamName = {};
  cn2Teams().forEach(function(t){
    teamName[t.id] = t.name || "(unnamed)";
    (t.agentIds || []).forEach(function(id){ teamOf[String(id)] = t.id; });
  });
  const off = {};
  CN2.offBase(ctx.base, ctx.rows, ctx.day).forEach(function(r){
    const a = String(r.owner || "none");
    off[a] = (off[a] || 0) + 1;
  });
  /* Churn effort per agent: of the leads they are holding that need a call today, how
     many have barely been tried. Two readings, because they answer different questions.
     By anyone says whether the lead has had a go at all; by this agent says whether the
     person holding it has done their share, which is the one a manager acts on. */
  const eff = {};
  Object.keys(ctx.base).forEach(function(id){
    const c = CN2.unpack(ctx.base[id]);
    if (c.sec !== "n") return;
    const a = c.owner || "none";
    if (!eff[a]) eff[a] = { total: CN2.effortCounts(), owner: CN2.effortCounts() };
    const lv = ctx.live[id];
    eff[a].total[CN2.effortBand(lv ? lv.calls : 0).key]++;
    eff[a].owner[CN2.effortBand(lv ? lv.own : 0).key]++;
  });

  const rows = Object.keys(agg.byAgent).map(function(id){
    const tid = teamOf[id];
    const o = CN2_FIXTURE_DATA ? {} : (CACHE.owners[id] || {});
    return { id: id === "none" ? "" : id, name: cn2OwnerName(id === "none" ? "" : id),
      team: tid ? teamName[tid] : "", teamId: tid || "",
      active: o.active !== false, counted: ownerCounted(id === "none" ? "" : id),
      n: agg.byAgent[id].n, a: agg.byAgent[id].a, d: agg.byAgent[id].d,
      effort: eff[id] || { total: CN2.effortCounts(), owner: CN2.effortCounts() },
      offBase: off[id] || 0 };
  }).sort(function(x, y){ return y.n.all - x.n.all; });
  res.json({ agents: rows, frozen: ctx.frozen, timing: CN2.TIMING, columns: CN2.COLUMNS,
    effortBands: CN2.EFFORT_BANDS.map(function(b){
      return { key: b.key, label: b.label, min: b.min, max: b.max === Infinity ? null : b.max, cls: b.cls }; }) });
});

/* Side by side with v1, bucket by bucket.
   Before anyone's targets move onto v2's definitions, every difference between the two
   has to be a number you can see and a sentence you can read, not a surprise in a
   manager meeting. Both sides are computed here from the same pool in the same request,
   so nothing can be blamed on timing. */
/* Where every call today went.
   HubSpot knows the true number. This page shows a filtered subset of it, and until now
   the difference was a mystery. This asks HubSpot for every lead called today and sorts
   each one into the reason it does or does not appear here, so the whole count is
   accounted for rather than argued about. */
let CN2_OUT = { at: 0, running: false, data: null };
async function cn2CallLadder(){
  const day = istDayBounds();
  const filters = [
    { propertyName: "last_call_date_and_time", operator: "GTE", value: String(day.start) },
    { propertyName: "last_call_date_and_time", operator: "LT", value: String(day.end) }
  ];
  const base = (cn2Store() || {}).rows || {};
  const pool = {};
  cn2Rows().forEach(function(r){ pool[r.id] = r; });
  const inPool = {};
  callnowPool().forEach(function(c){ inPool[c.id] = c; });

  const bucket = { onList: 0, onListNeedsCall: 0, createdToday: 0, inPoolNotOnList: 0,
    untrackedCreator: 0, noCreator: 0, stageNotCovered: 0, notInApp: 0 };
  const byCreator = {}, byStage = {};
  let total = 0, after, pages = 0;
  do {
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
      filterGroups: [{ filters: filters }],
      properties: ["topmate_username", "hubspot_owner_id", "contact_engagement_stage", "createdate"],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 100, after: after })});
    total = j.total || total;
    (j.results || []).forEach(function(r){
      const p = r.properties || {};
      const u = String(p.topmate_username || "").trim();
      const st = String(p.contact_engagement_stage || "").trim() || "__fresh";
      const madeToday = ts(p.createdate) >= day.start;
      const oid = String(p.hubspot_owner_id || "");
      const nm = oid ? ((CACHE.owners[oid] || {}).name || ("Owner " + oid)) : "(unassigned)";

      if (base[r.id]) {
        bucket.onList++;
        // Same population the hero counts: needs a call today, parking buckets excluded.
        const c = CN2.unpack(base[r.id]);
        if (c.sec === "n" && c.counted) bucket.onListNeedsCall++;
        return;
      }
      if (pool[r.id]) {
        if (madeToday) bucket.createdToday++;
        else bucket.inPoolNotOnList++;
        return;
      }
      if (!u) { bucket.noCreator++; return; }
      if (PFRESH_LIST.indexOf(u) < 0) {
        bucket.untrackedCreator++;
        if (!byCreator[u]) byCreator[u] = { creator: u, leads: 0, agents: {},
          caseClash: PFRESH_LIST.some(function(x){ return x.toLowerCase() === u.toLowerCase(); }) };
        byCreator[u].leads++;
        byCreator[u].agents[nm] = (byCreator[u].agents[nm] || 0) + 1;
        return;
      }
      // Tracked creator, but the stage is one v2 does not carry, or it carries it only
      // when the lead qualifies and this one does not.
      if (inPool[r.id]) {
        bucket.stageNotCovered++;
        byStage[st] = (byStage[st] || 0) + 1;
        return;
      }
      bucket.notInApp++;
    });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
    pages++;
  } while (after && pages < 60);

  const rows = Object.keys(byCreator).map(function(u){
    const a = byCreator[u];
    return { creator: u, leads: a.leads, caseClash: a.caseClash,
      agents: Object.keys(a.agents).map(function(n){ return { name: n, n: a.agents[n] }; })
        .sort(function(x, y){ return y.n - x.n; }).slice(0, 5) };
  }).sort(function(x, y){ return y.leads - x.leads; });

  const LADDER = [
    ["onList", "On today's calling list", "Counted in the hero and in every table."],
    ["createdToday", "Created after the list locked", "A brand new lead, called the same day. Real work, not part of this morning's plan."],
    ["inPoolNotOnList", "In the pool but not on this morning's list", "The app holds the lead now but it was not on the list when it locked, usually because the list was locked before the lead qualified or before its bucket was included."],
    ["untrackedCreator", "Creator not on the tracked list", "Invisible to this page until the creator is tracked. Add them below."],
    ["noCreator", "No creator set on the lead", "Cannot be attributed to a creator at all."],
    ["stageNotCovered", "Stage this page does not carry", "Ghosted, not interested, disqualified, deal won, or an IFC not yet due, with no form refill to pull it back in."],
    ["notInApp", "Not held by the app at all", "The lead has never been pulled: an owner outside the sync, or a bucket past the ten thousand cap."]
  ];
  return { at: new Date().toISOString(), hubspotCalledToday: total,
    accountedFor: LADDER.reduce(function(a, x){ return a + bucket[x[0]]; }, 0),
    ladder: LADDER.map(function(x){ return { key: x[0], label: x[1], n: bucket[x[0]], why: x[2] }; }),
    byStage: Object.keys(byStage).map(function(k){
      return { stage: k, label: CN2_STAGE_LABELS[k] || k, n: byStage[k] }; })
      .sort(function(a, b){ return b.n - a.n; }),
    tracked: PFRESH_LIST.slice(), rows: rows, poolNow: Object.keys(pool).length,
    // What HubSpot says about the very number the hero shows, plus how stale the app's
    // own copy of the leads is, which is the usual reason the two differ.
    onListNeedsCall: bucket.onListNeedsCall,
    leadsSyncedAt: (typeof DELTA !== "undefined" && DELTA.at) || CACHE.loadedAt,
    outsideTracked: bucket.untrackedCreator, noCreator: bucket.noCreator };
}

app.get("/api/callnow2/outside", async function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  if (!TOKEN) return res.status(503).json({ error: "no HubSpot token configured" });
  const force = String(req.query.force || "") === "1";
  if (!force && CN2_OUT.data && (Date.now() - CN2_OUT.at) < 5 * 60 * 1000) return res.json(CN2_OUT.data);
  if (CN2_OUT.running) return res.json(CN2_OUT.data || { running: true });
  CN2_OUT.running = true;
  try {
    const d = await cn2CallLadder();
    CN2_OUT = { at: Date.now(), running: false, data: d };
    res.json(d);
  } catch (e) {
    CN2_OUT.running = false;
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/callnow2/reconcile", function(req, res){
  // Comparing the two pages is a VP question, not a floor one.
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  if (!cn2Ready()) return res.json({ notReady: true });
  const day = istDayBounds();
  const now = Date.now();

  // v1 exactly as the live page computes it.
  const v1 = { pool: 0, form: 0, score: 0, intl: 0, fresh: 0, needs: 0, due: 0, done: 0,
    overdue: 0, nofu: 0, uncalled: 0 };
  cnFilter({ scope: "tracked" }).forEach(function(r){
    if (!ownerCounted(r.owner)) return;
    const sg = cnSegs(r);
    if (!(sg.form || sg.score || sg.intl || sg.fresh)) return;
    v1.pool++;
    if (sg.form) v1.form++;
    if (sg.score) v1.score++;
    if (sg.intl) v1.intl++;
    if (sg.fresh) v1.fresh++;
    if (r.needsOwner) v1.needs++;
    if (r.fu && r.fu < now) v1.overdue++;          // v1: the hour has passed
    if (!r.fu) v1.nofu++;
    if (!r.last) v1.uncalled++;
    if (r.fu >= day.start && r.fu < day.end) { v1.due++; if (r.last >= day.start && r.last < day.end) v1.done++; }
  });

  // v2 from the locked list, counted leads only, which is what its totals show.
  const ctx = cn2Context(req);
  const v2 = { pool: 0, form: 0, score: 0, intl: 0, fresh: 0, needs: 0, due: 0, done: 0,
    overdue: 0, nofu: 0, uncalled: 0 };
  let notCounted = 0, unassigned = 0;
  Object.keys(ctx.base).forEach(function(id){
    const c = CN2.unpack(ctx.base[id]);
    if (!c.counted) {
      notCounted++;
      if (!c.owner) unassigned++;
      return;
    }
    const live = ctx.live[id];
    const worked = !!(live && live.last >= day.start && live.last < day.end);
    if (CN2.hit(c, "any")) v2.pool++;
    if (c.why.form) v2.form++;
    if (c.why.score) v2.score++;
    if (c.why.intl) v2.intl++;
    if (c.why.fresh) v2.fresh++;
    if (c.why.needs) v2.needs++;
    if (c.t === "over") v2.overdue++;              // v2: a whole working day has passed
    if (c.t === "nofu") v2.nofu++;
    if (c.t === "newlead") v2.uncalled++;
    if (c.t === "due") { v2.due++; if (worked) v2.done++; }
  });

  const WHY = {
    pool: "v2 also counts a refilled form and an IFC that has come due, so it is usually larger.",
    form: "Same rule on both. A difference here means the form sync is mid-refresh.",
    score: "Same rule on both, conversion score of " + CONV_SCORE_MIN + " or more. Any gap is sync timing, not definition.",
    intl: "Same rule on both, the international number flag. Any gap is sync timing, not definition.",
    fresh: "Same rule on both, a lead with no engagement stage that nobody has worked yet.",
    needs: "v1 counts these inside its priority pool. v2 shows them but keeps them out of its totals, so v2 reads lower here by design.",
    due: "v1 is live, v2 is the list as it stood at midnight. A follow-up created or moved during the day changes v1 and not v2.",
    done: "Same rule, but measured against different denominators.",
    overdue: "The big one. v1 calls a follow-up overdue the moment its time passes. v2 waits for a whole working day, so v2 is always lower and Monday never inherits the weekend.",
    nofu: "v2 moves a brand new lead into its own bucket, so it is not double counted here.",
    uncalled: "v1 counts anyone never called. v2 counts brand new leads with no follow-up, which is a tighter definition."
  };
  const LABEL = { pool: "Priority pool", form: "Form leads", score: "Score " + CONV_SCORE_MIN + " or more",
    intl: "International", fresh: "Fresh", needs: "Needs owner", due: "Due today",
    done: "Due today, called", overdue: "Overdue", nofu: "No follow-up set", uncalled: "Never called" };

  res.json({
    at: new Date().toISOString(),
    frozen: ctx.frozen, frozenAt: ctx.frozenAt,
    // v1's side is computed from the live pool, which is empty when running on fixtures.
    fixtures: !!CN2_FIXTURE_DATA,
    rows: Object.keys(LABEL).map(function(k){
      return { key: k, label: LABEL[k], v1: v1[k], v2: v2[k], delta: v2[k] - v1[k], why: WHY[k] };
    }),
    shown: { notCounted: notCounted, unassigned: unassigned }
  });
});

app.get("/api/callnow2/leads", function(req, res){
  if (!cn2Ready()) return res.json({ notReady: true,
    error: CACHE.loadedAt
      ? "Leads are loaded, building today's calling list now."
      : "Loading leads from HubSpot after a restart. This takes several minutes because every agent's bucket is fetched one at a time.",
    progress: { agents: SYNC_PROGRESS.owners, agentsDone: SYNC_PROGRESS.done,
      leadsSoFar: SYNC_PROGRESS.contacts, running: !!CACHE.syncing, syncError: CACHE.error || null } });
  const ctx = cn2Context(req);
  const stage = String(req.query.stage || ""), sec = String(req.query.sec || "");
  const col = String(req.query.col || "all"), t = String(req.query.t || "");
  const worked = String(req.query.worked || ""), moved = String(req.query.moved || "");
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 3000);

  const picked = [];
  Object.keys(ctx.base).forEach(function(id){
    const c = CN2.unpack(ctx.base[id]);
    if (stage && c.stage !== stage) return;
    if (sec && c.sec !== sec) return;
    if (t && c.t !== t) return;
    if (!CN2.hit(c, col)) return;
    const band = String(req.query.band || "");
    if (band) {
      const by = String(req.query.bandBy || "total");
      const lv = ctx.live[id];
      const n = lv ? (by === "owner" ? lv.own : lv.calls) : 0;
      if (CN2.effortBand(n).key !== band) return;
    }
    const nc = String(req.query.notcounted || "");
    if (nc === "1" && c.counted) return;
    if (nc !== "1" && !c.counted) return;   // totals exclude them, so the drill does too
    const cur = ctx.live[id] || null;
    const isWorked = !!(cur && cur.last >= ctx.day.start && cur.last < ctx.day.end);
    if (worked === "1" && !isWorked) return;
    if (worked === "0" && isWorked) return;
    const nowC = cur ? CN2.classify(cur, ctx.day, { work: CN2_WORK, scoreMin: CONV_SCORE_MIN }) : null;
    if (moved === "stage" && !(nowC && nowC.stage !== c.stage)) return;
    if (moved === "fu" && !(nowC && nowC.t !== c.t)) return;
    if (moved === "owner" && !(nowC && nowC.owner !== c.owner)) return;
    if (moved === "gone" && cur) return;
    if (moved === "still" && (isWorked || !cur || nowC.stage !== c.stage || nowC.t !== c.t)) return;
    picked.push({ id: id, c: c, cur: cur, now: nowC, worked: isWorked });
  });
  const total = picked.length;
  const out = picked.sort(function(a, b){
    if (a.worked !== b.worked) return a.worked ? 1 : -1;
    const af = a.cur ? a.cur.fu : 0, bf = b.cur ? b.cur.fu : 0;
    return (af || Infinity) - (bf || Infinity);
  }).slice(0, limit);

  res.json({
    total: total, shown: out.length, frozen: ctx.frozen,
    rows: out.map(function(x){
      const r = x.cur || {};
      return {
        id: x.id, worked: x.worked, gone: !x.cur,
        name: r.name || ctx.names[x.id] || "(no longer in the list)",
        openStage: x.c.stage, openTiming: x.c.t, section: x.c.sec, why: x.c.why,
        nowStage: x.now ? x.now.stage : "", nowTiming: x.now ? x.now.t : "",
        movedStage: !!(x.now && x.now.stage !== x.c.stage),
        movedFu: !!(x.now && x.now.t !== x.c.t),
        movedOwner: !!(x.now && x.now.owner !== x.c.owner),
        ownerName: cn2OwnerName(x.c.owner), creator: x.c.creator, source: x.c.source || "",
        counted: x.c.counted !== false,
        unassigned: !x.c.owner,
        ownerInactive: !!(x.c.owner && (CACHE.owners[x.c.owner] || {}).active === false),
        phone: r.phone || "", last: r.last || 0, fu: r.fu || 0, formLast: r.formLast || 0,
        calls: r.calls || 0, own: r.own || 0,
        band: CN2.effortBand(r.calls || 0).key, bandOwner: CN2.effortBand(r.own || 0).key,
        score: r.score || 0, intl: !!r.intl,
        entered: r.entered || 0, aiSummary: r.aiSummary || "", outcome: r.outcome || "",
        whyText: r.why || "", coldReason: r.coldReason || "", needsOwner: !!r.needsOwner,
        forms: r.forms || [], formN: r.formN || 0,
        formSubs: (r.forms && r.forms.length) ? formAnswers({ email: r.email }) : [],
        convRecent: r.convRecent || "", convFirst: r.convFirst || "",
        bookTitle: r.bookTitle || "", bookType: r.bookType || "",
        bookAt: r.bookAt || 0, bookN: r.bookN || 0,
        aiHot: r.aiHot || 0, stageEntered: r.entered || 0
      };
    }),
    portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID }
  });
});

app.post("/api/callnow2/rebuild", function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "Call Now v2 is restricted" });
  guard("cn2BuildManual", function(){ return cn2Build(true); })();
  res.status(202).json({ ok: true, building: true });
});

app.post("/api/callnow2/refreeze", function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "Call Now v2 is restricted" });
  const st = cn2Freeze(true);
  res.json({ ok: !!st, at: st ? st.at : null, n: st ? Object.keys(st.rows).length : 0 });
});

app.get("/api/callnow", (req, res) => {
  const allow = scopeFor(req);
  if (allow) req.query.__scope = allow;
  const rows = cnFilter(req.query);
  const order = (String(req.query.stages || "").split(",").map(function(s){ return s.trim(); }).filter(Boolean));
  const stageOrder = order.length ? order : CN_DEFAULT_STAGES;
  const day = istDayBounds();
  const blankT = function(){ return { due: 0, back: 0, done: 0, missed: 0, bwork: 0 }; };
  const blank = function(){ return { total: 0, form: 0, score: 0, intl: 0, any: 0, needs: 0, overdue: 0, nofu: 0, uncalled: 0,
    due: 0, done: 0, missed: 0, touched: 0,
    t: { form: blankT(), score: blankT(), intl: blankT(), any: blankT(), needs: blankT(), all: blankT(),
         uncalled: blankT(), nofu: blankT(), over: blankT() } }; };
  const byStage = {}, tot = blank();
  const byAgent = {}, byCreator = {};
  stageOrder.forEach(function(s){ byStage[s] = blank(); });
  rows.forEach(function(r){
    const s = cnSegs(r), any = s.form || s.score || s.intl || s.fresh;
    const isCounted = ownerCounted(r.owner);
    const b = byStage[r.stage] || (byStage[r.stage] = blank());
    const now = Date.now();
    const calledToday = r.last >= day.start && r.last < day.end;
    const dueToday = r.fu >= day.start && r.fu < day.end;
    (isCounted ? [b, tot] : []).forEach(function(x){
      // Backlog: no next step scheduled, or the next step is already past, or never called.
      // Deduped union, so a lead that is all three still counts once.
      const inBacklog = !r.fu || r.fu < now || !r.last;
      const bump = function(k){
        const o = x.t[k];
        if (inBacklog) o.back++;
        // A call made today on a lead that was NOT scheduled for today: backlog being worked.
        // Disjoint from done, so done + bwork equals every call made today.
        if (calledToday && !dueToday) o.bwork++;
        if (!dueToday) return;
        o.due++;
        if (calledToday) o.done++; else o.missed++;
      };
      x.total++;
      bump("all");
      if (s.form) x.form++;
      if (s.score) x.score++;
      if (s.intl) x.intl++;
      if (any) {
        x.any++;
        if (r.needsOwner) x.needs++;
        if (r.fu && r.fu < now) x.overdue++;
        if (!r.fu) x.nofu++;
        if (!r.last) x.uncalled++;
        if (calledToday) x.touched++;
        if (dueToday) { x.due++; if (calledToday) x.done++; else x.missed++; }
        if (s.form) bump("form");
        if (s.score) bump("score");
        if (s.intl) bump("intl");
        if (r.needsOwner) bump("needs");
        if (!r.last) bump("uncalled");
        if (!r.fu) bump("nofu");
        if (r.fu && r.fu < now) bump("over");
        bump("any");
      }
    });
    if (!byAgent[r.owner]) byAgent[r.owner] = { id: r.owner, name: r.ownerName, active: r.owner ? !r.inactive : false,
      counted: isCounted,
      total: 0, any: 0, form: 0, score: 0, intl: 0, needs: 0, overdue: 0, nofu: 0, uncalled: 0,
      due: 0, done: 0, missed: 0, touched: 0, bwork: 0 };
    const a = byAgent[r.owner];
    a.total++;
    if (any) {
      a.any++;
      if (s.form) a.form++;
      if (s.score) a.score++;
      if (s.intl) a.intl++;
      if (r.needsOwner) a.needs++;
      if (r.fu && r.fu < now) a.overdue++;
      if (!r.fu) a.nofu++;
      if (!r.last) a.uncalled++;
      const ct = r.last >= day.start && r.last < day.end;
      const dt = r.fu >= day.start && r.fu < day.end;
      if (ct) a.touched++;
      if (ct && !dt) a.bwork++;
      if (dt) { a.due++; if (ct) a.done++; else a.missed++; }
    }
    const ck = r.creator || "(none)";
    if (!byCreator[ck]) byCreator[ck] = { u: ck, total: 0, any: 0 };
    byCreator[ck].total++; if (any) byCreator[ck].any++;
  });
  // Reconciliation: how many leads were called today at each level of filtering, so the
  // "calls made" figure can be traced back to what HubSpot reports.
  const dayR = istDayBounds();
  let callsPool = 0, callsScope = 0, callsCounted = 0;
  callnowPool().forEach(function(c){
    const lc = ts(c.last_call_date_and_time);
    if (!(lc >= dayR.start && lc < dayR.end)) return;
    callsPool++;
    if (PFRESH_LIST.indexOf(c.topmate_username || "") >= 0) callsScope++;
    if (ownerCounted(c.hubspot_owner_id) && PFRESH_LIST.indexOf(c.topmate_username || "") >= 0) callsCounted++;
  });

  const matrix = stageOrder.map(function(s){
    return Object.assign({ stage: s, label: CN_STAGE_LABELS[s] || s }, byStage[s] || blank());
  });
  const scoped = String(req.query.scope || "tracked") !== "all";
  const allowOpts = req.query.__scope || null;
  const allCreators = {}, scopedCreators = {}, allAgents = {};
  let unassignedPool = 0;
  callnowPool().forEach(function(c){
    if (allowOpts && !inScope(allowOpts, c)) return;
    const u = c.topmate_username;
    if (u) {
      allCreators[u] = (allCreators[u] || 0) + 1;
      if (PFRESH_LIST.indexOf(u) >= 0) scopedCreators[u] = (scopedCreators[u] || 0) + 1;
    }
    if (scoped && PFRESH_LIST.indexOf(u || "") < 0) return;
    const oid = String(c.hubspot_owner_id || "");
    if (oid) allAgents[oid] = (allAgents[oid] || 0) + 1; else unassignedPool++;
  });
  Object.values(byAgent).forEach(function(a){
    a.tocall = a.due + a.overdue;
    a.overloaded = a.tocall > OVERLOAD_LIMIT;
  });
  res.json({
    loadedAt: CACHE.loadedAt, syncing: CACHE.syncing, error: CACHE.error,
    formsLoadedAt: FORMS.loadedAt, formsSource: FORMS.source, formsError: FORMS.error, formsCounts: FORMS.counts,
    formsEmails: FORMS.byEmail.size, unownedLoadedAt: UNOWNED.loadedAt, unownedError: UNOWNED.error,
    pfreshLoadedAt: PFRESH.loadedAt, pfreshCount: PFRESH.rows.length, pfreshCreators: PFRESH_LIST,
    pfreshByCreator: PFRESH.byCreator, pfreshSyncing: PFRESH.syncing,
    // Whether an added creator actually survives a redeploy, which depends on a
    // writable volume being mounted, not on the code path being present.
    creatorsPersistent: typeof ORG_PERSISTENT === "undefined" ? false : ORG_PERSISTENT,
    scoreMin: CONV_SCORE_MIN, freshIsPriority: FRESH_IS_PRIORITY, overloadLimit: OVERLOAD_LIMIT,
    matrix: matrix, totals: tot,
    callsToday: { pool: callsPool, trackedCreators: callsScope, countedOwners: callsCounted, priorityOnly: tot.touched },
    agents: Object.values(byAgent).sort(function(a, b){ return b.any - a.any; }),
    agentOptions: Object.keys(allAgents).map(function(id){
      const o = CACHE.owners[id] || {};
      return { id: id, name: o.name || ("Owner " + id), email: o.email || "", active: o.active !== false, n: allAgents[id] };
    }).sort(function(a, b){ return b.n - a.n; })
      .concat(unassignedPool ? [{ id: "none", name: "(unassigned)", email: "", active: false, n: unassignedPool }] : []),
    scope: scoped ? "tracked" : "all",
    agentScope: allowOpts ? { agents: allowOpts.agents.length, creators: allowOpts.creators.length } : null,
    creatorOptions: Object.entries(scoped ? scopedCreators : allCreators).map(function(e){ return { u: e[0], n: e[1] }; })
      .sort(function(a, b){ return b.n - a.n; }).slice(0, 400),
    allCreatorOptions: Object.entries(allCreators).map(function(e){ return { u: e[0], n: e[1] }; })
      .sort(function(a, b){ return b.n - a.n; }).slice(0, 500),
    creators: Object.values(byCreator).sort(function(a, b){ return b.any - a.any; }).slice(0, 400),
    stageGroups: { priority: CN_DEFAULT_STAGES, other: CN_OTHER_STAGES, labels: CN_STAGE_LABELS },
    teamOptions: ((typeof ORG !== "undefined" && ORG.teams) || []).map(function(t){
      return { id: t.id, name: t.name, agents: (t.agentIds || []).length, creators: (t.creators || []).length }; }),
    yesterday: (function(){
      if (typeof ORG === "undefined" || !ORG.daily) return null;
      const keys = Object.keys(ORG.daily).sort();
      const today = istParts(new Date()).date;
      for (let i = keys.length - 1; i >= 0; i--) if (keys[i] < today) return Object.assign({ date: keys[i] }, ORG.daily[keys[i]]);
      return null;
    })(),
    ownerRefreshedAt: req.query.agent ? (OWNER_REFRESH[req.query.agent] || null) : null,
    portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID }
  });
});

app.post("/api/callnow/refresh-owner/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!id || !CACHE.owners[id]) return res.status(400).json({ error: "unknown owner id" });
  const allowR = scopeFor(req);
  if (allowR && allowR.agents.indexOf(id) < 0) return res.status(403).json({ error: "that agent is not on your team" });
  const last = OWNER_REFRESH[id] ? Date.parse(OWNER_REFRESH[id]) : 0;
  if (Date.now() - last < 20000) return res.json({ ok: true, skipped: "cooldown", at: OWNER_REFRESH[id] });
  try {
    const r = await refreshOwner(id);
    res.json(Object.assign({ ok: true, at: OWNER_REFRESH[id] }, r));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/callnow/sync-creator", async (req, res) => {
  const creator = String(req.query.creator || "").trim();
  if (!creator) return res.status(400).json({ error: "creator required" });
  if (PFRESH.syncing) return res.status(409).json({ error: "a creator sync is already running" });
  PFRESH.syncing = true;
  try {
    const from = Date.parse("2020-01-01T00:00:00Z"), to = Date.now() + 86400000;
    const seen = {};
    PFRESH.rows.forEach(function(r){ seen[r.id] = 1; });
    const added = [];
    const stat = await fetchFreshForCreator(creator, from, to, function(r){ if (!seen[r.id]) { seen[r.id] = 1; added.push(r); } });
    PFRESH.rows = PFRESH.rows.filter(function(r){ return (r.topmate_username || "") !== creator; }).concat(added);
    PFRESH.byCreator[creator] = added.length;
    if (!added.length) {
      try {
        const probe = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "topmate_username", operator: "EQ", value: creator }] }],
          properties: ["createdate"], limit: 1 })});
        if (!probe.total) {
          PFRESH.syncing = false;
          if (PFRESH_LIST.indexOf(creator) < 0) delete PFRESH.byCreator[creator];
          return res.status(404).json({ error: "No contacts in HubSpot have topmate_username \"" + creator + "\". Check the exact spelling." });
        }
      } catch (e) {}
    }
    PFRESH.loadedAt = new Date().toISOString();
    if (PFRESH_LIST.indexOf(creator) < 0) PFRESH_LIST.push(creator);
    persistCreators(typeof whoami === "function" ? whoami(req) : "");
    POOL_REV++;
    PFRESH.syncing = false;
    res.json({ ok: true, creator: creator, added: added.length, total: PFRESH.rows.length, creators: PFRESH_LIST,
      truncated: !!(stat && stat.truncated), hubspotTotal: stat ? stat.total : null });
  } catch (e) {
    PFRESH.syncing = false;
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/callnow/drop-creator", (req, res) => {
  const creator = String(req.query.creator || "").trim();
  PFRESH.rows = PFRESH.rows.filter(function(r){ return (r.topmate_username || "") !== creator; });
  delete PFRESH.byCreator[creator];
  PFRESH_LIST = PFRESH_LIST.filter(function(c){ return c !== creator; });
  persistCreators(typeof whoami === "function" ? whoami(req) : "");
  POOL_REV++;
  res.json({ ok: true, creators: PFRESH_LIST, total: PFRESH.rows.length });
});

app.get("/api/callnow/leads", (req, res) => {
  // Bulk lead export is VP only, so hiding the button is not the only thing stopping it.
  if (String(req.query.all || "") === "1" && !isVP(req)) {
    return res.status(403).json({ error: "full list export is restricted" });
  }
  const seg = String(req.query.seg || "any");
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 3000);
  const allowL = scopeFor(req);
  if (allowL) req.query.__scope = allowL;
  let rows = cnFilter(req.query);
  if (req.query.stage) rows = rows.filter(function(r){ return r.stage === req.query.stage; });
  const nowSeg = Date.now();
  rows = rows.filter(function(r){
    const s = cnSegs(r);
    const anyp = s.form || s.score || s.intl || s.fresh;
    if (seg === "form") return s.form;
    if (seg === "score") return s.score;
    if (seg === "intl") return s.intl;
    if (seg === "fresh") return s.fresh;
    if (seg === "uncalled") return anyp && !r.last;
    if (seg === "nofu") return anyp && !r.fu;
    if (seg === "over") return anyp && r.fu && r.fu < nowSeg;
    if (seg === "all") return true;
    return anyp;
  });
  if (String(req.query.uncalled || "") === "1") rows = rows.filter(function(r){ return !r.last; });
  if (String(req.query.backlog || "") === "1") {
    const bn = Date.now();
    rows = rows.filter(function(r){ return !r.fu || r.fu < bn || !r.last; });
  }
  const today = String(req.query.today || "");
  if (today) {
    const d = istDayBounds();
    rows = rows.filter(function(r){
      const ct = r.last >= d.start && r.last < d.end, dt = r.fu >= d.start && r.fu < d.end;
      if (today === "due") return dt;
      if (today === "done") return dt && ct;
      if (today === "missed") return dt && !ct;
      if (today === "touched") return ct;
      if (today === "bwork") return ct && !dt;
      return true;
    });
  }
  const fu = String(req.query.fu || "");
  if (fu) {
    const now = Date.now(), sod = new Date(); sod.setHours(0, 0, 0, 0);
    const eod = sod.getTime() + 86400000;
    rows = rows.filter(function(r){
      if (fu === "overdue") return r.fu && r.fu < now;
      if (fu === "today") return r.fu && r.fu >= sod.getTime() && r.fu < eod;
      if (fu === "none") return !r.fu;
      return true;
    });
  }
  const total = rows.length;
  rows.sort(cnSort);
  res.json({ total: total, shown: Math.min(total, limit), rows: rows.slice(0, limit),
    scoreMin: CONV_SCORE_MIN, portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID } });
});

/* ---------- Google sign-in, restricted to one workspace domain ----------
   Authorization-code flow, no OAuth library. The id_token arrives over TLS
   direct from Google's token endpoint, so decoding it without re-verifying the
   signature is the documented-safe path for this flow. Sessions are a signed
   cookie (HMAC), so nothing needs a database.
   Auth stays OFF until GOOGLE_CLIENT_ID is set, so the app keeps working
   before the env vars land. */
const crypto = require("crypto");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || "topmate.io").toLowerCase();
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const MANAGER_EMAILS = (process.env.MANAGER_EMAILS || "abhishek.pal@topmate.io")
  .split(",").map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
const AUTH_ON = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || "12", 10);

function b64u(buf){ return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64u(str){ return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
function sign(payload){
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac("sha256", SESSION_SECRET).update(body).digest());
  return body + "." + mac;
}
function verify(token){
  if (!token || token.indexOf(".") < 0) return null;
  const parts = token.split(".");
  const expect = b64u(crypto.createHmac("sha256", SESSION_SECRET).update(parts[0]).digest());
  const a = Buffer.from(parts[1] || ""), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(unb64u(parts[0]));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
function readCookie(req, name){
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map(function(x){ return x.trim(); })
    .filter(function(x){ return x.indexOf(name + "=") === 0; })[0];
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}
function baseUrl(req){
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return proto + "://" + req.headers.host;
}
function ownerIdForEmail(email){
  const e = String(email || "").toLowerCase();
  const ids = Object.keys(CACHE.owners || {});
  for (const id of ids) {
    if (String((CACHE.owners[id] || {}).email || "").toLowerCase() === e) return id;
  }
  return "";
}
function sessionOf(req){
  if (!AUTH_ON) return { email: "", name: "Open access", role: "manager", ownerId: "" };
  const p = verify(readCookie(req, "cn_session"));
  if (!p) return null;
  const em = String(p.email).toLowerCase();
  const vps = (process.env.VP_EMAILS || "").split(",").map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);
  // Anyone set as the manager of a team gets manager access automatically. Without this
  // you would have to add every manager to MANAGER_EMAILS as well, and a missed entry
  // silently demotes them to agent and locks them out of their own dashboard.
  const leadsTeam = ((typeof ORG !== "undefined" && ORG.teams) || []).some(function(t){
    return String(t.managerEmail || "").toLowerCase() === em;
  });
  const role = (MANAGER_EMAILS.indexOf(em) >= 0 || vps.indexOf(em) >= 0 || leadsTeam) ? "manager" : "agent";
  return { email: p.email, name: p.name || p.email, role: role, ownerId: role === "agent" ? ownerIdForEmail(p.email) : "" };
}

app.get("/auth/login", function(req, res){
  if (!AUTH_ON) return res.redirect("/");
  const state = sign({ n: crypto.randomBytes(8).toString("hex"), exp: Date.now() + 10 * 60 * 1000 });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", baseUrl(req) + "/auth/callback");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("hd", ALLOWED_DOMAIN);
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", state);
  res.redirect(u.toString());
});

app.get("/auth/callback", async function(req, res){
  if (!AUTH_ON) return res.redirect("/");
  if (!verify(String(req.query.state || ""))) return res.status(400).send("Sign-in expired. <a href='/auth/login'>Try again</a>");
  try {
    const body = new URLSearchParams({
      code: String(req.query.code || ""),
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: baseUrl(req) + "/auth/callback",
      grant_type: "authorization_code"
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString()
    });
    const j = await r.json();
    if (!j.id_token) return res.status(401).send("Sign-in failed. <a href='/auth/login'>Try again</a>");
    const claims = JSON.parse(unb64u(j.id_token.split(".")[1]));
    const email = String(claims.email || "").toLowerCase();
    const domainOk = String(claims.hd || "").toLowerCase() === ALLOWED_DOMAIN || email.endsWith("@" + ALLOWED_DOMAIN);
    if (!claims.email_verified || !domainOk) {
      return res.status(403).send("<p style='font:14px -apple-system;padding:40px'>Only @" + ALLOWED_DOMAIN +
        " accounts can open this dashboard. You signed in as " + email + ". <a href='/auth/login'>Use a different account</a></p>");
    }
    const token = sign({ email: email, name: claims.name || email, exp: Date.now() + SESSION_HOURS * 3600000 });
    res.setHeader("Set-Cookie", "cn_session=" + encodeURIComponent(token) +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + (SESSION_HOURS * 3600));
    res.redirect("/callnow.html");
  } catch (e) {
    res.status(500).send("Sign-in error: " + e.message);
  }
});

app.get("/auth/logout", function(req, res){
  res.setHeader("Set-Cookie", "cn_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.redirect("/login.html");
});

app.get("/api/me", function(req, res){
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: "not signed in" });
  // Role alone cannot tell a manager from a VP, since both carry role "manager".
  // Pages that gate a control need the distinction, so say it plainly.
  res.json({ email: s.email, name: s.name, role: s.role, ownerId: s.ownerId, authOn: AUTH_ON,
    isVP: isVP(req), domain: ALLOWED_DOMAIN, managers: MANAGER_EMAILS });
});

// Gate every page and API call. Agents are forced onto their own owner id, so a
// hand-edited ?agent= in the URL cannot widen their view. Registered at the very
// top of the stack (see app.use(authGate) above) so it runs before any route.
function authGate(req, res, next){
  if (!AUTH_ON) return next();
  const p = req.path;
  // /api/health must stay open: Railway's healthcheck has no session, and a 401 there
  // makes the platform mark the deploy unhealthy and stop serving the app entirely.
  if (p.indexOf("/auth/") === 0 || p === "/login.html" || p === "/favicon.ico" || p === "/api/health") return next();
  const s = sessionOf(req);
  if (!s) {
    if (p === "/api/me") return res.json({ authOn: true, email: "", role: "", domain: ALLOWED_DOMAIN });
    if (p.indexOf("/api/") === 0) return res.status(401).json({ error: "not signed in" });
    return res.redirect("/login.html");
  }
  req.session = s;
  // v2 is scoped per role like v1, so an agent opening it sees their own leads only.
  if (s.role === "agent") {
    if (!s.ownerId && p.indexOf("/api/") === 0) {
      return res.status(403).json({ error: "no HubSpot lead owner matches " + s.email });
    }
    if (p.indexOf("/api/") === 0) {
      req.query.agent = s.ownerId;
      req.query.owner = s.ownerId;
      // Rewriting the query is not enough: several routes take the owner id in the path,
      // so without this an agent could read a colleague's snapshot, drill or coaching
      // record just by editing the URL.
      const OWNED = [/^\/api\/agent\/([^\/]+)/, /^\/api\/drill\/([^\/]+)/,
        /^\/api\/coaching\/agent\/([^\/]+)/, /^\/api\/callnow\/refresh-owner\/([^\/]+)/];
      for (let i = 0; i < OWNED.length; i++) {
        const m = p.match(OWNED[i]);
        if (m && String(m[1]) !== String(s.ownerId)) {
          return res.status(403).json({ error: "you can only see your own leads" });
        }
      }
      // Manager and VP surfaces are closed to agents outright.
      if (p.indexOf("/api/vp") === 0 || p.indexOf("/api/coaching") === 0) {
        if (p.indexOf("/api/coaching/agent/") !== 0) {
          return res.status(403).json({ error: "manager access only" });
        }
      }
    }
    // agents only get the call list and their own snapshot
    const allowed = ["/callnow.html", "/callnow2.html", "/agent.html", "/login.html", "/"];
    if (p.indexOf("/api/") !== 0 && allowed.indexOf(p) < 0 && p.endsWith(".html")) return res.redirect("/callnow.html");
    if (p === "/") return res.redirect("/callnow.html");
  }
  next();
}

/* ---------- Org store: teams, targets, benchmarks ----------
   The only state this app owns. HubSpot has no concept of a creator belonging to a
   manager, nor of a monthly target, so it lives here. Written to a JSON file on a
   Railway volume; if no writable volume is mounted it degrades to memory and says so
   loudly, rather than pretending to persist. */
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.DATA_DIR || "/data";
const ORG_FILE = path.join(DATA_DIR, "org.json");
const VP_EMAILS = (process.env.VP_EMAILS || process.env.MANAGER_EMAILS || "abhishek.pal@topmate.io")
  .split(",").map(function(x){ return x.trim().toLowerCase(); }).filter(Boolean);

let ORG = { teams: [], targets: {}, benchmarks: { creators: {}, company: {} }, log: [] };
let ORG_PERSISTENT = false;

function orgLoad(){
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    ORG_PERSISTENT = true;
    if (fs.existsSync(ORG_FILE)) {
      const j = JSON.parse(fs.readFileSync(ORG_FILE, "utf8"));
      ORG = Object.assign({ teams: [], targets: {}, benchmarks: { creators: {}, company: {} }, log: [] }, j);
    }
    console.log("Org store ready at " + ORG_FILE + " (" + ORG.teams.length + " teams)");
  } catch (e) {
    ORG_PERSISTENT = false;
    console.error("Org store NOT persistent (" + e.message + "). Attach a Railway volume at " + DATA_DIR + ".");
  }
}
function orgSave(action, detail, who){
  ORG.log = (ORG.log || []).concat([{ at: new Date().toISOString(), by: who || "", action: action, detail: detail || "" }]).slice(-500);
  if (!ORG_PERSISTENT) return false;
  try {
    const tmp = ORG_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ORG, null, 2));
    fs.renameSync(tmp, ORG_FILE);
    return true;
  } catch (e) { console.error("Org save failed: " + e.message); return false; }
}
orgLoad();

function isVP(req){
  if (!AUTH_ON) return true;
  const s = req.session || sessionOf(req);
  return !!(s && VP_EMAILS.indexOf(String(s.email).toLowerCase()) >= 0);
}
function whoami(req){ const s = req.session || sessionOf(req); return s ? s.email : ""; }
function newId(){ return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function curMonth(){
  const p = istParts(new Date());
  return p.date.slice(0, 7);
}

// Every owner that holds leads but sits in no team. Without this the roll-up
// silently under-reports the moment someone joins.
function orgDrift(){
  const mapped = {};
  (ORG.teams || []).forEach(function(t){ (t.agentIds || []).forEach(function(id){ mapped[id] = t.name; }); });
  const out = [];
  const counts = {};
  callnowPool().forEach(function(c){
    const oid = String(c.hubspot_owner_id || "");
    if (oid) counts[oid] = (counts[oid] || 0) + 1;
  });
  Object.keys(CACHE.owners || {}).forEach(function(id){
    const o = CACHE.owners[id];
    if (mapped[id]) return;
    const n = counts[id] || 0;
    if (o.active === false) return;
    out.push({ id: id, name: o.name, email: o.email, active: true, leads: n });
  });
  return out.sort(function(a, b){ return b.leads - a.leads; });
}

// One pass over the sheet and one over the lead pool, bucketed by team, creator and
// agent. Doing it per team would mean re-walking a 50k row pool for every manager.
/* Daily snapshot. Today's counters reset at IST midnight, so without this there is no
   way to answer "how many of the 789 score-6 leads did we work yesterday". Stored in the
   org store on the volume, 90 days kept. */
function snapCounters(){
  return { pool: 0, form: 0, score: 0, intl: 0, fresh: 0, due: 0, done: 0, missed: 0, calls: 0,
    formC: 0, scoreC: 0, intlC: 0, freshC: 0, overdue: 0, overdueC: 0,
    needs: 0, needsC: 0, uncalled: 0, uncalledC: 0, counsellings: 0,
    revenue: 0, enrolments: 0, audits: 0, auditTarget: 0 };
}
function snapAdd(o, r, sg, called, day, fromU){
  o.pool++;
  if (called) o.calls++;
  if (sg.form) { o.form++; if (called) o.formC++; }
  if (sg.score) { o.score++; if (called) o.scoreC++; }
  if (sg.intl) { o.intl++; if (called) o.intlC++; }
  if (sg.fresh) { o.fresh++; if (called) o.freshC++; }
  if (r.needsOwner) { o.needs++; if (called) o.needsC++; }
  // Never-called is the one bucket that calling destroys: dial the lead and it leaves.
  // So the count is who is still uncalled, and the worked figure comes from the id set
  // frozen at the opening bell, which is the only exact way to answer it.
  if (!r.last) o.uncalled++;
  if (fromU) o.uncalledC++;
  // Overdue means carried in from a previous day. Using "before now" instead would let
  // a follow-up due at 11am become overdue at 11:01 and inflate the bucket through the
  // day, and it would also double-count against today's missed.
  if (r.fu && r.fu < day.start) { o.overdue++; if (called) o.overdueC++; }
  if (r.fu >= day.start && r.fu < day.end) { o.due++; if (called) o.done++; else o.missed++; }
}
/* Midnight, matching Call Now v2. A baseline taken at 09:30 quietly discards every call
   made before the floor's official start, and it made the two pages disagree with each
   other. The name stays OPEN_HM so an override already set in Railway still works. */
const OPEN_HM = process.env.OPEN_HM || "00:05";
// Bumped whenever the meaning of a counter changes. A day frozen under an older
// definition is refrozen rather than carried forward, otherwise a denominator captured
// under the old scope would silently poison the whole day.
const SNAP_VERSION = 2;
function snapshotToday(){
  if (typeof ORG === "undefined" || !CACHE.loadedAt) return;
  // Staged leads are now published before the fresh pull finishes, so "loaded" no longer
  // means "complete". Freezing a day's denominator against a half-built pool would be
  // wrong for the rest of that day and would look authoritative.
  if (CACHE.syncing) return;
  const day = istDayBounds();
  const key = istParts(new Date()).date;
  const teamOf = {}, teamName = {};
  (ORG.teams || []).forEach(function(t){
    teamName[t.id] = t.name || "(unnamed)";
    (t.agentIds || []).forEach(function(id){ teamOf[String(id)] = t.id; });
  });
  const total = snapCounters(), teams = {}, agents = {};
  // The filters below are deliberately identical to vpAggregate, which is what draws the
  // Call Now queue on Overview. If the two ever drift, the daily review stops being a
  // review of that queue and becomes a second, competing number.
  const stored = (ORG.daily || {})[key];
  const prev0 = (stored && stored.sv === SNAP_VERSION) ? stored : null;
  const prevU = (prev0 && Array.isArray(prev0.openU)) ? prev0.openU.reduce(function(m, id){ m[id] = 1; return m; }, {}) : null;
  const nowU = [];
  callnowPool().forEach(function(c){
    const aid = String(c.hubspot_owner_id || "");
    const tid = teamOf[aid];
    if (!tid) return;
    if (!ownerCounted(aid)) return;
    const r = cnRow(c), sg = cnSegs(r);
    if (!(sg.form || sg.score || sg.intl || sg.fresh)) return;
    const called = r.last >= day.start && r.last < day.end;
    if (!r.last) nowU.push(c.id);
    const fromU = !!(prevU && prevU[c.id] && called);
    snapAdd(total, r, sg, called, day, fromU);
    if (!teams[tid]) teams[tid] = Object.assign({ name: teamName[tid] }, snapCounters());
    snapAdd(teams[tid], r, sg, called, day, fromU);
    if (r.owner) {
      if (!agents[r.owner]) agents[r.owner] = Object.assign({ name: r.ownerName, team: teamName[tid] }, snapCounters());
      snapAdd(agents[r.owner], r, sg, called, day, fromU);
    }
    const cts = COUNSEL.byId[c.id];
    if (cts && ts(cts) >= day.start && ts(cts) < day.end) {
      total.counsellings++;
      teams[tid].counsellings++;
      if (r.owner && agents[r.owner]) agents[r.owner].counsellings++;
    }
  });
  const emailTeam = {}, emailAgent = {};
  Object.keys(teamOf).forEach(function(id){
    const e = String(((CACHE.owners[id] || {}).email) || "").toLowerCase();
    if (e) { emailTeam[e] = teamOf[id]; emailAgent[e] = id; }
  });
  const seen = {};
  (SHEET.rows || []).forEach(function(r){
    if (String(r.date || "").slice(0, 10) !== key) return;
    const v = num(r.price_inr);
    total.revenue += v;
    const k = String(r.consumer_email || "").toLowerCase() + "|" + (r.creator_username || "");
    const isNew = !seen[k];
    if (isNew) { seen[k] = 1; total.enrolments++; }
    const oe = String(r.owner_email || "").toLowerCase();
    const tid = emailTeam[oe], aid = emailAgent[oe];
    if (tid) { if (!teams[tid]) teams[tid] = Object.assign({ name: teamName[tid] }, snapCounters());
      teams[tid].revenue += v; if (isNew) teams[tid].enrolments++; }
    if (aid) { if (!agents[aid]) agents[aid] = Object.assign({ name: (CACHE.owners[aid] || {}).name || aid, team: tid ? teamName[tid] : "" }, snapCounters());
      agents[aid].revenue += v; if (isNew) agents[aid].enrolments++; }
  });
  /* The denominator moves all day: leads enter the pool, stages change, and an agent who
     pushes a follow-up to tomorrow quietly removes it from today's due list. Measuring
     end-of-day work against an end-of-day denominator would therefore flatter everyone.
     So the opening position is frozen at the first capture on or after OPEN_HM and never
     rewritten. Work counts keep updating to close of day, denominators do not. */
  // Audit compliance is a fact about the day, not a point-in-time state, so it is stamped
  // on every capture and the last one of the day is the final figure.
  const au = (typeof coachDayDetail === "function") ? coachDayDetail(key) : { teams: {}, agents: {} };
  Object.keys(au.teams || {}).forEach(function(id){
    const a = au.teams[id];
    total.audits += a.done; total.auditTarget += a.target;
    if (teams[id]) { teams[id].audits = a.done; teams[id].auditTarget = a.target; }
  });
  Object.keys(agents).forEach(function(id){
    const a = (au.agents || {})[id];
    if (a) { agents[id].audits = a.done; agents[id].auditTarget = a.due; }
  });
  ORG.daily = ORG.daily || {};
  const prev = prev0;
  const now = istParts(new Date()).hm;
  const freeze = function(dst, src){
    dst.oPool = src.pool; dst.oDue = src.due; dst.oScore = src.score; dst.oForm = src.form;
    dst.oIntl = src.intl; dst.oFresh = src.fresh; dst.oOverdue = src.overdue;
    dst.oNeeds = src.needs; dst.oUncalled = src.uncalled;
  };
  const carry = function(dst, src){
    if (!src || src.oPool == null) return false;
    dst.oPool = src.oPool; dst.oDue = src.oDue; dst.oScore = src.oScore; dst.oForm = src.oForm;
    dst.oIntl = src.oIntl; dst.oFresh = src.oFresh; dst.oOverdue = src.oOverdue;
    dst.oNeeds = src.oNeeds; dst.oUncalled = src.oUncalled;
    return true;
  };
  let openAt = prev && prev.openAt ? prev.openAt : null;
  if (openAt) {
    carry(total, prev);
    Object.keys(teams).forEach(function(k){ carry(teams[k], (prev.teams || {})[k]); });
    Object.keys(agents).forEach(function(k){ carry(agents[k], (prev.agents || {})[k]); });
  } else if (now >= OPEN_HM) {
    openAt = now;
    freeze(total, total);
    Object.keys(teams).forEach(function(k){ freeze(teams[k], teams[k]); });
    Object.keys(agents).forEach(function(k){ freeze(agents[k], agents[k]); });
  }
  const openU = openAt
    ? (prev0 && Array.isArray(prev0.openU) ? prev0.openU : nowU)
    : null;
  ORG.daily[key] = Object.assign({ at: new Date().toISOString(), sv: SNAP_VERSION, openAt: openAt,
    openU: openU, teams: teams, agents: agents }, total);
  // The id set is only needed while the day is running. Dropping it from older days keeps
  // the store small enough to rewrite every fifteen minutes.
  Object.keys(ORG.daily).forEach(function(k){ if (k !== key && ORG.daily[k]) delete ORG.daily[k].openU; });
  const keys = Object.keys(ORG.daily).sort();
  while (keys.length > 90) { delete ORG.daily[keys.shift()]; }
  if (typeof orgSave === "function") orgSave("snapshot", key, "system");
  // Total must equal the sum of the teams, because only team-mapped owners are counted.
  // If that ever stops being true the daily review has drifted from the Call Now queue.
  const sum = Object.keys(teams).reduce(function(n, k){ return n + teams[k].pool; }, 0);
  if (sum !== total.pool) {
    console.error("Snapshot drift on " + key + ": total pool " + total.pool + " vs team sum " + sum);
  }
}

/* Backfill for a day that finished before the snapshot job existed. Only what HubSpot and
   the sheet still remember can be rebuilt: call attempts and connects from the call
   objects, which keep their own timestamp, counselling entries from stage history, and
   revenue from the dated payment sheet. Pool size, follow-ups due and follow-ups missed
   were point-in-time states that HubSpot has since overwritten, so they stay null and the
   page says as much rather than showing a zero that reads like a real zero. */
function istBoundsFor(key){
  const off = 5.5 * 3600000;
  const start = Date.parse(key + "T00:00:00Z") - off;
  return { start: start, end: start + 86400000 };
}
function backCounters(){
  return { pool: null, form: null, score: null, intl: null, fresh: null,
    due: null, done: null, missed: null, overdue: null, overdueC: null,
    formC: null, scoreC: null, intlC: null, freshC: null, calls: null,
    needs: null, needsC: null, uncalled: null, uncalledC: null,
    attempts: 0, connected: 0, counsellings: 0, revenue: 0, enrolments: 0,
    audits: 0, auditTarget: 0 };
}
async function snapBackfill(key){
  if (typeof ORG === "undefined" || !TOKEN || !CACHE.loadedAt || CACHE.syncing) return;
  ORG.daily = ORG.daily || {};
  if (ORG.daily[key]) return; // a live snapshot, or an earlier backfill, already covers it
  if (!COUNSEL.loadedAt || !SHEET.loadedAt) return; // retried hourly until both are in
  if (key >= istParts(new Date()).date) return; // never backfill a day still in progress
  const day = istBoundsFor(key);
  if (!Object.keys(CALLS.dispositions).length) {
    try {
      const d = await hs("/calling/v1/dispositions");
      (Array.isArray(d) ? d : (d.results || [])).forEach(function(x){ CALLS.dispositions[x.id] = x.label; });
    } catch (e) { console.error("backfill dispositions: " + e.message); }
  }
  const teamOf = {}, teamName = {};
  (ORG.teams || []).forEach(function(t){
    teamName[t.id] = t.name || "(unnamed)";
    (t.agentIds || []).forEach(function(id){ teamOf[String(id)] = t.id; });
  });
  const total = backCounters(), teams = {}, agents = {};
  function teamBucket(tid){
    if (!teams[tid]) teams[tid] = Object.assign({ name: teamName[tid] }, backCounters());
    return teams[tid];
  }
  function agentBucket(aid, nm){
    if (!agents[aid]) agents[aid] = Object.assign({ name: nm || ((CACHE.owners[aid] || {}).name) || aid,
      team: teamOf[aid] ? teamName[teamOf[aid]] : "" }, backCounters());
    return agents[aid];
  }
  await fetchCallsRange(day.start, day.end, function(p){
    const aid = String(p.hubspot_owner_id || "");
    if (!ownerCounted(aid)) return;
    const label = CALLS.dispositions[p.hs_call_disposition] || p.hs_call_disposition || "";
    const conn = /connected/i.test(label) ? 1 : 0;
    total.attempts++; total.connected += conn;
    const tid = teamOf[aid];
    if (tid) { const b = teamBucket(tid); b.attempts++; b.connected += conn; }
    if (aid) { const b = agentBucket(aid); b.attempts++; b.connected += conn; }
  });
  // Counsellings, filtered exactly as the live snapshot filters them so the two are
  // comparable side by side in the date picker.
  callnowPool().forEach(function(c){
    const aid = String(c.hubspot_owner_id || "");
    if (!teamOf[aid] || !ownerCounted(aid)) return;
    const r = cnRow(c), sg = cnSegs(r);
    if (!(sg.form || sg.score || sg.intl || sg.fresh)) return;
    const cts = COUNSEL.byId[c.id];
    if (!cts) return;
    const t = ts(cts);
    if (!(t >= day.start && t < day.end)) return;
    total.counsellings++;
    const tid = teamOf[r.owner];
    if (tid) teamBucket(tid).counsellings++;
    if (r.owner) agentBucket(r.owner, r.ownerName).counsellings++;
  });
  const emailTeam = {}, emailAgent = {};
  Object.keys(teamOf).forEach(function(id){
    const e = String(((CACHE.owners[id] || {}).email) || "").toLowerCase();
    if (e) { emailTeam[e] = teamOf[id]; emailAgent[e] = id; }
  });
  const seen = {};
  (SHEET.rows || []).forEach(function(r){
    if (String(r.date || "").slice(0, 10) !== key) return;
    const v = num(r.price_inr);
    total.revenue += v;
    const k = String(r.consumer_email || "").toLowerCase() + "|" + (r.creator_username || "");
    const isNew = !seen[k];
    if (isNew) { seen[k] = 1; total.enrolments++; }
    const oe = String(r.owner_email || "").toLowerCase();
    const tid = emailTeam[oe], aid = emailAgent[oe];
    if (tid) { const b = teamBucket(tid); b.revenue += v; if (isNew) b.enrolments++; }
    if (aid) { const b = agentBucket(aid); b.revenue += v; if (isNew) b.enrolments++; }
  });
  const au = (typeof coachDayDetail === "function") ? coachDayDetail(key) : { teams: {}, agents: {} };
  Object.keys(au.teams || {}).forEach(function(id){
    const a = au.teams[id];
    total.audits += a.done; total.auditTarget += a.target;
    const b = teamBucket(id);
    b.audits = a.done; b.auditTarget = a.target;
  });
  Object.keys(agents).forEach(function(id){
    const a = (au.agents || {})[id];
    if (a) { agents[id].audits = a.done; agents[id].auditTarget = a.due; }
  });
  ORG.daily[key] = Object.assign({ at: new Date().toISOString(), sv: SNAP_VERSION, backfilled: true,
    teams: teams, agents: agents }, total);
  const keys = Object.keys(ORG.daily).sort();
  while (keys.length > 90) { delete ORG.daily[keys.shift()]; }
  if (typeof orgSave === "function") orgSave("backfill", key, "system");
  console.log("Backfilled " + key + ": " + total.attempts + " attempts, " +
    total.counsellings + " counsellings, " + Math.round(total.revenue) + " revenue");
}
function yesterdayKey(){ return istParts(new Date(Date.now() - 86400000)).date; }

function vpAggregate(month){
  const teamOf = {}, agentTeam = {};
  (ORG.teams || []).forEach(function(t){
    (t.agentIds || []).forEach(function(id){ teamOf[id] = t.id; });
  });
  const byEmail = {};
  Object.keys(teamOf).forEach(function(id){
    const e = String(((CACHE.owners[id] || {}).email) || "").toLowerCase();
    if (e) byEmail[e] = id;
  });
  const agg = {};
  const cell = function(tid, creator, agentId){
    if (!agg[tid]) agg[tid] = {};
    if (!agg[tid][creator]) agg[tid][creator] = {};
    if (!agg[tid][creator][agentId]) agg[tid][creator][agentId] = {
      revenue: 0, enrolments: 0, queue: 0, due: 0, done: 0, missed: 0, overdue: 0, uncalled: 0, touched: 0,
      churned: 0, worked: 0, counsellings: 0, created: 0, cohortCounselled: 0, risk: 0,
      form: 0, score: 0, intl: 0, needs: 0, counsToday: 0,
      queueT: 0, formT: 0, scoreT: 0, intlT: 0, needsT: 0, overdueT: 0
    };
    return agg[tid][creator][agentId];
  };
  const seen = {};
  (SHEET.rows || []).forEach(function(r){
    if (ymOf(r.date) !== month) return;
    const aid = byEmail[String(r.owner_email || "").toLowerCase()];
    if (!aid) return;
    const o = cell(teamOf[aid], r.creator_username || "(no creator)", aid);
    o.revenue += num(r.price_inr);
    const k = String(r.consumer_email || "").toLowerCase() + "|" + (r.creator_username || "");
    if (!seen[k]) { seen[k] = 1; o.enrolments++; }
  });
  const day = istDayBounds(), now = Date.now();
  callnowPool().forEach(function(c){
    const aid = String(c.hubspot_owner_id || "");
    const tid = teamOf[aid];
    if (!tid) return;
    // Parking buckets and managers hold piles that are not a working queue. Their revenue
    // still counts, their leads do not, otherwise a manager's own bucket swamps the team.
    if (typeof ownerCounted === "function" && !ownerCounted(aid)) return;
    const r = cnRow(c), sg = cnSegs(r);
    const o = cell(tid, r.creator || "(no creator)", aid);
    // first-counselled month, attributed to the lead's current owner, same rule as elsewhere
    const cts = COUNSEL.byId[c.id];
    if (ymOf(cts) === month) o.counsellings++;
    if (cts && ts(cts) >= day.start && ts(cts) < day.end) o.counsToday++;
    // L2C cohort: leads created this month, and how many of them ever reached counselling
    if (ymOf(c.createdate) === month) { o.created++; if (COUNSEL.byId[c.id]) o.cohortCounselled++; }
    // revenue at risk: a payment prospect whose follow-up has already lapsed
    if (r.stage === "payment_prospect" && r.fu && r.fu < now) o.risk++;
    if (CHURN.indexOf(r.stage) >= 0) { o.churned++; o.worked++; }
    else if (r.stage !== "__fresh") o.worked++;
    if (!(sg.form || sg.score || sg.intl || sg.fresh)) return;
    o.queue++;
    // "coverage": how much of each segment has been called today
    const ct0 = r.last >= day.start && r.last < day.end;
    if (ct0) o.queueT++;
    if (sg.form) { o.form++; if (ct0) o.formT++; }
    if (sg.score) { o.score++; if (ct0) o.scoreT++; }
    if (sg.intl) { o.intl++; if (ct0) o.intlT++; }
    if (r.needsOwner) { o.needs++; if (ct0) o.needsT++; }
    if (r.fu && r.fu < now && ct0) o.overdueT++;
    const ct = r.last >= day.start && r.last < day.end, dt = r.fu >= day.start && r.fu < day.end;
    if (ct) o.touched++;
    if (dt) { o.due++; if (ct) o.done++; else o.missed++; }
    if (r.fu && r.fu < now) o.overdue++;
    if (!r.last) o.uncalled++;
  });
  return agg;
}
function zero(){ return { revenue: 0, enrolments: 0, queue: 0, due: 0, done: 0, missed: 0, overdue: 0, uncalled: 0, touched: 0, churned: 0, worked: 0, counsellings: 0, created: 0, cohortCounselled: 0, risk: 0, form: 0, score: 0, intl: 0, needs: 0, counsToday: 0, queueT: 0, formT: 0, scoreT: 0, intlT: 0, needsT: 0, overdueT: 0 }; }
function addInto(a, b){ Object.keys(b).forEach(function(k){ if (typeof b[k] === "number") a[k] = (a[k] || 0) + b[k]; }); return a; }

// Revenue booked in the last 7 days against the 7 before, for the teams in scope.
/* Last month, truncated to the same day of month.
   Comparing day 21 against a finished month is the most common way a dashboard
   lies to you: every metric looks down until the last week, then jumps. Every
   chip on the Overview strip therefore compares like with like, month to date
   against month to date.

   Scope is the set of owner ids the caller can see, so a manager's chip reflects
   their team rather than the company. Pass null for everything. */
function vpPriorMonth(month, dom, ownerIds){
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const pm = m === 1 ? { y: y - 1, m: 12 } : { y: y, m: m - 1 };
  const key = pm.y + "-" + ("0" + pm.m).slice(-2);
  // February cannot be compared on the 31st, so clamp to that month's length.
  const pdim = new Date(pm.y, pm.m, 0).getDate();
  const cut = Math.min(dom, pdim);
  const endMs = Date.parse(key + "-" + ("0" + cut).slice(-2) + "T23:59:59+05:30");

  const scope = ownerIds ? {} : null;
  const emails = ownerIds ? {} : null;
  if (ownerIds) {
    ownerIds.forEach(function(id){
      scope[String(id)] = 1;
      const e = String(((CACHE.owners[String(id)] || {}).email) || "").toLowerCase();
      if (e) emails[e] = 1;
    });
  }

  let revenue = 0, enrolments = 0;
  const seen = {};
  (SHEET.rows || []).forEach(function(r){
    const d = String(r.date || "").slice(0, 10);
    if (d.slice(0, 7) !== key) return;
    if (Number(d.slice(8, 10)) > cut) return;
    if (emails && !emails[String(r.owner_email || "").toLowerCase()]) return;
    revenue += num(r.price_inr);
    const k = String(r.consumer_email || "").toLowerCase() + "|" + (r.creator_username || "");
    if (!seen[k]) { seen[k] = 1; enrolments++; }
  });

  let counsellings = 0, created = 0, cohortCounselled = 0;
  (CACHE.contacts || []).forEach(function(c){
    if (scope && !scope[String(c.hubspot_owner_id || "")]) return;
    const cts = COUNSEL.byId[c.id];
    const ct = cts ? ts(cts) : 0;
    if (ct && ymOf(cts) === key && ct <= endMs) counsellings++;
    const cr = ts(c.createdate);
    if (cr && ymOf(c.createdate) === key && cr <= endMs) {
      created++;
      // Same cohort rule as the live L2C: created in the month, reached counselling
      // by the same point in that month.
      if (ct && ct <= endMs) cohortCounselled++;
    }
  });

  return { month: key, throughDay: cut, revenue: Math.round(revenue), enrolments: enrolments,
    counsellings: counsellings, created: created, cohortCounselled: cohortCounselled,
    c2e: counsellings ? Math.round(1000 * enrolments / counsellings) / 10 : null,
    l2c: created ? Math.round(1000 * cohortCounselled / created) / 10 : null,
    ticket: enrolments ? Math.round(revenue / enrolments) : 0 };
}

function weekTrend(teamAgentEmails){
  const now = Date.now(), d7 = now - 7 * 86400000, d14 = now - 14 * 86400000;
  let cur = 0, prev = 0;
  (SHEET.rows || []).forEach(function(r){
    const oe = String(r.owner_email || "").toLowerCase();
    if (teamAgentEmails && !teamAgentEmails[oe]) return;
    const t = ts(r.date);
    if (!t) return;
    if (t >= d7 && t <= now) cur += num(r.price_inr);
    else if (t >= d14 && t < d7) prev += num(r.price_inr);
  });
  return { current: Math.round(cur), previous: Math.round(prev),
    delta: prev ? Math.round(1000 * (cur - prev) / prev) / 10 : null };
}

// Revenue in the sheet that no mapped agent owns. Without this the hero tile looks
// like company revenue when it is only the mapped share, and the gap is invisible.
function unattributed(month){
  const mapped = {};
  (ORG.teams || []).forEach(function(t){
    (t.agentIds || []).forEach(function(id){
      const e = String(((CACHE.owners[id] || {}).email) || "").toLowerCase();
      if (e) mapped[e] = 1;
    });
  });
  let all = 0, miss = 0, rows = 0;
  const by = {};
  (SHEET.rows || []).forEach(function(r){
    if (ymOf(r.date) !== month) return;
    const v = num(r.price_inr);
    all += v;
    const oe = String(r.owner_email || "").trim().toLowerCase();
    if (mapped[oe]) return;
    miss += v; rows++;
    const key = oe || ("(no owner email) " + (r.sales_rep || ""));
    by[key] = (by[key] || 0) + v;
  });
  return { all: Math.round(all), missing: Math.round(miss), rows: rows,
    top: Object.entries(by).map(function(e){ return { who: e[0], revenue: Math.round(e[1]) }; })
      .sort(function(a, b){ return b.revenue - a.revenue; }).slice(0, 12) };
}

const CALLOUT_HOUR = parseInt(process.env.CALLOUT_HOUR || "12", 10);
function vpExceptions(teams, drift, dom, dim){
  const out = [];
  const nowHM = istParts(new Date()).hm;
  const afterHour = Number(String(nowHM).slice(0, 2)) >= CALLOUT_HOUR;
  const add = function(level, kind, team, text){ out.push({ level: level, kind: kind, team: team || "", text: text }); };
  teams.forEach(function(t){
    if (!t.target) { add("warn", "Target", t.name, "No revenue target set for this month."); }
    else if (t.gap < 0 && Math.abs(t.gap) > t.target * 0.05) {
      add("bad", "Pace", t.name, "Behind pace by " + Math.round(-t.gap).toLocaleString("en-IN") +
        " rupees, " + (t.attainment || 0) + "% attained on day " + dom + " of " + dim + ".");
    }
    if (afterHour && t.due >= 10 && t.done / t.due < 0.5) {
      add("bad", "Effort", t.name, t.done + " of " + t.due + " due calls made today, " + t.missed + " still outstanding.");
    } else if (afterHour && t.missed > 0) {
      add("warn", "Missed", t.name, t.missed + " follow-ups due today have not been called.");
    }
    if (t.worked >= 50 && t.churned / t.worked > 0.6) {
      add("bad", "Quality", t.name, Math.round(100 * t.churned / t.worked) + "% of worked leads are disqualified, not interested or ghosted.");
    }
    if (t.uncalled > 500) {
      add("warn", "Idle", t.name, t.uncalled.toLocaleString("en-IN") + " priority leads have never been called.");
    }
    // Effort and idle flags are meaningless at 9am, when nobody has called anyone yet.
    // They only start firing after CALLOUT_HOUR so the card is not noise all morning.
    (t.agentRows || []).forEach(function(a){
      if (afterHour) {
        if (a.due >= 3 && a.done === 0) {
          add("bad", "Effort", t.name, a.name + " has made none of " + a.due + " due calls today.");
        } else if (a.missed >= 3) {
          add("warn", "Missed", t.name, a.name + " made " + a.done + " of " + a.due + " due calls, " + a.missed + " outstanding.");
        }
        if (a.queue >= 50 && a.touched === 0) {
          add("warn", "Idle", t.name, a.name + " has made no calls today with " + a.queue.toLocaleString("en-IN") + " in the queue.");
        }
      }
      if (a.needs >= 5) {
        add("warn", "Mapping", t.name, a.needs + " of " + a.name + "'s priority leads have no owner or a deactivated one.");
      }
    });
    const sum = (t.creatorRows || []).reduce(function(a, c){ return a + (c.target || 0); }, 0);
    if (t.target && sum && Math.abs(sum - t.target) > 1) {
      add("warn", "Targets", t.name, "Creator targets add up to " + Math.round(sum).toLocaleString("en-IN") +
        " against a team target of " + Math.round(t.target).toLocaleString("en-IN") + ".");
    }
  });
  if (arguments.length > 4 && arguments[4] && arguments[4].missing > 0) {
    const u = arguments[4];
    add("bad", "Revenue", "", Math.round(u.missing).toLocaleString("en-IN") + " rupees across " + u.rows +
      " payments is not counted above, because the agent who booked it is not mapped to any team.");
  }
  const dLeads = (drift || []).reduce(function(a, d){ return a + d.leads; }, 0);
  if (dLeads > 0) {
    add("bad", "Mapping", "", (drift.length) + " agents holding " + dLeads.toLocaleString("en-IN") +
      " leads belong to no team, so none of it appears above.");
  }
  const order = { bad: 0, warn: 1 };
  return out.sort(function(a, b){ return order[a.level] - order[b.level]; });
}

app.get("/api/vp", function(req, res){
  const month = String(req.query.month || curMonth());
  const t = (ORG.targets || {})[month] || { teams: {}, creators: {} };
  const p = istParts(new Date());
  const dim = new Date(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)), 0).getDate();
  const dom = Number(p.date.slice(8, 10));
  const agg = vpAggregate(month);
  const me = String(whoami(req) || "").toLowerCase();
  const vp = isVP(req);
  const visible = (ORG.teams || []).filter(function(t){
    return vp || !me || String(t.managerEmail || "").toLowerCase() === me;
  });
  const orderOf = {};
  (ORG.teams || []).forEach(function(t, i){ orderOf[t.id] = i; });
  // Call audit compliance for today, so the revenue view can show whether managers are
  // actually running the coaching cadence rather than only whether the floor is calling.
  const AUDITS = (typeof coachDayDetail === "function") ? coachDayDetail(p.date) : { teams: {}, agents: {} };
  const teams = visible.map(function(team){
    const byCreator = agg[team.id] || {};
    const totals = zero();
    const agentTouched = {};
    const mappedOnly = (team.creators || []);
    const creatorRows = Object.keys(byCreator).filter(function(cu){ return mappedOnly.indexOf(cu) >= 0; }).map(function(cu){
      const perAgent = byCreator[cu];
      const ctot = zero();
      const agents = Object.keys(perAgent).map(function(aid){
        const o = CACHE.owners[aid] || {};
        if (perAgent[aid].touched > 0) agentTouched[aid] = 1;
        addInto(ctot, perAgent[aid]);
        return Object.assign({ id: aid, name: o.name || ("Owner " + aid), email: o.email || "", active: o.active !== false }, perAgent[aid]);
      }).sort(function(a, b){ return b.revenue - a.revenue || b.queue - a.queue; });
      addInto(totals, ctot);
      const ct = (t.creators || {})[cu] || {};
      return Object.assign({ u: cu, target: num(ct.revenue), mapped: true, agents: agents }, ctot);
    }).sort(function(a, b){ return b.revenue - a.revenue || b.queue - a.queue; });
    (team.creators || []).forEach(function(cu){
      if (!byCreator[cu]) {
        const ct = (t.creators || {})[cu] || {};
        creatorRows.push(Object.assign({ u: cu, target: num(ct.revenue), mapped: true, agents: [] }, zero()));
      }
    });
    // one row per agent, summed across the creators in this team
    const am = {};
    creatorRows.forEach(function(c){
      (c.agents || []).forEach(function(a){
        if (!am[a.id]) am[a.id] = { id: a.id, name: a.name, active: a.active, revenue: 0, enrolments: 0,
          queue: 0, due: 0, done: 0, missed: 0, overdue: 0, uncalled: 0, touched: 0, needs: 0,
          form: 0, score: 0, intl: 0, counsellings: 0 };
        ["revenue","enrolments","queue","due","done","missed","overdue","uncalled","touched","needs","form","score","intl","counsellings"]
          .forEach(function(k){ am[a.id][k] += (a[k] || 0); });
      });
    });
    const agentRows = Object.values(am).sort(function(x, y){ return y.queue - x.queue; });

    const tg = t.teams[team.id] || {};
    const target = num(tg.revenue);
    const paceTarget = target * (dom / dim);
    const au = (AUDITS.teams || {})[team.id] || { done: 0, target: 0 };
    return Object.assign({
      audits: au.done, auditTarget: au.target,
      id: team.id, order: orderOf[team.id] || 0,
      name: team.name, managerEmail: team.managerEmail || "",
      agentIds: team.agentIds || [], creators: team.creators || [],
      agents: (team.agentIds || []).map(function(id){
        const o = CACHE.owners[id] || {};
        return { id: id, name: o.name || ("Owner " + id), email: o.email || "", active: o.active !== false };
      }),
      creatorRows: creatorRows, agentRows: agentRows,
      activeAgents: Object.keys(agentTouched).length,
      target: target, targetEnrolments: num(tg.enrolments), targetCounsellings: num(tg.counsellings),
      paceTarget: Math.round(paceTarget),
      gap: Math.round(totals.revenue - paceTarget),
      attainment: target ? Math.round(1000 * totals.revenue / target) / 10 : null
    }, totals);
  }).sort(function(x, y){ return y.revenue - x.revenue; });
  const scopedEmails = {};
  teams.forEach(function(t){
    (t.agentIds || []).forEach(function(id){
      const e = String(((CACHE.owners[id] || {}).email) || "").toLowerCase();
      if (e) scopedEmails[e] = 1;
    });
  });
  res.json({
    week: weekTrend(Object.keys(scopedEmails).length ? scopedEmails : null),
    prior: vpPriorMonth(month, dom, vp ? null : visible.reduce(function(a, t){ return a.concat(t.agentIds || []); }, [])),
    leadsLoadedAt: CACHE.loadedAt, leadsSyncing: CACHE.syncing, leadsCount: CACHE.contacts.length,
    syncs: {
      leads: { at: DELTA.at || CACHE.loadedAt, running: !!(CACHE.syncing || DELTA.running), n: CACHE.contacts.length,
        label: "Leads" + (DELTA.at ? " (incremental)" : "") },
      fullRebuild: { at: CACHE.loadedAt, running: !!CACHE.syncing, n: CACHE.contacts.length, label: "Full rebuild" },
      sheet: { at: SHEET.loadedAt, running: false, n: (SHEET.rows || []).length, label: "Payments sheet" },
      counsel: { at: COUNSEL.loadedAt, running: !!COUNSEL.syncing, n: Object.keys(COUNSEL.byId || {}).length, label: "Counselling history" },
      creatorFresh: { at: PFRESH.loadedAt, running: !!PFRESH.syncing, n: (PFRESH.rows || []).length, label: "Creator fresh leads" },
      forms: { at: FORMS.loadedAt, running: !!FORMS.syncing, n: FORMS.byEmail.size, label: "Waitlist forms" },
      unowned: { at: UNOWNED.loadedAt, running: !!UNOWNED.syncing, n: (UNOWNED.rows || []).length, label: "Unassigned priority leads" }
    },
    syncMinutes: DELTA_MINUTES,
    month: month, dayOfMonth: dom, daysInMonth: dim,
    persistent: ORG_PERSISTENT, isVP: isVP(req), me: whoami(req),
    teams: teams, drift: vp ? orgDrift() : [],
    scope: vp ? "all" : "own",
    unattributed: vp ? unattributed(month) : null,
    calloutHour: CALLOUT_HOUR,
    exceptions: vpExceptions(teams, vp ? orgDrift() : [], dom, dim, vp ? unattributed(month) : null),
    creators: (creatorsAll() || []),
    mainCreators: PFRESH_LIST.slice(),
    targets: t, benchmarks: ORG.benchmarks || { creators: {}, company: {} },
    log: (ORG.log || []).slice(-30).reverse()
  });
});

// Every creator we know about: from the lead pool and from the payment sheet, so a
// creator who has revenue but no synced leads still shows up.
function creatorsAll(){
  const m = {};
  callnowPool().forEach(function(c){ const u = c.topmate_username; if (u) m[u] = (m[u] || 0) + 1; });
  (SHEET.rows || []).forEach(function(r){ const u = r.creator_username; if (u && !(u in m)) m[u] = 0; });
  return Object.entries(m).map(function(e){ return { u: e[0], n: e[1], main: PFRESH_LIST.indexOf(e[0]) >= 0 }; })
    .sort(function(a, b){ return (b.main ? 1 : 0) - (a.main ? 1 : 0) || b.n - a.n || (a.u < b.u ? -1 : 1); })
    .slice(0, 2000);
}

// Manual refresh. Delta is cheap and open to managers; a full rebuild costs hundreds of
// API calls and takes minutes, so it stays with VPs.
let LAST_MANUAL = 0;
/* A full rebuild takes minutes. Holding the HTTP request open for that long means
   Railway's proxy gives up first and answers with a plain-text "upstream error", which
   the page then tries to parse as JSON. So the request only starts the work and returns,
   and the page follows progress on /api/sync/status. */
let MANUAL = { running: false, mode: "", startedAt: null, finishedAt: null, ms: 0, error: null, changed: 0 };
app.post("/api/sync/leads", function(req, res){
  const mode = String(req.query.mode || "delta");
  if (mode === "full" && !isVP(req)) return res.status(403).json({ error: "full rebuild is VP only" });
  if (MANUAL.running) {
    return res.status(202).json({ ok: true, running: true, mode: MANUAL.mode, startedAt: MANUAL.startedAt });
  }
  if (Date.now() - LAST_MANUAL < 20000) return res.json({ ok: true, skipped: "another refresh just ran" });
  LAST_MANUAL = Date.now();
  MANUAL = { running: true, mode: mode, startedAt: new Date().toISOString(),
    finishedAt: null, ms: 0, error: null, changed: 0 };
  const t0 = Date.now();
  (async function(){
    try {
      if (mode === "full") { await sync(); await syncCounsel(); }
      else if (!CACHE.loadedAt) await sync();
      else await syncDelta();
      MANUAL.changed = DELTA.lastCount || 0;
    } catch (e) {
      MANUAL.error = (e && e.message) || String(e);
      console.error("manual " + mode + " failed: " + MANUAL.error);
    }
    MANUAL.running = false;
    MANUAL.ms = Date.now() - t0;
    MANUAL.finishedAt = new Date().toISOString();
  })();
  res.status(202).json({ ok: true, running: true, mode: mode, startedAt: MANUAL.startedAt });
});

app.get("/api/sync/status", function(req, res){
  res.json(Object.assign({}, MANUAL, {
    leads: CACHE.contacts.length,
    at: (DELTA && DELTA.at) || CACHE.loadedAt,
    syncing: !!CACHE.syncing
  }));
});

/* Calls-today reconciliation.
   HubSpot is the only place that knows how many contacts were actually dialled. Every
   number on these dashboards is a filtered subset of that, and until now the ladder
   started from the app's own cache, which hides the one loss that matters most: leads
   HubSpot has that the app never pulled. This starts from HubSpot's own count and shows
   where each lead falls out, by owner and by creator, so the gap is arguable rather than
   mysterious. */
let RECON = { at: 0, running: false, data: null, error: null };
const RECON_TTL_MS = 5 * 60 * 1000;

async function buildRecon(){
  const day = istDayBounds();
  const filters = [
    { propertyName: "last_call_date_and_time", operator: "GTE", value: String(day.start) },
    { propertyName: "last_call_date_and_time", operator: "LT", value: String(day.end) }
  ];
  // Pull the ids, not just the count, so the gap can be attributed.
  const hub = {};
  let after, pages = 0, total = 0;
  do {
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
      filterGroups: [{ filters: filters }],
      properties: ["hubspot_owner_id", "topmate_username", "last_call_date_and_time"],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 100, after: after })});
    total = j.total || total;
    (j.results || []).forEach(function(r){
      hub[r.id] = { owner: String((r.properties || {}).hubspot_owner_id || ""),
        creator: String((r.properties || {}).topmate_username || "") };
    });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
    pages++;
  } while (after && pages < 60);

  const teamOf = {}, teamName = {};
  ((typeof ORG !== "undefined" && ORG.teams) || []).forEach(function(t){
    teamName[t.id] = t.name || "(unnamed)";
    (t.agentIds || []).forEach(function(id){ teamOf[String(id)] = t.id; });
  });

  const step = { hubspot: Object.keys(hub).length, inCache: 0, hasOwner: 0, ownerOnTeam: 0,
    ownerCounted: 0, prioritySegment: 0 };
  const lost = { notInCache: {}, noOwner: {}, ownerOffTeam: {}, parkingBucket: {}, notPriority: {} };
  const bump = function(box, owner, creator){
    const o = CACHE.owners[owner] || {};
    const k = owner ? (o.name || ("Owner " + owner)) : "(unassigned)";
    if (!box[k]) box[k] = { n: 0, creators: {} };
    box[k].n++;
    const cu = creator || "(no creator)";
    box[k].creators[cu] = (box[k].creators[cu] || 0) + 1;
  };

  const cached = {};
  callnowPool().forEach(function(c){ cached[c.id] = c; });

  Object.keys(hub).forEach(function(id){
    const h = hub[id];
    const c = cached[id];
    if (!c) { bump(lost.notInCache, h.owner, h.creator); return; }
    step.inCache++;
    const aid = String(c.hubspot_owner_id || "");
    if (!aid) { bump(lost.noOwner, "", h.creator); return; }
    step.hasOwner++;
    if (!teamOf[aid]) { bump(lost.ownerOffTeam, aid, h.creator); return; }
    step.ownerOnTeam++;
    if (!ownerCounted(aid)) { bump(lost.parkingBucket, aid, h.creator); return; }
    step.ownerCounted++;
    const r = cnRow(c), sg = cnSegs(r);
    if (!(sg.form || sg.score || sg.intl || sg.fresh)) { bump(lost.notPriority, aid, h.creator); return; }
    step.prioritySegment++;
  });

  const flatten = function(box){
    return Object.keys(box).map(function(k){
      const creators = Object.keys(box[k].creators)
        .map(function(u){ return { u: u, n: box[k].creators[u] }; })
        .sort(function(a, b){ return b.n - a.n; }).slice(0, 4);
      return { name: k, n: box[k].n, creators: creators };
    }).sort(function(a, b){ return b.n - a.n; });
  };
  return {
    at: new Date().toISOString(),
    hubspotTotal: total,
    steps: step,
    lost: { notInCache: flatten(lost.notInCache), noOwner: flatten(lost.noOwner),
      ownerOffTeam: flatten(lost.ownerOffTeam), parkingBucket: flatten(lost.parkingBucket),
      notPriority: flatten(lost.notPriority) },
    leadsLoadedAt: CACHE.loadedAt, deltaAt: (typeof DELTA !== "undefined" && DELTA.at) || null
  };
}

app.get("/api/reconcile/calls", async function(req, res){
  if (!TOKEN) return res.status(503).json({ error: "no HubSpot token configured" });
  const force = String(req.query.force || "") === "1";
  if (!force && RECON.data && (Date.now() - RECON.at) < RECON_TTL_MS) return res.json(RECON.data);
  if (RECON.running) return res.json(RECON.data || { running: true });
  RECON.running = true;
  try {
    const d = await buildRecon();
    RECON = { at: Date.now(), running: false, data: d, error: null };
    res.json(d);
  } catch (e) {
    RECON.running = false; RECON.error = e.message;
    res.status(500).json({ error: e.message });
  }
});

/* A second Railway service gets its own disk, so teams, mapping and targets start empty
   there. These two let the whole org store be copied across in one download and one
   paste, rather than retyping twenty-eight mappings. Read-only export, and an import that
   refuses anything that is not shaped like an org store. */
app.get("/api/org/export", function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  res.setHeader("Content-Disposition", "attachment; filename=org-export.json");
  res.json({
    exportedAt: new Date().toISOString(),
    teams: ORG.teams || [], targets: ORG.targets || {}, benchmarks: ORG.benchmarks || {},
    creators: ORG.creators || []
  });
});

app.post("/api/org/import", express.json({ limit: "4mb" }), function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  const b = req.body || {};
  if (!Array.isArray(b.teams)) return res.status(400).json({ error: "that file has no teams in it" });
  // Only the setup travels. Daily snapshots and coaching sessions belong to whichever
  // service produced them and must not be overwritten by a copy from somewhere else.
  ORG.teams = b.teams;
  if (b.targets && typeof b.targets === "object") ORG.targets = b.targets;
  if (b.benchmarks && typeof b.benchmarks === "object") ORG.benchmarks = b.benchmarks;
  if (Array.isArray(b.creators) && b.creators.length) {
    ORG.creators = b.creators;
    if (typeof adoptStoredCreators === "function") adoptStoredCreators();
  }
  if (typeof orgSave === "function") orgSave("org.import", String(b.teams.length) + " teams", whoami(req));
  res.json({ ok: true, teams: ORG.teams.length, creators: (ORG.creators || []).length });
});

app.get("/api/vp/daily", function(req, res){
  const all = (typeof ORG !== "undefined" && ORG.daily) || {};
  const dates = Object.keys(all).sort().reverse();
  const today = istParts(new Date()).date;
  const want = String(req.query.date || "") || dates.filter(function(d){ return d < today; })[0] || dates[0] || "";
  const snap = all[want] || null;
  const me = String(whoami(req) || "").toLowerCase();
  const vp = isVP(req);
  let scoped = snap;
  if (snap && !vp && me) {
    const mine = (ORG.teams || []).filter(function(t){ return String(t.managerEmail || "").toLowerCase() === me; });
    if (mine.length) {
      const names = mine.map(function(t){ return t.name || "(unnamed)"; });
      const teams = {}, agents = {};
      Object.keys(snap.teams || {}).forEach(function(id){ if (mine.some(function(t){ return t.id === id; })) teams[id] = snap.teams[id]; });
      Object.keys(snap.agents || {}).forEach(function(id){ if (names.indexOf(snap.agents[id].team) >= 0) agents[id] = snap.agents[id]; });
      // Roll up only over keys the teams actually carry, and keep null as null: a
      // rebuilt day has no pool figure, and summing that to zero would be a lie.
      const SNAPKEYS = ["pool","form","score","intl","fresh","due","done","missed","calls",
        "formC","scoreC","intlC","freshC","overdue","overdueC","counsellings","revenue",
        "enrolments","attempts","connected","audits","auditTarget","needs","needsC","uncalled","uncalledC",
        "oPool","oDue","oScore","oForm","oIntl","oFresh","oOverdue","oNeeds","oUncalled"];
      const roll = {};
      SNAPKEYS.forEach(function(k){
        let any = false, sum = 0;
        Object.keys(teams).forEach(function(id){
          const v = teams[id][k];
          if (v != null) { any = true; sum += v; }
        });
        roll[k] = any ? sum : (snap[k] == null ? null : 0);
      });
      scoped = Object.assign({ at: snap.at, openAt: snap.openAt, backfilled: !!snap.backfilled,
        teams: teams, agents: agents }, roll);
    }
  }
  res.json({ date: want, dates: dates, snapshot: scoped, isVP: vp, today: today });
});

app.post("/api/vp/team", express.json(), function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  const b = req.body || {};
  const id = String(b.id || "");
  let team = (ORG.teams || []).filter(function(t){ return t.id === id; })[0];
  if (!team) {
    team = { id: newId(), name: "", managerEmail: "", agentIds: [], creators: [] };
    ORG.teams.push(team);
  }
  if (b.name !== undefined) team.name = String(b.name).trim();
  if (b.managerEmail !== undefined) team.managerEmail = String(b.managerEmail).trim().toLowerCase();
  if (Array.isArray(b.agentIds)) team.agentIds = b.agentIds.map(String);
  if (Array.isArray(b.creators)) team.creators = b.creators.map(String);
  orgSave("team.save", team.name, whoami(req));
  res.json({ ok: true, persistent: ORG_PERSISTENT, team: team });
});

app.post("/api/vp/team/delete", express.json(), function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  const id = String((req.body || {}).id || "");
  const gone = (ORG.teams || []).filter(function(t){ return t.id === id; })[0];
  ORG.teams = (ORG.teams || []).filter(function(t){ return t.id !== id; });
  orgSave("team.delete", gone ? gone.name : id, whoami(req));
  res.json({ ok: true, persistent: ORG_PERSISTENT });
});

app.post("/api/vp/target", express.json(), function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  const b = req.body || {};
  const month = String(b.month || curMonth());
  ORG.targets = ORG.targets || {};
  ORG.targets[month] = ORG.targets[month] || { teams: {}, creators: {} };
  const bucket = b.scope === "creator" ? "creators" : "teams";
  const key = String(b.key || "");
  if (!key) return res.status(400).json({ error: "key required" });
  ORG.targets[month][bucket][key] = {
    revenue: num(b.revenue), enrolments: num(b.enrolments), counsellings: num(b.counsellings)
  };
  orgSave("target.set", month + " " + bucket + " " + key + " = " + num(b.revenue), whoami(req));
  res.json({ ok: true, persistent: ORG_PERSISTENT, targets: ORG.targets[month] });
});

app.post("/api/vp/benchmark", express.json(), function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  const b = req.body || {};
  ORG.benchmarks = ORG.benchmarks || { creators: {}, company: {} };
  if (b.creator) {
    ORG.benchmarks.creators[String(b.creator)] = { c2e: num(b.c2e), l2c: num(b.l2c), ticket: num(b.ticket), source: "manual" };
  } else {
    ORG.benchmarks.company = { c2e: num(b.c2e), l2c: num(b.l2c), ticket: num(b.ticket), source: "manual" };
  }
  orgSave("benchmark.set", b.creator || "company", whoami(req));
  res.json({ ok: true, persistent: ORG_PERSISTENT, benchmarks: ORG.benchmarks });
});

/* ---------- Creator plan: live data sync + per-user prefs ----------
   Feeds public/creator_plan.html. Rebuilds the page's baked BASEDATA schema from
   live HubSpot + the payment sheet so the plan stops aging. Scope mirrors the
   original snapshot: ALL contacts per creator (any owner, any stage, stage-less
   included), pool excludes students for the sp creator only. Total calls come from
   the Contact->Calls association (call_attempts is junk); "in current stage" is
   callscurrent_stage. Tier conversion defaults follow the page's documented rule:
   ayush tier shape rescaled to each creator's measured HubSpot-matched lead-to-
   enrolment rate, international clamped to 0.48x national on thin samples. */
const PLAN_MINUTES = parseInt(process.env.PLAN_MINUTES || "720", 10); // 12h delta refresh
const PLAN_CREATORS = (process.env.PLAN_CREATORS ||
  "ayush_singh13,payalineurope,wanderess_priyanka,kartikkapoorconsultation,technomanagers,vijaychandola,manasbichoo,ankita_gulati,simrankhokha")
  .split(",").map(function(s){ return s.trim(); }).filter(Boolean);
const PLAN_SP_CREATOR = process.env.PLAN_SP_CREATOR || "ayush_singh13";
const PLAN_STAGES = ["Fresh","payment_prospect","pricing_pitched","program_pitched","counselled","discovery","rcb_requested_callback","FU_RCB","Follow up","FU_DNP","dnp_did_not_pick","ghosted","ni_not_interested","disqualified","IFC","deal_won"];
const PLAN_LABELS = {"Fresh":"FRESH (never worked)","rcb_requested_callback":"RCB","discovery":"Discovery","program_pitched":"Program pitched","pricing_pitched":"Pricing pitched","counselled":"Counselled","Follow up":"Follow up","FU_DNP":"FU - DNP","FU_RCB":"FU - RCB","payment_prospect":"Payment prospect","dnp_did_not_pick":"DNP","ghosted":"Ghosted","ni_not_interested":"NI - Not interested","disqualified":"Disqualified","IFC":"IFC (parked)","deal_won":"Deal won"};
// convN below is the ayush-anchored default at bn=1.87; shape = convN/1.87 is what rescales.
const PLAN_TIERS = [
  { k:"A", name:"Payment prospect + pitched, under-called", note:"payment_prospect / pricing / program pitched with 0-1 calls in stage. Nearest to money.", convN:12,  cpl:3 },
  { k:"B", name:"Payment prospect + pitched, worked",       note:"Same stages, 2+ calls already spent. Needs closing, not dialling.",                     convN:8,   cpl:2 },
  { k:"C", name:"Counselled / discovery, under-called",     note:"Engaged then stalled, 0-1 calls in stage.",                                             convN:5,   cpl:3 },
  { k:"D", name:"Counselled / discovery, worked",           note:"2+ calls in stage already.",                                                            convN:3,   cpl:2 },
  { k:"E", name:"Callback requested, never called back",    note:"RCB or FU-RCB, zero calls in stage. They asked. Nobody dialled.",                       convN:3,   cpl:2 },
  { k:"F", name:"Callback requested, called",               note:"RCB / FU-RCB with 1+ calls in stage.",                                                  convN:1.5, cpl:2 },
  { k:"G", name:"Follow-up queue",                          note:"Follow up and FU-DNP stages.",                                                          convN:3,   cpl:3 },
  { k:"H", name:"Fresh, never touched",                     note:"No stage, no calls. Raw inventory.",                                                    convN:1.5, cpl:3 },
  { k:"I", name:"Soft churn, never actually reached",       note:"DNP or Ghosted on 0-2 calls in stage.",                                                 convN:0.8, cpl:3 },
  { k:"J", name:"Worked churn",                             note:"DNP or Ghosted with 3+ calls in stage.",                                                convN:0.3, cpl:2 },
  { k:"K", name:"Parked (IFC)",                             note:"Interested in future. Timing play.",                                                    convN:2,   cpl:2 },
  { k:"L", name:"NI / Disqualified",                        note:"Said no or failed qualification.",                                                      convN:0.15,cpl:1 }
];
const PLAN_BN0 = 1.87; // ayush measured baseline the convN anchors were written at
const PLAN_FILE = path.join(DATA_DIR, "plan_data.json");
const PLAN_PREFS_FILE = path.join(DATA_DIR, "plan_prefs.json");
let PLAN = { data: null, loadedAt: null, syncing: false, error: null };
try { if (fs.existsSync(PLAN_FILE)) { const j = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")); PLAN.data = j.data; PLAN.loadedAt = j.loadedAt; } } catch (e) { console.error("plan restore: " + e.message); }
/* Incremental sync state: per creator a map of contactId -> [stage, callsInStage,
   intlState, segClass, totalCalls]. Persisted to the volume so each cycle only
   fetches contacts whose hs_lastmodifieddate moved (call logging bumps it via
   callscurrent_stage). A weekly full rebuild catches deletions/creator moves. */
const PLAN_STATE_FILE = path.join(DATA_DIR, "plan_state.json");
const PLAN_FULL_MS = parseInt(process.env.PLAN_FULL_HOURS || "168", 10) * 3600000;
let PLAN_STATE = { creators: {}, lastFull: 0 };
try { if (fs.existsSync(PLAN_STATE_FILE)) PLAN_STATE = JSON.parse(fs.readFileSync(PLAN_STATE_FILE, "utf8")); } catch (e) { console.error("plan state restore: " + e.message); }

function planTierOf(st, cs){
  if (!st) return "H";
  if (st === "payment_prospect" || st === "pricing_pitched" || st === "program_pitched") return cs <= 1 ? "A" : "B";
  if (st === "counselled" || st === "discovery") return cs <= 1 ? "C" : "D";
  if (st === "rcb_requested_callback" || st === "FU_RCB") return cs === 0 ? "E" : "F";
  if (st === "Follow up" || st === "FU_DNP") return "G";
  if (st === "dnp_did_not_pick" || st === "ghosted") return cs <= 2 ? "I" : "J";
  if (st === "IFC") return "K";
  if (st === "ni_not_interested" || st === "disqualified") return "L";
  return null; // deal_won and anything unmapped stay out of tiers
}
async function fetchPlanRange(creator, from, to, sink, depth){
  const filters = [
    { propertyName: "topmate_username", operator: "EQ", value: creator },
    { propertyName: "createdate", operator: "GTE", value: String(from) },
    { propertyName: "createdate", operator: "LT", value: String(to) }
  ];
  const probe = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters }], properties: ["createdate"], limit: 1 }) });
  const total = probe.total || 0;
  if (total === 0) return { fetched: 0, total: 0, truncated: false };
  if (total > 9500 && (to - from) > 86400000 && (depth || 0) < 20) {
    const mid = Math.floor((from + to) / 2);
    await fetchPlanRange(creator, from, mid, sink, (depth || 0) + 1);
    await fetchPlanRange(creator, mid, to, sink, (depth || 0) + 1);
    return;
  }
  let after;
  do {
    const body = { filterGroups: [{ filters }],
      properties: ["contact_engagement_stage", "callscurrent_stage", "international_number", "tm_student_or_professional"],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], limit: 100, after };
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(function(r){ sink(Object.assign({ id: r.id }, r.properties)); });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
  } while (after);
}
async function planCallCounts(ids){
  // total calls ever, from the Contact->Calls association (v4 batch)
  const map = {};
  if (String(process.env.PLAN_ASSOC || "on") === "off") return map;
  for (let i = 0; i < ids.length; i += 100) {
    const inputs = ids.slice(i, i + 100).map(function(id){ return { id: id }; });
    try {
      const j = await hs("/crm/v4/associations/contacts/calls/batch/read", { method: "POST", body: JSON.stringify({ inputs }) });
      (j.results || []).forEach(function(r){ map[String(r.from && r.from.id)] = (r.to || []).length; });
    } catch (e) { if (i === 0) console.error("plan assoc: " + e.message); }
    await sleep(120);
  }
  return map;
}
function planEcon(creator){
  const rows = SHEET.rows.filter(function(r){ return (r.creator_username || "") === creator; });
  const cons = new Map();
  rows.slice().sort(function(a, b){ return a.date < b.date ? -1 : 1; }).forEach(function(r){
    const em = (r.consumer_email || "").toLowerCase(), ph = normPhone(r.consumer_phone);
    const key = em || ph || (r.consumer_name || "").trim().toLowerCase() || ("row" + r._row);
    if (!cons.has(key)) cons.set(key, { em: em, ph: ph, intl: sheetIntl(r), first: (r.date || "").slice(0, 7), paid: 0 });
    cons.get(key).paid += r.price;
  });
  const months = {};
  let enat = 0, eintl = 0, revN = 0, revI = 0, mNat = 0, mIntl = 0;
  cons.forEach(function(c){
    if (c.first) months[c.first] = (months[c.first] || 0) + 1;
    const matched = (c.em && COHORT.emails.has(c.em)) || (c.ph && COHORT.phones.has(c.ph));
    if (c.intl) { eintl++; revI += c.paid; if (matched) mIntl++; }
    else { enat++; revN += c.paid; if (matched) mNat++; }
  });
  const sortedMonths = {};
  Object.keys(months).sort().forEach(function(m){ sortedMonths[m] = months[m]; });
  return { enrol: cons.size, rev: rows.reduce(function(t, r){ return t + r.price; }, 0), payments: rows.length,
    enat: enat, eintl: eintl,
    revN: revN, revI: revI, mNat: mNat, mIntl: mIntl, months: sortedMonths, has: rows.length > 0 };
}
function planIvOf(p){ const v = String(p.international_number || "").toLowerCase(); return v === "true" || v === "yes" ? "i" : (v === "false" || v === "no" ? "n" : "u"); }
function planSpcOf(p){
  const raw = (p.tm_student_or_professional || "").trim();
  if (!raw) return "E";
  const c = classifySP(raw);
  return c === "P" ? "P" : c === "S" ? "S" : "U";
}
async function fetchPlanDelta(creator, sinceMs){
  // contacts modified since the last cycle; null = too many, caller should do a full pull
  const filters = [
    { propertyName: "topmate_username", operator: "EQ", value: creator },
    { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(sinceMs) }
  ];
  const probe = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ filterGroups: [{ filters }], properties: ["createdate"], limit: 1 }) });
  const total = probe.total || 0;
  if (total === 0) return [];
  if (total > 9000) return null;
  const out = [];
  let after;
  do {
    const body = { filterGroups: [{ filters }],
      properties: ["contact_engagement_stage", "callscurrent_stage", "international_number", "tm_student_or_professional"],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], limit: 100, after };
    const j = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) });
    (j.results || []).forEach(function(r){ out.push(Object.assign({ id: r.id }, r.properties)); });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
  } while (after);
  return out;
}
function planAggregate(cr, cmap){
  const sp = cr === PLAN_SP_CREATOR;
  const stAgg = {}, tierAgg = {};
  PLAN_STAGES.forEach(function(s2){ stAgg[s2] = { ln: 0, li: 0, tn: 0, ti: 0, vals: [], pro: 0, oth: 0, nul: 0 }; });
  PLAN_TIERS.forEach(function(t){ tierAgg[t.k] = { leads: 0, nat: 0, intl: 0, callsdone: 0 }; });
  let pool = 0, won = 0, natC = 0, intlC = 0, callsNat = 0, callsIntl = 0, callsCS = 0;
  Object.keys(cmap).forEach(function(id){
    const rec = cmap[id];
    const st = rec[0], cs = rec[1], iv = rec[2], spc = rec[3], tc = rec[4] || 0;
    const stKey = st || "Fresh";
    const a = stAgg[stKey];
    if (a) {
      a.vals.push(cs);
      if (sp) { if (spc === "P") a.pro++; else if (spc === "E") a.nul++; else a.oth++; }
    }
    if (sp && spc === "S") return; // pool excludes students for the sp creator
    pool++;
    if (iv === "i") intlC++; else if (iv === "n") natC++;
    if (iv === "i") callsIntl += tc; else callsNat += tc;
    callsCS += cs;
    if (a) { if (iv === "i") { a.li++; a.ti += tc; } else { a.ln++; a.tn += tc; } }
    if (stKey === "deal_won") { won++; return; }
    const tk = planTierOf(st, cs);
    if (tk && tierAgg[tk]) { const t = tierAgg[tk]; t.leads++; if (iv === "i") t.intl++; else t.nat++; t.callsdone += cs; }
  });
  const econ = planEcon(cr);
  const bnRaw = natC ? +(100 * econ.mNat / natC).toFixed(2) : null;
  const thin = intlC < 200 || econ.eintl < 5;
  const biRaw = thin ? (bnRaw !== null ? +(0.48 * bnRaw).toFixed(2) : null)
                     : (intlC ? +(100 * econ.mIntl / intlC).toFixed(2) : null);
  const bnEff = bnRaw || 0.5;
  const biEff = biRaw || +(0.48 * bnEff).toFixed(2);
  return {
    stages: PLAN_STAGES.map(function(s2){
      const a = stAgg[s2];
      const vals = a.vals.slice().sort(function(x, y){ return x - y; });
      const n = vals.length, sum = vals.reduce(function(t, v){ return t + v; }, 0);
      const cs = { n: n, sum: sum, mean: n ? +(sum / n).toFixed(1) : 0,
        median: n ? vals[Math.floor((n - 1) / 2)] : 0,
        p90: n ? vals[Math.min(n - 1, Math.floor(0.9 * n))] : 0,
        b0: vals.filter(function(v){ return v === 0; }).length,
        b12: vals.filter(function(v){ return v >= 1 && v <= 2; }).length,
        b35: vals.filter(function(v){ return v >= 3 && v <= 5; }).length,
        b6: vals.filter(function(v){ return v >= 6; }).length };
      const row = { stage: s2, label: PLAN_LABELS[s2] || s2, ln: a.ln, li: a.li, tn: a.tn, ti: a.ti, cs: cs, total: a.ln + a.li };
      if (sp) { row.pro = a.pro; row.oth = a.oth; row.nul = a.nul; }
      return row;
    }),
    tiers: PLAN_TIERS.map(function(t){
      const g = tierAgg[t.k], shape = t.convN / PLAN_BN0;
      return { k: t.k, name: t.name, note: t.note, leads: g.leads, nat: g.nat, intl: g.intl,
        callsdone: g.callsdone, convN: +(shape * bnEff).toFixed(2), convI: +(shape * biEff).toFixed(2), cpl: t.cpl };
    }),
    econ: { has: econ.has, enrol: econ.enrol, rev: econ.rev, payments: econ.payments, enat: econ.enat, eintl: econ.eintl,
      tkn: econ.enat ? Math.round(econ.revN / econ.enat) : null, tki: econ.eintl ? Math.round(econ.revI / econ.eintl) : null,
      bn: bnRaw, bi: biRaw, months: econ.months, thin_i: thin, intl_leads: intlC, nat_leads: natC },
    poolnote: sp ? "non-student leads only" : "all leads",
    pool: pool, actionable: pool - won, won: won, nat: natC, intl: intlC,
    calls: { nat: callsNat, intl: callsIntl, cs: callsCS }, sp: sp
  };
}
async function syncPlan(force){
  if (!TOKEN || PLAN.syncing) return;
  if (!SHEET.rows.length || !COHORT.emails.size) { setTimeout(syncPlan, 5 * 60 * 1000); return; }
  PLAN.syncing = true;
  const t0 = Date.now();
  const needFull = !!force || !PLAN_STATE.lastFull || (t0 - PLAN_STATE.lastFull) > PLAN_FULL_MS;
  try {
    const creators = {};
    let fullCount = 0, deltaCount = 0;
    const planList = PLAN_CREATORS.concat((PLAN_STATE.extra || []).filter(function(x){ return PLAN_CREATORS.indexOf(x) < 0; }));
    for (const cr of planList) {
      try {
        let st = PLAN_STATE.creators[cr];
        let doFull = needFull || !st || !st.last || !st.c;
        if (!doFull) {
          const delta = await fetchPlanDelta(cr, st.last - 3600000); // 1h overlap
          if (delta === null) doFull = true;
          else {
            const tot = await planCallCounts(delta.map(function(r){ return r.id; }));
            delta.forEach(function(p){
              const prev = st.c[p.id];
              st.c[p.id] = [p.contact_engagement_stage || "", num(p.callscurrent_stage), planIvOf(p), planSpcOf(p),
                tot[p.id] !== undefined ? tot[p.id] : (prev ? prev[4] : 0)];
            });
            st.last = t0;
            deltaCount += delta.length;
          }
        }
        if (doFull) {
          const rows = [];
          await fetchPlanRange(cr, Date.parse("2024-01-01"), t0 + 86400000, function(p){ rows.push(p); });
          const tot = await planCallCounts(rows.map(function(r){ return r.id; }));
          const cmap = {};
          rows.forEach(function(p){ cmap[p.id] = [p.contact_engagement_stage || "", num(p.callscurrent_stage), planIvOf(p), planSpcOf(p), tot[p.id] || 0]; });
          st = PLAN_STATE.creators[cr] = { c: cmap, last: t0 };
          fullCount++;
        }
        creators[cr] = planAggregate(cr, st.c);
        console.log("plan " + cr + ": " + Object.keys(st.c).length + " contacts (" + (doFull ? "full" : "delta") + ")");
      } catch (e) {
        console.error("plan " + cr + ": " + e.message);
        // keep last aggregate for this creator if we have state
        const st2 = PLAN_STATE.creators[cr];
        if (st2 && st2.c) creators[cr] = planAggregate(cr, st2.c);
      }
    }
    if (needFull) PLAN_STATE.lastFull = t0;
    // month baseline: freeze per-contact tier + call counts on the first sync of each month
    const bym = new Date().toISOString().slice(0, 7);
    if (!PLAN_STATE.baseline || PLAN_STATE.baseline.ym !== bym) {
      const b = { ym: bym, at: new Date().toISOString(), creators: {} };
      Object.keys(PLAN_STATE.creators).forEach(function(cr){
        const src = PLAN_STATE.creators[cr].c, m = {};
        Object.keys(src).forEach(function(id){
          const r = src[id]; // [st, cs, iv, spc, tot]
          const k = r[0] === "deal_won" ? "W" : (planTierOf(r[0], r[1]) || "?");
          m[id] = [k, r[2], r[4] || 0, r[3]];
        });
        b.creators[cr] = m;
      });
      PLAN_STATE.baseline = b;
      console.log("Plan tracking baseline frozen for " + bym);
    }
    PLAN.data = { creators: creators, order: planList.filter(function(c){ return creators[c]; }), stages: PLAN_STAGES, labels: PLAN_LABELS,
      mode: needFull ? "full" : "delta", lastFull: PLAN_STATE.lastFull ? new Date(PLAN_STATE.lastFull).toISOString() : null };
    PLAN.loadedAt = new Date().toISOString();
    PLAN.syncing = false; PLAN.error = null;
    try {
      if (ORG_PERSISTENT) {
        fs.writeFileSync(PLAN_FILE, JSON.stringify({ data: PLAN.data, loadedAt: PLAN.loadedAt }));
        fs.writeFileSync(PLAN_STATE_FILE, JSON.stringify(PLAN_STATE));
      }
    } catch (e) { console.error("plan save: " + e.message); }
    console.log("Plan sync complete (" + (needFull ? "full" : "delta, " + deltaCount + " changed") + "): " + Object.keys(creators).length + " creators");
  } catch (e) {
    PLAN.syncing = false; PLAN.error = e.message;
    console.error("Plan sync failed: " + e.message);
  }
}
setTimeout(syncPlan, 4 * 60 * 1000);
setInterval(syncPlan, PLAN_MINUTES * 60 * 1000);

function planPrefsAll(){
  try { if (fs.existsSync(PLAN_PREFS_FILE)) return JSON.parse(fs.readFileSync(PLAN_PREFS_FILE, "utf8")); } catch (e) {}
  return {};
}
app.get("/api/creator-plan", adminOnly, function(req, res){
  if (!PLAN.data) return res.status(503).json({ error: PLAN.error || "plan data is still syncing; the page falls back to its baked snapshot", syncing: PLAN.syncing });
  res.json(Object.assign({ loadedAt: PLAN.loadedAt, syncing: PLAN.syncing }, PLAN.data));
});
const PLAN_ADDING = {};
async function planAddCreator(cr){
  try {
    const t0 = Date.now();
    const rows = [];
    await fetchPlanRange(cr, Date.parse("2024-01-01"), t0 + 86400000, function(p){ rows.push(p); });
    const tot = await planCallCounts(rows.map(function(r){ return r.id; }));
    const cmap = {};
    rows.forEach(function(p){ cmap[p.id] = [p.contact_engagement_stage || "", num(p.callscurrent_stage), planIvOf(p), planSpcOf(p), tot[p.id] || 0]; });
    PLAN_STATE.creators[cr] = { c: cmap, last: t0 };
    if (!PLAN_STATE.extra) PLAN_STATE.extra = [];
    if (PLAN_STATE.extra.indexOf(cr) < 0 && PLAN_CREATORS.indexOf(cr) < 0) PLAN_STATE.extra.push(cr);
    if (PLAN_STATE.baseline && !PLAN_STATE.baseline.creators[cr]) {
      const m = {};
      Object.keys(cmap).forEach(function(id){ const r = cmap[id]; m[id] = [r[0] === "deal_won" ? "W" : (planTierOf(r[0], r[1]) || "?"), r[2], r[4] || 0, r[3]]; });
      PLAN_STATE.baseline.creators[cr] = m;
    }
    if (PLAN.data) {
      PLAN.data.creators[cr] = planAggregate(cr, cmap);
      if (PLAN.data.order.indexOf(cr) < 0) PLAN.data.order.push(cr);
      PLAN.loadedAt = new Date().toISOString();
    }
    try { if (ORG_PERSISTENT) { fs.writeFileSync(PLAN_FILE, JSON.stringify({ data: PLAN.data, loadedAt: PLAN.loadedAt })); fs.writeFileSync(PLAN_STATE_FILE, JSON.stringify(PLAN_STATE)); } } catch (e) {}
    console.log("plan add " + cr + ": " + rows.length + " contacts synced");
  } catch (e) { console.error("plan add " + cr + ": " + e.message); }
}
app.post("/api/creator-plan/add", adminOnly, express.json(), async function(req, res){
  const cr = String((req.body && req.body.creator) || "").trim();
  if (!cr) return res.status(400).json({ error: "creator username required" });
  if (PLAN.data && PLAN.data.creators[cr]) return res.json({ ok: true, exists: true });
  if (PLAN_ADDING[cr]) return res.json({ ok: true, queued: true });
  try {
    const probe = await hs("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "topmate_username", operator: "EQ", value: cr }] }], properties: ["createdate"], limit: 1 }) });
    const total = probe.total || 0;
    const payments = SHEET.rows.filter(function(r){ return (r.creator_username || "") === cr; }).length;
    if (!total && !payments) return res.status(404).json({ error: "No HubSpot contacts or payments found for '" + cr + "'. Check the exact topmate_username spelling." });
    PLAN_ADDING[cr] = true;
    planAddCreator(cr).finally(function(){ delete PLAN_ADDING[cr]; });
    res.json({ ok: true, queued: true, contacts: total, payments: payments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/plan-tracking", adminOnly, function(req, res){
  const b = PLAN_STATE.baseline;
  if (!b) return res.status(503).json({ error: "No month baseline yet. It freezes automatically on the first plan sync of the month." });
  const now = new Date();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const out = { ym: b.ym, baselineAt: b.at, day: now.getDate(), dim: dim, frac: +(now.getDate() / dim).toFixed(3),
    loadedAt: PLAN.loadedAt, creators: {} };
  Object.keys(PLAN_STATE.creators).forEach(function(cr){
    const cur = PLAN_STATE.creators[cr].c, base = (b.creators || {})[cr] || {};
    const sp = cr === PLAN_SP_CREATOR;
    const tiers = {};
    function cell(k, seg){ if (!tiers[k]) tiers[k] = {}; if (!tiers[k][seg]) tiers[k][seg] = { leads0: 0, calls: 0, touched: 0, moved: 0, won: 0 }; return tiers[k][seg]; }
    let newLeads = 0, newCalls = 0;
    Object.keys(base).forEach(function(id){
      const r = base[id]; // [tierK, iv, tot0, spc]
      if (sp && r[3] === "S") return; // students stay outside the plan scope
      const k = r[0];
      if (k === "W" || k === "?") return;
      const seg = r[1] === "i" ? "I" : "N";
      const c2 = cur[id];
      const totNow = c2 ? (c2[4] || 0) : r[2];
      const d = Math.max(0, totNow - r[2]);
      const c3 = cell(k, seg);
      c3.leads0++; c3.calls += d; if (d > 0) c3.touched++;
      const kNow = c2 ? (c2[0] === "deal_won" ? "W" : (planTierOf(c2[0], c2[1]) || "?")) : k;
      if (kNow !== k) { c3.moved++; if (kNow === "W") c3.won++; }
    });
    Object.keys(cur).forEach(function(id){
      if (base[id]) return;
      const r = cur[id];
      if (sp && r[3] === "S") return;
      newLeads++; newCalls += r[4] || 0;
    });
    // month-to-date money from the sheet (enrolment = first payment ever per consumer)
    const seenAll = new Set(); let enrol = 0, rev = 0;
    SHEET.rows.slice().sort(function(a, c){ return a.date < c.date ? -1 : 1; }).forEach(function(r){
      if ((r.creator_username || "") !== cr) return;
      const em = (r.consumer_email || "").toLowerCase(), ph = normPhone(r.consumer_phone);
      const key = em || ph || (r.consumer_name || "").trim().toLowerCase() || ("row" + r._row);
      const isFirst = !seenAll.has(key); seenAll.add(key);
      if ((r.date || "").slice(0, 7) === b.ym) { rev += r.price; if (isFirst) enrol++; }
    });
    out.creators[cr] = { tiers: tiers, newLeads: newLeads, newCalls: newCalls, actual: { enrol: enrol, rev: rev } };
  });
  res.json(out);
});
app.get("/api/plan-prefs", adminOnly, function(req, res){
  const email = ((req.session || sessionOf(req) || {}).email || "").toLowerCase();
  res.json(planPrefsAll()[email] || {});
});
app.put("/api/plan-prefs", adminOnly, express.json({ limit: "1mb" }), function(req, res){
  const email = ((req.session || sessionOf(req) || {}).email || "").toLowerCase();
  const all = planPrefsAll();
  const prev = all[email] || {};
  all[email] = { all: (req.body && req.body.all) || prev.all || {}, custom: (req.body && req.body.custom) || prev.custom || {},
    cur: (req.body && req.body.cur) || prev.cur || "", targets: (req.body && req.body.targets) || prev.targets || {},
    updatedAt: new Date().toISOString() };
  let persisted = false;
  try { if (ORG_PERSISTENT) { fs.writeFileSync(PLAN_PREFS_FILE, JSON.stringify(all)); persisted = true; } } catch (e) {}
  res.json({ ok: true, persistent: persisted });
});

/* ---------- creator_plan.html: admin-only page ----------
   Allowlist comes from ADMIN_EMAILS (comma separated, set in Railway). The session
   email lives at req.session.email (set by authGate via the signed cn_session
   cookie); there is no req.user in this app. Route must stay registered BEFORE
   express.static, otherwise static serves the file and the guard never runs. */
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
);
function adminOnly(req, res, next) {
  const email = ((req.session || sessionOf(req) || {}).email || '').toLowerCase();
  if (!email) return res.redirect('/login.html');
  if (!ADMIN_EMAILS.has(email)) return res.status(403).send('Not authorised.');
  next();
}
app.get('/creator_plan.html', adminOnly, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'creator_plan.html'))
);
app.get('/plan_summary.html', adminOnly, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'plan_summary.html'))
);
app.get('/plan_tracking.html', adminOnly, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'plan_tracking.html'))
);
app.use(express.static("public"));
// A background sync that rejects must never take the web server down with it.
// Node 18 exits the process on an unhandled rejection, which is what produced the
// "deploy crashed then recovered" restarts: one bad HubSpot response, whole app gone.
process.on("unhandledRejection", function(e){
  console.error("Unhandled rejection (kept alive): " + ((e && e.message) || e));
});
process.on("uncaughtException", function(e){
  console.error("Uncaught exception (kept alive): " + ((e && e.stack) || e));
});
function guard(name, fn){
  return function(){
    try {
      const r = fn();
      if (r && typeof r.catch === "function") r.catch(function(e){ console.error(name + " failed: " + ((e && e.message) || e)); });
      return r;
    } catch (e) { console.error(name + " threw: " + ((e && e.message) || e)); }
  };
}
const runChain = guard("boot chain", function(){
  return syncForms().then(syncUnowned).then(syncPriorityFresh);
});

/* ==========================================================================
   Coaching cadence: five reviewed calls a manager a day
   --------------------------------------------------------------------------
   The programme fails the moment a manager chooses which call to review, so
   the rotation and the call pick are both deterministic functions of
   (manager, IST date). Same inputs, same five agents, same five calls, for
   everyone who opens the page. Nothing here is re-rollable.

   Three of the nine checklist items are answered from HubSpot rather than by
   the manager, so the hygiene half of the score is not a matter of opinion.
   ========================================================================== */

const COACH_MIN_SECONDS = Math.max(0, parseInt(process.env.COACH_MIN_SECONDS || "90", 10));
const COACH_PER_DAY = Math.max(1, parseInt(process.env.COACH_PER_DAY || "5", 10));
/* Two windows, not one. The preferred window is the last two days, because feedback
   on a call from this morning lands differently from feedback on one from last week.
   But an agent who was on leave, or had a thin day, would otherwise be skipped
   entirely, so the pick widens to five days rather than dropping them. */
const COACH_LOOKBACK_HOURS = Math.max(6, parseInt(process.env.COACH_LOOKBACK_HOURS || "48", 10));
const COACH_MAX_HOURS = Math.max(COACH_LOOKBACK_HOURS, parseInt(process.env.COACH_MAX_HOURS || "120", 10));

/* The nine items. `auto` ones are derived, never typed. Order is the order the
   call itself runs in, so a manager listening once can tick straight down. */
const COACH_ITEMS = [
  { key: "logged",   auto: true,  label: "Call logged with an outcome" },
  { key: "followup", auto: true,  label: "Follow up date set after the call" },
  { key: "length",   auto: true,  label: "Call ran past " + COACH_MIN_SECONDS + " seconds" },
  { key: "opening",  auto: false, label: "Opening set the call up, not just an intent check" },
  { key: "needs",    auto: false, label: "Proper need analysis before pitching" },
  { key: "linked",   auto: false, label: "Pitch linked to something the lead actually said" },
  { key: "objection",auto: false, label: "Responded to the objection raised" },
  { key: "nextstep", auto: false, label: "Specific next step agreed on the call" },
  { key: "written",  auto: false, label: "Follow up sent on WhatsApp or email" }
];
const COACH_JUDGED = COACH_ITEMS.filter(function(i){ return !i.auto; }).map(function(i){ return i.key; });
const COACH_KEYS = COACH_ITEMS.map(function(i){ return i.key; });

/* ---------- deterministic picking ----------
   A string hash, not Math.random. The point is that two managers opening the
   same day see the same list, and that reloading never produces a new one. */
function coachHash(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
function coachIstDate(d){ return istParts(d || new Date()).date; }
function coachDayIndex(dateStr){ return Math.floor(Date.parse(dateStr + "T00:00:00Z") / 86400000); }

/* Round robin, so every agent comes up on a fixed cycle rather than whoever the
   manager happens to be worried about. Fifteen agents at five a day means each
   one is coached every third working day, and the gap is visible. */
/* A manager auditing their own calls is not an audit, and every manager holds some
   leads of their own, so their owner id turns up in agentIds and would otherwise
   come round in the rotation. Excluded here rather than by asking people to unmap
   themselves, because the mapping is load-bearing elsewhere. */
function coachIsManager(id){
  const o = CACHE.owners[String(id)] || {};
  const em = String(o.email || "").toLowerCase();
  if (!em) return false;
  if (VP_EMAILS.indexOf(em) >= 0) return true;
  if (typeof MANAGER_EMAILS !== "undefined" && MANAGER_EMAILS.indexOf(em) >= 0) return true;
  return (ORG.teams || []).some(function(t){ return String(t.managerEmail || "").toLowerCase() === em; });
}
function coachAgents(team){
  return (team.agentIds || []).map(String)
    .filter(function(id){ return ownerCounted(id) && !coachIsManager(id); });
}

/* The full roster in today's order: the same round robin, but not truncated to five,
   so the picker can keep walking past agents who have nothing to review. */
function coachRotationOrder(team, dateStr){
  const ids = coachAgents(team).sort();
  if (!ids.length) return [];
  const n = Math.min(COACH_PER_DAY, ids.length);
  const start = (coachDayIndex(dateStr) * n) % ids.length;
  const out = [];
  for (let i = 0; i < ids.length; i++) out.push(ids[(start + i) % ids.length]);
  return out;
}

/* Who is due today, according to the lock if one exists. Everything that counts or
   reports compliance must read the same list the manager is looking at, or the VP is
   told two people are outstanding while the manager sees three different names. */
function coachDueAgents(team, dateStr){
  const lock = coachAssignments()[coachAssignKey(dateStr, team.id)];
  if (lock) return lock.rows.map(function(r){ return String(r.agentId); });
  return coachPickAgents(team, dateStr);
}

function coachPickAgents(team, dateStr){
  const ids = coachAgents(team).sort();
  if (!ids.length) return [];
  const n = Math.min(COACH_PER_DAY, ids.length);
  const start = (coachDayIndex(dateStr) * n) % ids.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(ids[(start + i) % ids.length]);
  return out;
}

/* ---------- call inventory ----------
   syncCalls aggregates counts by owner and never keeps the individual call, so
   coaching needs its own pull: call objects with their contact association,
   duration and recording url.

   The buffer holds COACH_MAX_HOURS. Fetching five days on every pass would cost
   roughly fifty search pages and fifty association batches an hour, which is
   most of the saving the delta lead sync just won. So the first pass loads the
   full window and every pass after it asks only for calls since the last one,
   with an hour of overlap, and merges by call id. Steady state is two or three
   API calls an hour. */
let COACH = { calls: [], byOwner: {}, loadedAt: null, syncedTo: 0, syncing: false, error: null };

async function syncCoachCalls(){
  if (!TOKEN || COACH.syncing) return;
  COACH.syncing = true;
  const started = Date.now();
  try {
    const now = Date.now();
    const floor = now - COACH_MAX_HOURS * 3600000;
    const full = !COACH.syncedTo;
    const from = full ? floor : Math.max(floor, COACH.syncedTo - 3600000);

    /* The first pass is the fragile one: five days is roughly eighty search pages plus
       eighty association batches, and until it finishes the page shows nothing at all.
       So it is walked one day at a time, newest first, and each day is merged as soon as
       it lands. A failure on day four now leaves days one to three usable instead of
       leaving the coaching page permanently empty. */
    const windows = [];
    if (full) {
      for (let hi = now; hi > floor; hi -= 86400000) windows.push([Math.max(floor, hi - 86400000), hi]);
    } else {
      windows.push([from, now]);
    }

    let fetched = 0, failedWindows = 0, lastErr = null;
    const byId = {};
    (full ? [] : COACH.calls).forEach(function(c){ byId[c.id] = c; });

    for (const w of windows) {
      let raw = [];
      try {
        raw = await coachFetchWindow(w[0], w[1]);
      } catch (e) {
        failedWindows++; lastErr = (e && e.message) || String(e);
        console.error("coach window " + new Date(w[0]).toISOString() + " failed: " + lastErr);
        continue; // keep the windows that did work
      }
      let link = {};
      try { link = await coachLinkContacts(raw); }
      catch (e) { lastErr = (e && e.message) || String(e); console.error("coach assoc: " + lastErr); }
      raw.forEach(function(r){
        const p = r.p;
        byId[r.id] = {
          id: r.id,
          at: ts(p.hs_timestamp),
          ownerId: String(p.hubspot_owner_id || ""),
          seconds: Math.round(num(p.hs_call_duration) / 1000),
          disposition: COACH_DISPO(p.hs_call_disposition),
          recording: p.hs_call_recording_url || "",
          title: clip(p.hs_call_title, 80),
          contactId: link[r.id] || ""
        };
      });
      fetched += raw.length;
      // Publish after every window so the page fills in progressively.
      COACH.calls = Object.keys(byId).map(function(k){ return byId[k]; })
        .filter(function(c){ return c.at >= floor; })
        .sort(function(a, b){ return b.at - a.at; });
    }

    const calls = COACH.calls;
    const byOwner = {};
    calls.forEach(function(c){ if (c.ownerId) (byOwner[c.ownerId] = byOwner[c.ownerId] || []).push(c); });

    const gotSomething = calls.length > 0 || fetched > 0;
    COACH = {
      calls: calls, byOwner: byOwner,
      loadedAt: gotSomething ? new Date().toISOString() : COACH.loadedAt,
      // Only claim the newest edge is covered if the newest window actually succeeded,
      // otherwise the next delta would skip over calls we never fetched.
      syncedTo: (failedWindows < windows.length) ? now : COACH.syncedTo,
      syncing: false,
      partial: failedWindows > 0,
      error: failedWindows > 0
        ? (failedWindows + " of " + windows.length + " windows could not be fetched: " + lastErr)
        : null
    };
    console.log("Coach calls " + (full ? "full load" : "delta") + ": " + fetched + " fetched, " +
      calls.length + " held over " + COACH_MAX_HOURS + "h across " + Object.keys(byOwner).length +
      " owners, " + failedWindows + " windows failed, " + (Date.now() - started) + "ms");
  } catch (e) {
    COACH.syncing = false;
    COACH.error = (e && e.message) || String(e);
    console.error("Coach call sync failed: " + COACH.error);
  }
}

async function coachFetchWindow(fromMs, toMs){
  const filters = [
    { propertyName: "hs_timestamp", operator: "GTE", value: String(fromMs) },
    { propertyName: "hs_timestamp", operator: "LT", value: String(toMs) }
  ];
  const props = ["hs_timestamp", "hubspot_owner_id", "hs_call_duration", "hs_call_disposition",
    "hs_call_recording_url", "hs_call_title", "hs_call_direction"];
  const raw = [];
  let after, pages = 0;
  do {
    const j = await hs("/crm/v3/objects/calls/search", { method: "POST", body: JSON.stringify({
      filterGroups: [{ filters: filters }], properties: props,
      sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }], limit: 100, after: after }) });
    (j.results || []).forEach(function(r){ raw.push({ id: r.id, p: r.properties || {} }); });
    after = j.paging && j.paging.next && j.paging.next.after;
    await sleep(120);
    pages++;
  } while (after && pages < 40);
  return raw;
}

/* Search will not return associations, so the contact link is a second pass. Without it
   a call cannot be tied to a lead and the review has no subject. A failed batch loses
   only its own hundred calls, not the window. */
async function coachLinkContacts(raw){
  const link = {};
  for (let i = 0; i < raw.length; i += 100) {
    const inputs = raw.slice(i, i + 100).map(function(r){ return { id: r.id }; });
    try {
      const a = await hs("/crm/v4/associations/calls/contacts/batch/read", { method: "POST",
        body: JSON.stringify({ inputs: inputs }) });
      (a.results || []).forEach(function(r){
        const to = (r.to || [])[0];
        if (to) link[String(r.from && r.from.id)] = String(to.toObjectId || to.id);
      });
    } catch (e) { console.error("coach assoc batch: " + ((e && e.message) || e)); }
    await sleep(120);
  }
  return link;
}

function COACH_DISPO(id){
  if (!id) return "";
  return (CALLS.dispositions && CALLS.dispositions[id]) || String(id);
}

/* One call per agent, drawn from calls long enough to be a real conversation.
   Deterministic within that set, and weighted toward the calls worth hearing:
   priority pool leads first, then anything on a tracked creator. */
function coachPickCall(agentId, dateStr, already){
  const all = (COACH.byOwner[String(agentId)] || []).filter(function(c){
    return c.seconds >= COACH_MIN_SECONDS && c.contactId && already.indexOf(c.id) < 0;
  });
  if (!all.length) return null;
  // Priority means the same thing here as it does on Call Now: form, score,
  // international or fresh. Reusing cnSegs keeps the two pages from drifting apart.
  const priority = {};
  try {
    cnFilter({ scope: "tracked" }).forEach(function(r){
      const s = cnSegs(r);
      if (r.id && (s.form || s.score || s.intl || s.fresh)) priority[String(r.id)] = r;
    });
  } catch (e) {}

  // Recent first. Only if the last two days hold nothing does the window widen,
  // so a normal week is always coached on fresh calls and a thin one is still coached.
  const cut = Date.now() - COACH_LOOKBACK_HOURS * 3600000;
  const recent = all.filter(function(c){ return c.at >= cut; });
  const widened = !recent.length;
  const pool = widened ? all : recent;

  const ranked = pool.slice().sort(function(a, b){ return a.id < b.id ? -1 : 1; });
  const top = ranked.filter(function(c){ return priority[c.contactId]; });
  const set = top.length ? top : ranked;
  const pick = set[coachHash(dateStr + ":" + agentId) % set.length];
  const lead = priority[pick.contactId] || null;
  const ageDays = Math.max(0, Math.round((Date.now() - pick.at) / 86400000));
  return Object.assign({}, pick, {
    contactName: lead ? lead.name : coachContactName(pick.contactId),
    stage: lead ? lead.stage : "",
    creator: lead ? lead.creator : "",
    score: lead ? lead.score : null,
    isPriority: !!lead,
    widened: widened,
    ageDays: ageDays,
    candidates: pool.length
  });
}
function coachContactName(id){
  const c = (CACHE.contacts || []).filter(function(x){ return String(x.id) === String(id); })[0];
  if (!c) return "Contact " + id;
  return [c.firstname, c.lastname].filter(Boolean).join(" ") || c.email || ("Contact " + id);
}

/* ---------- the three derived answers ----------
   Judged from the call and the contact as they stand now, so a manager never
   argues about whether the CRM was updated. */
function coachAuto(call){
  const c = (CACHE.contacts || []).filter(function(x){ return String(x.id) === String(call.contactId); })[0];
  const fu = c ? ts(c.follow_up_date_and_time) : 0;
  return {
    logged: call.disposition ? "yes" : "no",
    followup: (fu && fu > call.at) ? "yes" : "no",
    length: call.seconds >= COACH_MIN_SECONDS ? "yes" : "no"
  };
}

/* ---------- store ----------
   Sessions live in the org store beside teams and targets, on the same volume.
   Capped, because this grows every working day and the file is read whole. */
function coachStore(){
  if (!ORG.coaching) ORG.coaching = { sessions: [] };
  if (!Array.isArray(ORG.coaching.sessions)) ORG.coaching.sessions = [];
  return ORG.coaching;
}
function coachSessionsFor(agentId){
  return coachStore().sessions
    .filter(function(s){ return String(s.agentId) === String(agentId); })
    .sort(function(a, b){ return (b.date < a.date) ? -1 : 1; });
}
function coachTeamFor(req){
  const me = String(whoami(req) || "").toLowerCase();
  const teams = ORG.teams || [];
  if (isVP(req)) {
    const want = String(req.query.team || "");
    if (want) return teams.filter(function(t){ return t.id === want; })[0] || null;
    return teams[0] || null;
  }
  return teams.filter(function(t){ return String(t.managerEmail || "").toLowerCase() === me; })[0] || null;
}
function coachScore(items){
  let yes = 0, no = 0;
  COACH_KEYS.forEach(function(k){
    if (items[k] === "yes") yes++;
    else if (items[k] === "no") no++;
  });
  return { yes: yes, no: no, of: yes + no, pct: (yes + no) ? Math.round(yes * 100 / (yes + no)) : 0 };
}

/* ---------- routes ---------- */

// Today's five. Existing sessions are merged in so a half-finished day resumes
// where the manager left it, and a submitted one is never re-picked.
app.get("/api/coaching/today", function(req, res){
  const team = coachTeamFor(req);
  if (!team) return res.status(403).json({ error: "no team is mapped to " + (whoami(req) || "this account") });
  const date = String(req.query.date || coachIstDate());
  const store = coachStore();
  const done = store.sessions.filter(function(s){ return s.date === date && s.teamId === team.id; });
  // The day's five are locked once and then honoured. A manager arriving before the bell
  // locks it early rather than seeing a pick that could still move.
  const lock = coachAssignments()[coachAssignKey(date, team.id)] || coachLock(date, team, whoami(req));
  const agents = lock ? lock.rows.map(function(r){ return r.agentId; }) : coachPickAgents(team, date);
  const lockedOf = {};
  if (lock) lock.rows.forEach(function(r){ lockedOf[String(r.agentId)] = r; });

  const rows = agents.map(function(id){
    const existing = done.filter(function(s){ return String(s.agentId) === String(id); })[0];
    const owner = CACHE.owners[id] || {};
    const history = coachSessionsFor(id).filter(function(s){ return s.date < date && s.submittedAt; });
    const prev = history[0] || null;
    if (existing) {
      return { agentId: id, agentName: owner.name || ("Owner " + id), session: existing,
        call: existing.call || null, auto: existing.auto || {},
        prev: prev ? { date: prev.date, actionItem: prev.actionItem, score: prev.score } : null };
    }
    const a = lockedOf[String(id)];
    if (a) {
      return { agentId: id, agentName: owner.name || ("Owner " + id), session: null,
        call: a.call, auto: a.auto || {},
        prev: prev ? { date: prev.date, actionItem: prev.actionItem, score: prev.score } : null,
        reason: a.reason || "" };
    }
    // Only reached when the call buffer is empty, so nothing can be locked yet.
    return { agentId: id, agentName: owner.name || ("Owner " + id), session: null,
      call: null, auto: {},
      prev: prev ? { date: prev.date, actionItem: prev.actionItem, score: prev.score } : null,
      reason: "waiting for the call history to load" };
  });

  res.json({
    date: date, team: { id: team.id, name: team.name, managerEmail: team.managerEmail },
    teams: isVP(req) ? (ORG.teams || []).map(function(t){ return { id: t.id, name: t.name }; }) : [],
    items: COACH_ITEMS, rows: rows,
    callsLoadedAt: COACH.loadedAt, callsSyncing: COACH.syncing, callsError: COACH.error,
    callsPartial: !!COACH.partial, callsHeld: (COACH.calls || []).length,
    lockedAt: lock ? lock.at : null, lockHour: COACH_LOCK_HM,
    persistent: ORG_PERSISTENT, isVP: isVP(req), minSeconds: COACH_MIN_SECONDS,
    portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID }
  });
});

// Submit one review. The score is computed here, never accepted from the client,
// and a note is required against every item marked no.
app.post("/api/coaching/session", express.json(), function(req, res){
  const team = coachTeamFor(req);
  if (!team) return res.status(403).json({ error: "no team is mapped to this account" });
  const b = req.body || {};
  const date = String(b.date || coachIstDate());
  const agentId = String(b.agentId || "");
  if (!agentId) return res.status(400).json({ error: "agentId is required" });
  if ((team.agentIds || []).map(String).indexOf(agentId) < 0 && !isVP(req)) {
    return res.status(403).json({ error: "that agent is not on your team" });
  }

  const items = {}, notes = {};
  const missing = [];
  COACH_ITEMS.forEach(function(it){
    const v = String((b.items || {})[it.key] || "");
    items[it.key] = (v === "yes" || v === "no" || v === "na") ? v : "";
    const n = String((b.notes || {})[it.key] || "").trim();
    if (n) notes[it.key] = n.slice(0, 600);
    if (!it.auto && items[it.key] === "") missing.push(it.label);
    // Only the judged items need a note. The three derived ones are facts read out of
    // HubSpot, and the form offers no box against them, so demanding a note for a
    // missing follow up date made the review impossible to submit.
    if (!it.auto && items[it.key] === "no" && !n) missing.push("a note against: " + it.label);
  });
  const action = String(b.actionItem || "").trim();
  if (!action) missing.push("one action item");
  if (missing.length) return res.status(400).json({ error: "still needed: " + missing.join("; ") });

  const store = coachStore();
  const idx = store.sessions.findIndex(function(s){
    return s.date === date && String(s.agentId) === agentId && s.teamId === team.id;
  });
  const rec = {
    id: idx >= 0 ? store.sessions[idx].id : newId(),
    date: date, teamId: team.id, teamName: team.name,
    managerEmail: whoami(req), agentId: agentId,
    agentName: (CACHE.owners[agentId] || {}).name || ("Owner " + agentId),
    callId: String(b.callId || ""), call: b.call || null, auto: b.auto || {},
    items: items, notes: notes,
    actionItem: action.slice(0, 400),
    prevVerdict: ["done", "partial", "not_done", ""].indexOf(String(b.prevVerdict || "")) >= 0 ? String(b.prevVerdict || "") : "",
    recordingUrl: String(b.recordingUrl || "").trim().slice(0, 500),
    score: null, submittedAt: new Date().toISOString()
  };
  rec.score = coachScore(items);
  if (idx >= 0) store.sessions[idx] = rec; else store.sessions.push(rec);
  // Ninety days of five a day per manager is a few thousand records; cap well above
  // that so the file cannot grow without bound if the cadence sticks.
  if (store.sessions.length > 8000) store.sessions = store.sessions.slice(-8000);
  const saved = orgSave("coaching.session", rec.agentName + " " + date, whoami(req));
  res.json({ ok: true, persistent: saved && ORG_PERSISTENT, session: rec });
});

/* Progress, which is the whole point of running a cadence rather than keeping a log.
   One row per agent: how often they have been coached, where the score is going, and
   whether the thing they committed to last time actually happened. */
app.get("/api/coaching/progress", function(req, res){
  const team = coachTeamFor(req);
  if (!team) return res.status(403).json({ error: "no team is mapped to this account" });
  const store = coachStore();
  const now = Date.now();
  const agents = coachAgents(team);

  const rows = agents.map(function(id){
    const ss = coachSessionsFor(id).filter(function(s){ return s.submittedAt && s.teamId === team.id; });
    const last = ss[0] || null;
    const recent = ss.slice(0, 5);
    const pcts = recent.map(function(s){ return (s.score || {}).pct || 0; });
    const avg = pcts.length ? Math.round(pcts.reduce(function(a, b){ return a + b; }, 0) / pcts.length) : null;
    // Trend compares the last three against the three before them. Two sessions is
    // noise, so it stays null until there is enough to say anything.
    const a3 = ss.slice(0, 3).map(function(s){ return (s.score || {}).pct || 0; });
    const b3 = ss.slice(3, 6).map(function(s){ return (s.score || {}).pct || 0; });
    const mean = function(x){ return x.length ? x.reduce(function(p, q){ return p + q; }, 0) / x.length : null; };
    const trend = (a3.length >= 2 && b3.length >= 2) ? Math.round(mean(a3) - mean(b3)) : null;

    // The carry forward: last session set an action item, the session after it says
    // whether it landed. An item nobody has graded yet is the open one.
    const graded = ss.filter(function(s){ return s.prevVerdict; });
    const landed = graded.filter(function(s){ return s.prevVerdict === "done"; }).length;

    return {
      agentId: id,
      agentName: (CACHE.owners[id] || {}).name || ("Owner " + id),
      sessions: ss.length,
      lastDate: last ? last.date : "",
      daysSince: last ? Math.round((now - Date.parse(last.date + "T00:00:00Z")) / 86400000) : null,
      lastScore: last ? (last.score || {}) : null,
      avg5: avg,
      trend: trend,
      openAction: last ? last.actionItem : "",
      actionsGraded: graded.length,
      actionsLanded: landed,
      missingRecording: ss.filter(function(s){ return !s.recordingUrl; }).length,
      // Three failures in the last five sessions is a pattern rather than a bad day.
      persistentGaps: COACH_JUDGED.map(function(k){
        const fails = recent.filter(function(s){ return (s.items || {})[k] === "no"; }).length;
        return { key: k, fails: fails,
          label: (COACH_ITEMS.filter(function(i){ return i.key === k; })[0] || {}).label || k };
      }).filter(function(x){ return x.fails >= 3; }),
      history: ss.slice(0, 12).map(function(s){
        return { date: s.date, pct: (s.score || {}).pct || 0, yes: (s.score || {}).yes || 0,
          of: (s.score || {}).of || 0, actionItem: s.actionItem, prevVerdict: s.prevVerdict,
          recordingUrl: s.recordingUrl, contactName: (s.call || {}).contactName || "",
          contactId: (s.call || {}).contactId || "",
          notes: s.notes || {}, items: s.items || {} };
      })
    };
  }).sort(function(a, b){
    // Never coached first, then longest since, because that is the queue to fix.
    const ad = a.daysSince === null ? 9999 : a.daysSince;
    const bd = b.daysSince === null ? 9999 : b.daysSince;
    return bd - ad;
  });

  res.json({
    team: { id: team.id, name: team.name }, items: COACH_ITEMS, rows: rows,
    teams: isVP(req) ? (ORG.teams || []).map(function(t){ return { id: t.id, name: t.name }; }) : [],
    isVP: isVP(req), portal: { uiDomain: UI_DOMAIN, portalId: PORTAL_ID }
  });
});

// One agent's history: the trend, and whether each action item actually landed.
app.get("/api/coaching/agent/:id", function(req, res){
  const id = String(req.params.id || "");
  const sessions = coachSessionsFor(id).filter(function(s){ return s.submittedAt; });
  const owner = CACHE.owners[id] || {};
  res.json({
    agentId: id, agentName: owner.name || ("Owner " + id),
    items: COACH_ITEMS,
    sessions: sessions.slice(0, 40),
    // Which items keep coming back. Three failures in the last five sessions is a
    // pattern rather than a bad day, and it is what should reach the VP.
    persistent: COACH_JUDGED.map(function(k){
      const last5 = sessions.slice(0, 5);
      const fails = last5.filter(function(s){ return (s.items || {})[k] === "no"; }).length;
      const label = (COACH_ITEMS.filter(function(i){ return i.key === k; })[0] || {}).label || k;
      return { key: k, label: label, fails: fails, of: last5.length, flagged: fails >= 3 };
    }).filter(function(x){ return x.flagged; })
  });
});

/* Whether the cadence is actually running, which is a different question from
   whether the agents are improving. Named down to the individual review, because
   "3 of 5" invites the follow-up "which two", and a VP should not have to ask. */
/* Audit compliance for one IST day, shaped for the revenue dashboards rather than the
   coaching page. A manager owes one review per agent on rotation, capped at COACH_PER_DAY,
   so the honest denominator is the smaller of the two, not a flat five for a team of three. */
function coachDayDetail(date){
  const store = coachStore();
  const teams = {}, agents = {};
  (ORG.teams || []).forEach(function(t){
    const target = Math.min(coachAgents(t).length, COACH_PER_DAY);
    const done = store.sessions.filter(function(x){
      return x.date === date && x.teamId === t.id && x.submittedAt;
    });
    teams[t.id] = { name: t.name || "(unnamed)", manager: t.managerEmail || "",
      done: done.length, target: target };
    const touch = function(id){
      const k = String(id);
      if (!agents[k]) agents[k] = { due: 0, done: 0 };
      return agents[k];
    };
    coachDueAgents(t, date).forEach(function(id){ touch(id).due = 1; });
    done.forEach(function(x){ touch(x.agentId).done = 1; });
  });
  return { teams: teams, agents: agents };
}

/* Locking the day's five.
   The pick is deterministic for a given agent, date and candidate set, but the candidate
   set moves: calls sync in hourly, leads enter and leave the priority segments, and the
   in-memory buffer rebuilds on every deploy. So an unstarted card could change under a
   manager mid-morning, which also weakens the whole point of a pick nobody chooses.
   The day's five are therefore written once, at COACH_LOCK_HM, and honoured from then on.
   A manager who opens the page before that hour locks it early, which is the same
   guarantee reached by a different door. */
const COACH_LOCK_HM = process.env.COACH_LOCK_HM || "09:30";

function coachAssignments(){
  const store = coachStore();
  if (!store.assignments || typeof store.assignments !== "object") store.assignments = {};
  return store.assignments;
}
function coachAssignKey(date, teamId){ return date + "|" + teamId; }

function coachLock(date, team, who){
  const all = coachAssignments();
  const key = coachAssignKey(date, team.id);
  if (all[key]) return all[key];
  // Never lock a day against an empty or still-loading buffer: that would freeze "no call
  // to review" for everyone and there would be no way back without editing the store.
  if (!COACH.loadedAt || !(COACH.calls || []).length) return null;
  const doneCallIds = coachStore().sessions
    .filter(function(s){ return s.date === date && s.teamId === team.id; })
    .map(function(s){ return s.callId; });
  const taken = doneCallIds.slice();
  /* Walk the whole roster from today's offset rather than taking the first five.
     A manager handed three reviewable agents and two blanks does three, and a cadence
     that quietly shrinks stops being a cadence. Agents with nothing to review are
     skipped, keep their turn, and come round on the next cycle. */
  const order = coachRotationOrder(team, date);
  const rows = [];
  const skipped = [];
  order.forEach(function(id){
    if (rows.length >= COACH_PER_DAY) return;
    const call = coachPickCall(id, date, taken);
    if (!call) { skipped.push(String(id)); return; }
    taken.push(call.id);
    rows.push({ agentId: String(id), callId: call.id, call: call, auto: coachAuto(call), reason: "" });
  });
  // Only if the whole roster is dry does a blank slot appear, and it says so.
  skipped.forEach(function(id){
    if (rows.length >= COACH_PER_DAY) return;
    rows.push({ agentId: String(id), callId: "", call: null, auto: {},
      reason: "no call over " + COACH_MIN_SECONDS + "s in the last " +
        Math.round(COACH_MAX_HOURS / 24) + " days" });
  });
  all[key] = { at: new Date().toISOString(), by: who || "system", date: date,
    teamId: team.id, rows: rows };
  // Assignments are only interesting while the day is open or being reviewed the morning
  // after. Thirty days is generous and keeps the store small enough to rewrite often.
  const keys = Object.keys(all).sort();
  while (keys.length > 30 * Math.max(1, (ORG.teams || []).length)) { delete all[keys.shift()]; }
  if (typeof orgSave === "function") orgSave("coach.lock", key, who || "system");
  console.log("Coaching locked " + key + ": " + rows.filter(function(r){ return r.callId; }).length +
    " of " + rows.length + " agents have a call");
  return all[key];
}

// Runs on a timer. Locks every team once the hour has passed, and keeps trying through
// the day so a call sync that was still failing at the bell does not cost the whole day.
function coachLockDue(){
  if (typeof ORG === "undefined") return;
  const date = coachIstDate();
  if (istParts(new Date()).hm < COACH_LOCK_HM) return;
  (ORG.teams || []).forEach(function(t){ coachLock(date, t, "system"); });
}

app.post("/api/coaching/resync", function(req, res){
  if (COACH.syncing) return res.json({ ok: true, running: true });
  // Independent of the Revenue command refresh on purpose: nothing here touches CACHE.
  guard("coachCallsManual", syncCoachCalls)();
  res.status(202).json({ ok: true, running: true });
});

app.get("/api/coaching/summary", function(req, res){
  if (!isVP(req)) return res.status(403).json({ error: "VP access only" });
  const store = coachStore();
  const today = String(req.query.date || coachIstDate());
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(Date.parse(today + "T00:00:00Z") - i * 86400000).toISOString().slice(0, 10));
  }
  const week = store.sessions.filter(function(s){ return s.submittedAt && days.indexOf(s.date) >= 0; });

  const teams = (ORG.teams || []).map(function(t){
    const mine = week.filter(function(s){ return s.teamId === t.id; });
    const agents = coachAgents(t);
    const expectedDaily = Math.min(agents.length, COACH_PER_DAY);
    const covered = {};
    mine.forEach(function(s){ covered[String(s.agentId)] = 1; });
    const scores = mine.map(function(s){ return (s.score || {}).pct || 0; });
    const avg = scores.length ? Math.round(scores.reduce(function(a, b){ return a + b; }, 0) / scores.length) : null;

    // Today, named. Who was due, who was reviewed, and who is outstanding.
    const dueToday = coachDueAgents(t, today);
    const doneToday = {};
    store.sessions.forEach(function(s){
      if (s.date === today && s.teamId === t.id && s.submittedAt) doneToday[String(s.agentId)] = s;
    });
    const rowOf = function(id, extra){
      const s = doneToday[id];
      return { agentId: id, agentName: (CACHE.owners[id] || {}).name || ("Owner " + id),
        done: !!s, at: s ? s.submittedAt : null, score: s ? (s.score || {}) : null,
        recording: s ? !!s.recordingUrl : false, extra: !!extra };
    };
    // The rotation is the list of who was due, but a review done on someone outside
    // it is still a review done. Count both, show the extras separately.
    const todayRows = dueToday.map(function(id){ return rowOf(id, false); })
      .concat(Object.keys(doneToday).filter(function(id){ return dueToday.indexOf(id) < 0; })
        .map(function(id){ return rowOf(id, true); }));

    // Seven day strip, so a manager who does ten on Monday and nothing after is
    // not hidden behind a healthy weekly total.
    const daily = days.slice().reverse().map(function(d){
      const n = store.sessions.filter(function(s){ return s.date === d && s.teamId === t.id && s.submittedAt; }).length;
      return { date: d, done: n, expected: expectedDaily };
    });

    const lastAt = mine.map(function(s){ return Date.parse(s.submittedAt); }).sort(function(a, b){ return b - a; })[0] || null;

    return {
      teamId: t.id, name: t.name, managerEmail: t.managerEmail,
      agents: agents.length,
      todayDone: todayRows.filter(function(r){ return r.done; }).length,
      todayExpected: expectedDaily,
      todayRows: todayRows,
      daily: daily,
      sessions7d: mine.length, expected7d: expectedDaily * 5,
      coveredAgents: Object.keys(covered).length,
      neverCoached: agents.filter(function(id){
        return !store.sessions.some(function(s){ return String(s.agentId) === id && s.submittedAt; });
      }).map(function(id){ return (CACHE.owners[id] || {}).name || id; }),
      // A manager who marks everyone at ninety is not coaching, and comparing their
      // average against the org is the only number that shows it.
      avgScore: avg,
      missingRecording: mine.filter(function(s){ return !s.recordingUrl; }).length,
      lastActivity: lastAt ? new Date(lastAt).toISOString() : null
    };
  });

  const all = week.map(function(s){ return (s.score || {}).pct || 0; });
  res.json({
    teams: teams, today: today,
    orgAvg: all.length ? Math.round(all.reduce(function(a, b){ return a + b; }, 0) / all.length) : null,
    total7d: week.length,
    expected7dOrg: teams.reduce(function(a, t){ return a + t.expected7d; }, 0),
    todayDoneOrg: teams.reduce(function(a, t){ return a + t.todayDone; }, 0),
    todayExpectedOrg: teams.reduce(function(a, t){ return a + t.todayExpected; }, 0)
  });
});

// Railway sends SIGTERM on every redeploy. Exiting cleanly turns what it otherwise
// reports as a crash into a normal shutdown. Requires the start command to be
// "node server.js", not "npm start", or npm swallows the signal as PID 1.
function shutdown(sig){
  console.log(sig + " received, shutting down cleanly");
  try { if (typeof ORG !== "undefined" && ORG_PERSISTENT) orgSave("shutdown", sig, "system"); } catch (e) {}
  const t = setTimeout(function(){ process.exit(0); }, 8000);
  if (t.unref) t.unref();
  if (SERVER) SERVER.close(function(){ process.exit(0); });
  else process.exit(0);
}
process.on("SIGTERM", function(){ shutdown("SIGTERM"); });
process.on("SIGINT", function(){ shutdown("SIGINT"); });

let LAST_500 = null;
app.use(function(err, req, res, next){
  LAST_500 = { at: new Date().toISOString(), path: req.path,
    message: (err && err.message) || String(err),
    stack: String((err && err.stack) || "").split("\n").slice(0, 4).join(" | ") };
  console.error("500 on " + req.path + ": " + LAST_500.message + " :: " + LAST_500.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: LAST_500.message, path: req.path });
});

let SERVER = null;
SERVER = app.listen(PORT, () => {
  console.log("Listening on " + PORT);
  guard("sync", function(){ return sync().then(() => syncCounsel()); })();
  // Deltas every few minutes, full rebuild only on boot and every FULL_SYNC_HOURS.
  setInterval(guard("delta", syncDelta), DELTA_MINUTES * 60 * 1000);
  setTimeout(function(){ adoptStoredCreators(); }, 3000);
  setTimeout(guard("snapshot", snapshotToday), 4 * 60 * 1000);
  setInterval(guard("snapshot", snapshotToday), 15 * 60 * 1000);
  guard("sheet", function(){ return syncSheet().then(() => syncCohorts()); })();
  setInterval(guard("sync", sync), Math.max(1, FULL_SYNC_HOURS) * 3600 * 1000);
  setInterval(guard("sheet", syncSheet), SYNC_MINUTES * 60 * 1000);
  setInterval(guard("cohorts", syncCohorts), COHORT_MINUTES * 60 * 1000);
  setInterval(guard("counsel", syncCounsel), COHORT_MINUTES * 60 * 1000);
  setTimeout(guard("calls", syncCalls), 90 * 1000);
  // Rebuild yesterday from HubSpot history if no live snapshot exists for it. No-ops
  // once stored, so the hourly repeat is just a retry until counselling and sheet land.
  setTimeout(guard("backfill", function(){ return snapBackfill(yesterdayKey()); }), 9 * 60 * 1000);
  setInterval(guard("backfill", function(){ return snapBackfill(yesterdayKey()); }), 3600 * 1000);
  setInterval(guard("calls", syncCalls), COHORT_MINUTES * 60 * 1000);
  /* Coaching runs on its own clock and its own state. It shares nothing with the lead
     sync behind Revenue command, so a failure on either side leaves the other alone.
     Offset from the lead syncs so the two are not competing for the same rate limit at
     the same second, and retried in five minutes rather than an hour when it fails. */
  setTimeout(guard("coachCalls", syncCoachCalls), 200 * 1000);
  // Lock the day's five at the bell, and keep retrying through the day so a call sync
  // that was still failing at 09:30 does not cost the whole day.
  setInterval(guard("coachLock", coachLockDue), 5 * 60 * 1000);
  // Freeze the Call Now v2 denominator at the bell, then leave it alone all day.
  // Build the v2 list in the background, never inside a request.
  // First attempt as soon as the lead cache lands, then keep trying: the early ones are
  // no-ops until there is something to build from.
  setTimeout(guard("cn2Build", function(){ return cn2Build(); }), 25 * 1000);
  setInterval(guard("cn2Build", function(){ return cn2Build(); }), 60 * 1000);
  setInterval(guard("cn2Freeze", cn2FreezeDue), 5 * 60 * 1000);
  setTimeout(guard("cn2Freeze", cn2FreezeDue), 300 * 1000);
  setTimeout(guard("coachLock", coachLockDue), 260 * 1000);
  setInterval(guard("coachCalls", syncCoachCalls), 60 * 60 * 1000);
  setInterval(guard("coachRetry", function(){
    if (COACH.syncing) return;
    if (!COACH.error && COACH.loadedAt) return;
    console.log("Coach calls: retrying after " + (COACH.error ? "error" : "no data yet"));
    return syncCoachCalls();
  }), 5 * 60 * 1000);
  setInterval(guard("leadsToday", maybeRunLeadsTodayCheckpoint), 60 * 1000);
  guard("leadsTodayBoot", bootstrapLeadsTodayOnBoot)();
  guard("backupPool", syncBackupPool)();
  setInterval(guard("backupPool", syncBackupPool), COHORT_MINUTES * 60 * 1000);
  setTimeout(runChain, 150 * 1000);
  setInterval(runChain, COHORT_MINUTES * 60 * 1000);
});
