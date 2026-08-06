# Call Now v2

**The rules live in [RULES.md](RULES.md).** That file is the contract: entry, exit,
timings, what counts as called, and what resets when. If the code and that file disagree,
one of them is a bug.

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

## How this stays correct

Three layers, deliberately, because each catches what the others cannot.

**1. Invariants, on every request.** `lib/checks.js` runs eight rules every time the page is
built: every lead is counted or held aside, stage rows add to their section, each lead has
exactly one timing, "any priority" is deduplicated rather than summed, called never exceeds
the population it is measured against, the headline divides one population by itself,
effort bands cover every lead exactly once, and agent rows account for the same leads the
floor does. If one fails the page says so at the top, above the numbers, and names the
check. A number that is quietly wrong is worse than a page that is visibly broken.

**2. Drift against HubSpot, on a timer.** The invariants only prove the page agrees with
itself. Every twenty minutes the app asks HubSpot how many leads were called today and
compares. Some gap is expected, this page holds only tracked creators and certain stages,
so the check watches the size of the gap rather than demanding zero. Over 20% it warns,
over 40% it says so on the page and in the logs.

**3. The full accounting, on demand.** "Check what is outside" asks HubSpot for every lead
called today and sorts each into why it does or does not appear here: on the list, created
after the lock, in the pool but not on the list, untracked creator, no creator, a stage
this page does not carry, or never pulled at all. The bottom row states whether the parts
add back to HubSpot's total, and says plainly if they do not.

# Local development

Nothing in v2 touches the live Call Now page or its endpoint. Work on the `v2` branch.

## Run every test before pushing, no network, no token
    ./run-tests.sh              # all of it, in the order that fails fastest

Or one at a time:

    node test/cn2.test.js        # the model: overdue rules, sections, the frozen base
    node test/pool.test.js       # the concurrency helper used by the boot sync
    node test/sync.test.js       # the two phase boot sync, same output, much faster
    node test/scope.test.js      # who can see whose leads: agent, manager, VP
    node test/page.test.js       # renders the browser code as each role, drill open
    node test/endpoints.test.js  # boots the real server on fixtures and calls every endpoint

The last two are the important ones. `node --check` only finds syntax errors, so a missing
variable, or a function a patch deleted, sails straight past it and reaches production.
Three separate outages in this project came from exactly that. `page.test.js` runs the
browser code, `endpoints.test.js` calls the real server. Neither can miss it.

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
