/* Railway cron entrypoint: triggers a HubSpot re-sync on the web service and exits.
 * Use this as a SECOND Railway service from the same repo:
 *   Start command: node cron.js
 *   Cron schedule: *_/10 * * * *   (remove the underscore; markdown-safe here)
 * Env vars:
 *   APP_URL     - public URL of the dashboard service, e.g. https://agentleadbucket-production.up.railway.app
 *   REFRESH_KEY - optional, must match the web service's REFRESH_KEY if set
 */
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const KEY = process.env.REFRESH_KEY || "";
if (!APP_URL) { console.error("APP_URL env var is not set"); process.exit(1); }
fetch(APP_URL + "/api/refresh" + (KEY ? "?key=" + encodeURIComponent(KEY) : ""), { method: "POST" })
  .then(async r => {
    console.log("refresh status", r.status, await r.text());
    process.exit(r.ok ? 0 : 1);
  })
  .catch(e => { console.error("refresh failed:", e.message); process.exit(1); });
