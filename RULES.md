# Call Now: the rules, in plain English

This is the contract. If the code and this file ever disagree, one of them is a bug.
Every rule here is enforced by a test in `test/`, named so you can find it.

Rules marked **Confirmed** with a date were decided by the business, not by whoever wrote
the code. Do not change those without asking.

---

## 1. The list

**One list a day.** At **00:05 IST** the app writes down every lead that matters, and that
written-down list is what the whole page measures against for the rest of the day.

**What goes on it.** A lead is written down if all three are true:

1. Its creator is on the **tracked creator list**.
2. Its stage is one the page carries: the eleven working stages, plus **IFC** only when its
   date has arrived, plus **ghosted** and **not interested** only if the lead has filled the
   form again since the last call. Deal won and disqualified never go on, whatever happens.
3. That is it. There is no fourth condition.

**Leads that are shown but not counted.** Unassigned leads, leads whose owner has left, and
parking buckets go on the list and appear everywhere, but are excluded from every total.
They are visible so the work does not disappear, and excluded so nobody is measured against
leads they cannot call. Section 11 has the full table.

**Nothing joins the list after 00:05.** A lead created at 11am is not on today's list, and
never will be. It appears as *created after the list locked*, which is real work, counted
separately, and not part of this morning's plan.

**Nothing leaves the list before midnight.** Not by changing stage, not by getting a new
follow-up date, not by being handed to another agent, not by having its creator untracked.
The lead was on the list this morning; it stays on the list until the list is replaced.

**One thing can change during the day, and it can only add.** A lead nobody was working can
be routed to a working agent, and from that moment it counts. Nothing that already counts is
ever taken back out. Section 11.

---

## 2. Where a lead sits on the list

Each lead is put in exactly **one of three groups**, decided at 00:05 and never revisited:

| Group | What is in it |
|---|---|
| **Call today** | Everything that is not in one of the two below |
| **Booked for a later date** | The follow-up is dated for a future day |
| **DNP, nothing to act on** | Did not pick up, and carries no form, no score of 6 or more, not international, not fresh |

Inside its group, each lead gets exactly **one timing**:

| Timing | Meaning |
|---|---|
| **Due today** | The follow-up is dated today |
| **Overdue** | The follow-up date has passed **and** a full working day has gone by |
| **No FU** | No next-call date was ever set |
| **Fresh** | No engagement stage has ever been set, and no follow-up date. See section 10 |
| **Later date** | The follow-up is dated for a future day |

And any number of **reasons to call**, which overlap on purpose:

form, score 6 or more, international, fresh, refilled form, IFC due, needs owner.
**Any priority** is the deduplicated count of those. It is never a sum of them.

**Needs owner is deliberately not part of any priority.** Confirmed 7 August 2026. A lead
with no owner, or with a deactivated owner, needs someone assigned to it. That is a routing
job for a manager, not a call for an agent, so it never inflates the calling queue. It is
still a column of its own, so the pile stays visible and can be worked deliberately.

---

## 3. Overdue

A follow-up dated **6 August at 2pm** is **due today** for all of 6 August, including at
11pm. It becomes **overdue** on 7 August, and only if a working day has passed.

A follow-up dated on a **non-working day** rolls forward. A Sunday follow-up reads as **due**
on Monday, not overdue, because nobody could have called it.

**Working days are Monday to Saturday.** Confirmed 7 August 2026. Sunday is the only
non-working day, so a Sunday follow-up is the only one that rolls forward. Set by
`WORK_DAYS` if the floor ever changes, and changing it moves the overdue number for every
lead, so it is not a casual edit.

---

## 4. Called

**Called today** means the lead's last call falls inside today, IST midnight to midnight.

The call is counted **against the cell the lead was in this morning**, not where it is now.
A lead that was Counselled, was called at 10am, and was marked Not Interested at 11am is
still counted as a Counselled lead that was called. Its stage change moves nothing.

The same holds if the lead **leaves the pool entirely**. If it stops qualifying, or its
creator is untracked, the app looks it up in the wider set of leads it holds so the call is
not lost. Only a lead the app cannot see at all reads as not called.

Credit stays with **the agent who held the lead this morning**. Handing a lead to someone
else at 4pm moves nothing, so nobody's percentage can be improved by reshuffling.

---

## 5. The headline number

**Called today, of the leads that need a call** counts only the *Call today* group, with
parking buckets excluded. Both halves of the fraction are that same population.

Every other count of "called" on the page is a different population and is labelled as such.
The ladder in **Check what is outside** breaks the difference down line by line.

---

## 6. What resets, and when

| Thing | When it changes |
|---|---|
| The list, and every lead's group, timing and reasons | 00:05 IST, once |
| Who is credited for a lead | 00:05 IST, once |
| Whether a lead has been called | Continuously, all day |
| Attempt counts and churn bands | Continuously, all day |
| Everything else on the page | Follows one of the two above |

Pressing **Lock again using right now** throws today's list away and takes a fresh one from
this moment. It is for a list that was captured wrongly, not for daily use.

---

## 7. What is deliberately not counted

- Creators not on the tracked list
- Deal won and disqualified, always
- Ghosted and not interested, unless the form was refilled
- IFC before its date arrives
- Parking buckets and unassigned leads, in totals only; they are still shown

Each of these appears as its own line in **Check what is outside**, so every call HubSpot
recorded today is accounted for rather than argued about.

---

## 8. Who gets the revenue

**A payment follows the agent, not the creator.**

Revenue Command counts a payment for the manager who has that **agent** mapped under him.
The creator mapping decides one thing only: whose **target** a creator sits against.

So if an agent on Priya's team books a sale for a creator mapped to Rahul:

| | Priya (owns the agent) | Rahul (owns the creator) |
|---|---|---|
| The money | Counted here | Not counted |
| The creator target | Untouched | Untouched, still Rahul's |
| Where it shows | A single **Creators mapped to another team** row at the foot of Priya's creator list, with no target and a blank gap column | Nowhere |

Expanding that row shows which agent did it, and hovering it lists the creators involved.

Before 7 Aug 2026 this revenue landed on nobody. The aggregate is bucketed by the agent's
team, so it could never reach Rahul, and a filter that only kept mapped creators removed it
from Priya. The floor total quietly undershot the payment sheet by that amount. The rule is
now pinned by `test/revenue.test.js`.

The one case that is still counted nowhere is a payment booked by an agent who belongs to no
team at all. That is a mapping gap rather than a rule, and it is called out by name in
**Revenue not counted** on the Revenue Command page.

---

## 9. Call coaching: who is on the day's list

**An audit needs a call.** Only agents who have a reviewable call go on the list.

A call is reviewable when it ran past 90 seconds and is attached to a lead, within the
last five days. The list is drawn by walking the whole team rotation and taking the first
five agents who have one.

| | What happens |
|---|---|
| Five or more agents have a call | Five are listed, the day owes 5 |
| Only three do | Three are listed, the day owes 3, and compliance reads 3/3 |
| Nobody does | The list is empty and the day owes nothing |
| An agent has no call | Named under the list, not shown as a card, keeps their turn in the rotation |

So the denominator is never a slot a manager cannot fill. 5/5 means five calls were
actually listened to.

Before 7 Aug 2026 the day was padded to five with blank cards, and the walk stopped at
five including the blanks, which could leave a reviewable agent off the list. Locks
written under the old rule are repaired once, on the next read, and the blanks are
dropped. The rule is pinned by `test/coach.test.js`.

The list is still locked once at 09:30 IST and honoured for the rest of the day.

---

## 10. Fresh leads

**Fresh means no engagement stage has ever been set in HubSpot.** That is the whole test.

Not age. Not source. Not created date. **Not call history.** A lead with four calls logged
against it and no stage set is Fresh, because nobody recorded what happened. Confirmed
7 August 2026. This is why the Fresh row can show calls today, and a Fresh row with a lot
of calls on it is a stage-setting problem, not new work.

**How they get on the list.** One HubSpot search per tracked creator, for contacts where
`contact_engagement_stage` is absent. They are pulled **by creator, not by owner**, so who
holds them, or whether anybody does, has nothing to do with whether they appear.

**Where they sit.**

| The lead has | Timing | Group |
|---|---|---|
| No follow-up date | Fresh | Call today |
| A follow-up dated today | Due today | Call today |
| A follow-up dated in the past | Overdue, by the normal working-day rule | Call today |
| A follow-up dated ahead | Later date | Booked for a later date |

Fresh is a **reason to call in its own right**, and it has its **own column**, so a brand
new lead never inflates *No FU marked*. Set `FRESH_IS_PRIORITY=0` to make fresh leads need
another signal before they enter the queue.

**How they leave.** Only by somebody setting an engagement stage, at the next sync. They
never age out and no number of calls removes them. Subject to section 1, a lead that leaves
this way still stays on today's list until midnight.

---

## 11. Owner state: who is counted

A lead that nobody is working is **a routing job for a manager, not a call for an agent**.
It must be visible, and it must not sit in an agent's denominator.

| Who holds the lead | On the list | In the totals | Whose job |
|---|---|---|---|
| A working agent | Yes | **Yes** | Call it |
| An agent who has left | Yes | No | Manager reassigns it |
| Nobody at all | Yes | No | Manager assigns it |
| A parking bucket, the four named ids | Yes | No | Manager distributes it |

**Routing during the day promotes a lead.** Confirmed 7 August 2026. The moment a lead with
no owner, or an owner who has left, is given to a working agent, three things change and
nothing else:

1. It starts counting, so the denominator grows.
2. The credit for any call on it moves to the new agent, because the morning owner was nobody.
3. It stops appearing in the *Needs owner* column.

Its stage row, its group and its timing stay exactly as written at 00:05.

**It can only ever add.** A lead already counted this morning is never taken out, not even if
its agent is deactivated at noon. A denominator that can shrink can be gamed, so it cannot
shrink.

**A list written before this rule is corrected once, on read.** Locks taken before 7 August
2026 counted leads held by an agent who had already left. Those are put back out of the
totals the first time the list is read, so a day captured under the old behaviour reports
the same numbers as one captured under the new. It fires only where the morning list already
recorded that nobody was working the lead, so it can never demote a lead whose agent was
working at midnight. From the next lock it does nothing.

**Parking buckets are not part of this.** They have a real, working owner and were never
asking to be routed, so handing one out mid-day does not promote it. That keeps a manager
from collapsing the floor's coverage by distributing three hundred leads at 5pm. Calls on
those leads still show, in *worked outside this morning's list*.

The number promoted today is shown on the page, under the locked-list note and as its own
row in *What happened to this morning's list*, so a denominator that grew is never a mystery.
Pinned by `test/cn2.test.js`.

---

## 12. One model, everywhere

**Confirmed 7 August 2026.** Call Now v2 is the model. It is not a second opinion.

`/callnow.html` serves v2. v1 is dormant, its page parked at `/callnow-v1.html` and its
API untouched. Which one the link serves is decided by `CALLNOW_DEFAULT` in Railway, so a
rollback is a variable change, not a deploy.

These now read the same frozen list, through the same function, `cn2Snapshot`:

| Surface | What it takes from v2 |
|---|---|
| Call Now | The whole page |
| Revenue Command, Overview | Queue, due, done, missed, overdue, uncalled, worked, needs owner, and the per-segment coverage |
| Daily review | Every counter in the day's snapshot |
| Coaching | Whether the reviewed call was on a priority lead |

**What deliberately did NOT move.** Revenue, enrolments, counsellings, leads created,
the L2C cohort, churned and worked are questions about the whole tracked pool for a
month, not about today's calling list. Narrowing them to the day's list would quietly
change the denominator of L2C and C2E every morning. They still read the full pool.

**The one place v1 still runs** is the v1-against-v2 reconciliation, which needs both
sides to compare. That is the point of it.

Snapshot version is now 3. Days captured under version 2 were measured on v1 definitions
and are refrozen rather than carried forward, so the Daily review never compares a day
measured one way against a day measured another.

---

## 13. HubSpot segments

A manager can narrow the page to a **HubSpot segment** (a List in the API). Managers and
VPs only; an agent works the list they are given.

**It filters today's list, it does not replace it.** Picking a segment shows the people in
it **that are on today's calling list**. The page states how many of the segment fell
outside, and why: outside the tracked creators, in a closed stage, or booked for a later
day. Nothing is dropped without a number against it.

That is deliberate. If a segment brought its own population in, the denominator would stop
being today's frozen list and every coverage percentage on the page would mean something
different depending on whether a filter was set.

The catalogue of segments is held for ten minutes. A segment's membership is fetched once
and held for the rest of the day, because a segment of eleven thousand people is a hundred
and ten HubSpot calls. The first pick of a large segment takes a few seconds and the page
says so rather than showing an empty list.

---

## 14. How fresh the numbers are

The app does not watch calls. It re-reads **contacts** from HubSpot and copies across two
properties, `last_call_date_and_time` and `follow_up_date_and_time`. Everything about
"called today" rests on those.

**The sweep runs every 10 minutes** and walks contacts in the order they changed, carrying
on from where the last run stopped. A run that runs out of time is behind, not blind: it
resumes from the same moment next time. The position survives a restart.

**Nothing is capped silently.** The per-agent load pages by record id, which has no
ceiling; if it ever does stop early it says so on the health page and in the log. Before
7 August 2026 both walks gave up quietly, which lost newly created leads for hours at a
time without anything looking wrong.

**The page reports coverage, not activity.** "Up to date as of 4 min ago" means the app
has caught up with HubSpot to that moment. It turns amber past twice the sweep interval
and red past four times, when the sweep has failed, or when the last run did not catch up.
A sweep that runs perfectly every ten minutes and covers nothing is the failure this is
designed to expose.

**Refresh this lead** re-reads one contact immediately, from the queue or the lead card.
It is the escape hatch, not the mechanism: one API call, merged through the same path the
sweep uses, so there is no second way for a lead to enter the app.

---

## 15. Counselling, counted two ways

**Ours.** The **first time** a contact entered any of these eight, read from engagement
stage history, credited to whoever holds the lead now:

`discovery` · `program_pitched` · `pricing_pitched` · `counselled` · `payment_prospect` ·
`Follow up` · `FU_DNP` · `FU_RCB`

Confirmed 11 August 2026. It answers **did this lead get engaged at all**, which is what
the calling floor is judged on.

**The Counselled QA tool's.** A narrower four: `counselled`, `program_pitched`,
`pricing_pitched`, `payment_prospect`. It also differs in two ways that are easy to miss:

| | This app | Counselled QA |
|---|---|---|
| Stages | 8 | 4 |
| Which moment | First ever entry | Latest entry into the stage the lead is in **now** |
| Lead that moved on | Still counted | **Dropped**, its rows deleted |

That last row matters for a review: their historical daily numbers can change after the
fact, because a lead counselled yesterday that moves to DNP today disappears from
yesterday. Ours cannot change once the day is past.

**So both are on the page.** Agent day and the Daily review show **Counsellings** and
**QA scope** side by side, the second being the subset that reached counselled or beyond.
Neither is wrong; they answer different questions, and showing both stops two dashboards
arguing in a meeting.

Days captured before 11 August 2026 show a dash rather than a zero for QA scope, because
that counter did not exist when they were frozen. Snapshot version 5.

---

## 16. Why a deploy can silently not happen

Railway waits for `/api/health` to answer before it retires the previous deployment. That
is the safety net working: a build that never becomes healthy is discarded and the old one
keeps serving.

It also means a slow boot looks exactly like a broken build. On 11 to 13 August 2026 the
lead pool had grown to 217,624 and every request walked it synchronously, so the event
loop was saturated during startup, `/api/health` could not answer inside the 120 second
window, and every deploy for two days was thrown away. The running service stayed on an
old commit while `main` moved on, and nothing about it looked like a failure.

Two changes. The health window is now 300 seconds, because this app legitimately spends
several minutes loading leads after a restart. And requests read a cached snapshot rather
than walking the pool, so health answers in milliseconds even mid-sync.

**How to tell what is actually running:** `/api/health` reports `build.commit` and
`build.branch`, and the same line is printed at startup. If that commit is not the tip of
`main`, deploys are not landing, whatever the dashboard says.

---

## 17. Caching

Every heavy read is memoised for fifteen seconds. The key is three parts, and the third
is what makes it safe to leave on:

| Part | Why |
|---|---|
| Route and query | A different filter is a different answer |
| Role and scope | A manager must never be served a VP's payload |
| Data version | Pool revision, list build, frozen base, forms, counselling, sheet, IST date |

Because the version carries everything underneath, a delta merge, a lead refresh, a
re-freeze or midnight all invalidate the cache on their own. **Nothing has to be cleared
by hand.** A cache that needs manual clearing is a bug waiting for a quiet afternoon.

Errors and half-built answers are never cached, because a transient failure served for
fifteen seconds is worse than the failure, and `notReady` is precisely the moment the
answer is about to change.

Every response carries `x-cache: hit` or `miss`, and `/api/status` reports the reuse rate.

Two things are deliberately **not** cached this way: the lead drill's freshness comes from
the same version key so it follows automatically, and anything that writes.

## 18. Student or professional is asked by two fields

Two contact properties ask the same question. `tm_student_or_professional` is written by the
booking flow and is a fixed choice. `are_you_a_student_or_working_professional` is written by
several creators' forms, ayush_singh13 among them, and is free text.

Neither is populated often enough on its own. A lead that came in through a form and never
booked has only the second; a lead that booked has only the first. Reading one of them meant
a large share of leads showed as unknown when the answer was sitting on the record.

The rule: read both, take whichever the lead carries, booking answer first. The fallback can
only ever fill a blank. It never overrules an answer the booking flow already gave, so no lead
that counts as a student today can become a professional tomorrow. Segment splits can grow;
they cannot flip.

Every reader goes through `spRawOf`, so the two definitions cannot drift apart. The verdict
shows as a chip in the Why call column, and both raw answers show in the expander and the lead
card. If a lead answered both and answered differently, both are shown and the disagreement is
named, because that is a fact about the lead and not a fault in the page.

## 19. Agent summary: what adds up over a range, and what does not

The agent summary answers four questions per agent over a day or a date range: who is
carrying the most overdue, who finishes what falls due, who is leaving leads with no next
date, and whether the DNP pile is being worked or just held.

Over a range these are not the same kind of number, and mixing them is the easiest way to
make the table lie.

**Flows happen on a day and add up.** Due, done, missed and calls made. Forty due on Monday
and thirty on Tuesday is seventy due across the two days, and that is a fair denominator
for a completion rate.

**Stocks are a position, not an event.** Overdue, No FU and the pool size. One lead sitting
overdue for eight days would count eight times if the days were added together, and an
agent with a single stuck lead would out-rank an agent with six live ones. So a stock is
reported as it stood on the last day of the range, with the average across the range beside
it, and never as a sum.

Days with no snapshot contribute nothing, and the page names them. A completion rate
measured on three of the seven days asked for is not wrong so much as unlabelled, and
unlabelled is how it gets quoted in a meeting. Snapshots are kept for ninety days. A range
that ends today reads today live, and only when today is not already in the snapshots, so
it can never be counted twice.

**DNP coverage** is attempts against working days since the lead landed in DNP: six attempts
in eight days. Working days, for the same reason overdue uses them. It deliberately ignores
the selected range, because a lead's attempts and its age are its own clock and slicing them
to a reporting window answers a different and less useful question. A lead with no
stage-change date and no create date cannot be dated at all; it is counted as undated and
named, rather than treated as nought days old, which would flatter whoever holds it.

Barely tried means under one attempt every `DNP_STARVED_EVERY` working days, default three,
and only once a lead has had at least that many days. The threshold is reported in the
response so it can be argued with rather than rewritten.

## 20. A segment can only narrow what is keyed by lead

The agent summary takes a HubSpot segment, the same picker Call Now has. It narrows
everything that is built from lead rows: today's calling list, the standing overdue and No
FU positions, and DNP coverage. Those are exact.

It cannot narrow the nightly snapshots. Those store per-agent counters and nothing else,
because keeping ninety days of lead ids for two hundred thousand leads is not something to
put in a JSON file on a volume. There is no way to ask, after the fact, which of the forty
leads that fell due on the 3rd were in a segment.

So choosing a segment switches the date range off and the view becomes today, live, and the
page says why. The alternative, filtering the columns that can be filtered and leaving the
rest whole, would put a segment-sized overdue count next to a team-sized due count in the
same row. That is not a smaller answer, it is a wrong one that looks like an answer.

This is not much of a loss in practice. Overdue, No FU and DNP coverage are positions read
right now, and a position is what a segment view is usually for.

Membership is a hundred and ten HubSpot calls for a segment of eleven thousand, so it is
fetched in the background and held for the rest of the day. The first open of a large
segment says it is loading rather than showing an empty table.
