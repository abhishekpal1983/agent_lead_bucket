# Agent Lead Bucket Health

Live HubSpot dashboard for sales agent lead bucket health: workable vs churned pipeline, lead freshness, follow up hygiene, call effort per stage, creator (topmate_username) splits, NI reasons pre vs post counselling, student vs professional mix, and per agent x creator challenge diagnosis with actionables.

## How it works

- `server.js` (Node + Express) syncs all owned, staged contacts from HubSpot into memory on boot and every 30 minutes, then serves aggregated JSON at `/api/*`.
- `public/index.html` is the dashboard UI. No CRM credentials ever reach the browser.

## Deploy on Railway

1. Create a HubSpot **private app** token: HubSpot > Settings > Integrations > Private Apps > Create app. Scopes needed: `crm.objects.contacts.read`, `crm.objects.owners.read`.
2. In Railway: New Project > Deploy from GitHub repo > pick this repo.
3. Add environment variables:
   - `HUBSPOT_TOKEN` = your private app token (required, keep it only in Railway, never commit it)
   - `SYNC_MINUTES` = 30 (optional)
   - `HS_PORTAL_ID` = 244132076 (optional, for HubSpot record links)
   - `HS_UI_DOMAIN` = app-na2.hubspot.com (optional)
4. Deploy. First sync takes a few minutes (it pages through every owner's staged contacts); the page auto-retries until data is ready.
5. Railway gives you a public URL. Put it behind access control (Railway private networking, an auth proxy, or at minimum an unguessable domain) since the dashboard exposes lead names and phone-level activity.

## Background sync every 10 minutes

The web service already re-syncs itself every `SYNC_MINUTES` (default 10) while running. If you also want Railway-managed cron (useful if the service ever sleeps, or you want sync on a strict schedule):

1. In the same Railway project: New > Service > from this same GitHub repo.
2. On the new service, set Settings > Start Command to `node cron.js` and Settings > Cron Schedule to `*/10 * * * *`.
3. Add env var `APP_URL` = the public URL of the dashboard service (e.g. `https://your-app.up.railway.app`).
4. Optional hardening: set `REFRESH_KEY` to the same random string on BOTH services so only the cron job can trigger `/api/refresh`. Note: if you set it, the UI Re-sync button will be blocked (403), which is fine.

The cron service runs, POSTs `/api/refresh` on the web service, and exits. The web service does the actual HubSpot sync in the background.

## Local run

```
HUBSPOT_TOKEN=xxx npm install && npm start
# open http://localhost:3000
```

## Endpoints

- `GET /api/meta` sync status
- `GET /api/agents?creator=` per agent metrics
- `GET /api/drill/:ownerId?creator=` creator matrix, stage call depth, NI reasons, age, student split
- `GET /api/leads?owner=&stage=&creator=` lead level call depth
- `GET /api/summary?creator=&agent=` agent x creator challenge cells
- `POST /api/refresh` force re-sync

## Security notes

- Never commit tokens to this repo. `HUBSPOT_TOKEN` lives only in Railway env vars.
- The search sync is partitioned per owner to stay under HubSpot's 10k-per-search cap; owners with more than ~10k staged leads would be truncated.
