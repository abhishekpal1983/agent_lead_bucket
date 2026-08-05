# Call Now v2

## The words this page uses

| Word on the page | What it means |
|---|---|
| Today's calling list | Every lead that needed attention when the day started. Locked at midnight and never changed during the day |
| Call today | Leads that need a call today |
| Booked for a later date | The next call is set for a future day, so nothing is owed today |
| Did not pick up, nothing to act on today | People who did not answer and have no reason to be called today. Kept apart so they do not make the call-today list look bigger |
| Due today | The follow-up date is today |
| Overdue | The follow-up date has passed and a full working day has gone by without a call |
| No FU | Nobody set a next-call date on this lead |
| Fresh | A brand new lead nobody has ever rung |
| Refilled form | They filled the form again after the last call, so they are asking a second time |
| IFC due | They said interested in future and the date they asked for has arrived |
| Called but not on today's calling list | Calls made on leads that arrived after midnight. Real work, just not part of today's plan |
| Test data, not real | The page is running on made-up leads so it can be checked without touching HubSpot |

# Local development

Nothing in v2 touches the live Call Now page or its endpoint. Work on the `v2` branch.

## Run the model tests, no network, no token
    node test/cn2.test.js

## Run the whole app on fixtures, no HubSpot token needed
    CN2_FIXTURES=1 PORT=3999 DATA_DIR=/tmp/cn2data node server.js
    open http://localhost:3999/callnow2.html

The fixture set is deterministic and holds one lead of every awkward shape: a 2pm
follow-up today, a Sunday follow-up, a DNP with a lapsed date and no priority signal,
an IFC due and an IFC overdue, a refill on a ghosted lead, refills on deal-won and
disqualified that must be ignored, a form that predates the last call, an unassigned
lead, and three leads that arrived after the base was frozen.

## Environment
| Variable | Default | Meaning |
|---|---|---|
| `CN2_FREEZE_HM` | `00:05` | When the day's base is frozen, IST |
| `WORK_DAYS` | `1,2,3,4,5,6` | Working days, 0 is Sunday. Drives the overdue rule |
| `CN2_FIXTURES` | off | Local only. Never set this in Railway |
