# Call Now v2, local development

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
