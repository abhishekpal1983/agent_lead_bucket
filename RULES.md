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

## 20. Agents get the segment picker

The picker was withheld from agents on the reasoning that an agent works the list they are
given rather than slicing it. That reasoning was wrong, and the rule has been lifted.

A segment cannot widen what an agent sees. The role scope is applied to the frozen base
*after* the segment has narrowed it, so an agent who picks a segment gets their own leads
within that segment and nothing else. Withholding it only meant an agent told to work one
campaign had to find those leads by eye.

The assignment pool is a different question and stays closed to agents. That one is about
leads nobody holds, which is a manager's decision to make.

## 21. A segment can only narrow what is keyed by lead

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

## 22. Loop WA leads, and why they count towards nothing

The Loop WA view shows everyone in the HubSpot list `Loop WA responses` who has answered
Loop's WhatsApp outreach, grouped by the stage they are actually in.

It is built from the contact cache narrowed to that list, never from the frozen Call Now
base. The base deliberately drops closed stages, and roughly a third of this list sits in
DNP or not interested. Somebody in not interested who has just written back is exactly who
is worth ringing, so dropping them would remove the reason the view exists.

**None of it counts.** Not towards today's calling list, not towards a due number, not
towards anybody's completion rate or coaching figure. A WhatsApp reply is never a reason a
lead appears in the queue. This was decided deliberately: a view that quietly redefines the
day's denominator is worse than no view, and the numbers on the rest of the dashboard have
to keep meaning what they meant yesterday. There is a test that fails if a WhatsApp field
ever reaches the calling list payload.

The priority signal is **replied since last call**: they wrote back and nobody has rung them
since. A lead never called at all counts, provided they have replied. That sorts to the top
within each stage, then by reply recency.

Three refresh rates, each chosen for a reason. List membership every ten minutes, because
this list grows through the afternoon and the normal segment cache holds membership for the
whole day. The list's contacts re-read every three minutes. The conversation itself on
demand when a card opens, cached two minutes.

That middle one began as a watermark search, mirroring the calls sweep: ask HubSpot for
anyone whose last reply moved since we last looked. In production it returned zero while
HubSpot held eight replies from that window, with no error, and the identical filter run by
hand returned all eight. It could not be made to fail again on demand. A sweep whose failure
mode is a confident zero has no business sitting under a view whose only job is noticing
replies, so it was replaced with the dull thing: the list is a hundred and sixty seven
people, so read those contacts by id. Two calls, no watermark to drift, no search index to
be eventually consistent with. Health now reports both how many were read and how many
carried a reply newer than the one we held, because reporting only the first is exactly how
a zero goes unnoticed for a day.

Agents get this view. They are who it is for. It renders identically for VP, manager and
agent, and there is a test that renders all three and checks the tab, the lead row, the
phone number and the highlight rather than inferring it from the absence of a guard.

What differs is scope, and only scope. The role scope is applied to the list on the server:
an agent sees the members of the list that they hold, a manager sees their team's, a VP sees
all. Leads in the list held by somebody else are counted and named at the foot of the view
rather than dropped without a word. The thread endpoint obeys the same rule as the notes
reader, so an agent cannot read a conversation on a lead that is not theirs.

The Manager, Agent and Creator pickers apply to this view, filtered on the server so the
per stage summaries and the rows beneath them are computed from one set of leads. What the
filter hid is counted and shown, as is anything held by another agent.

Call counts come from call records, not from a contact property, and this is worth writing
down because two properties look exactly like the answer. `call_attempts`, labelled "Total
number of call attempts made to this contact", is populated on three leads out of twenty
five. `num_contacted_notes`, "number of times contacted", counts emails and WhatsApp
messages alongside calls: one lead in this list reads sixty seven, of which twenty four are
his own WhatsApp replies. Either would have looked plausible on a dashboard for months.

So the sweep batch reads call associations for the list, a hundred contacts per request,
then the calls themselves a hundred per request. About twenty requests for a list this
size, against one per lead if it were done row by row. Every row then carries calls all
time and calls since the last reply. A call we cannot date is not placed either side of the
reply, so the "since" figure is only offered when every call was dated; half an answer shown
as a whole one is worse than saying we do not know.

The lead name links through to the contact in HubSpot. The view carries its own portal
details rather than borrowing them from the drill, because it can be open without the drill
ever having loaded.

Who said what is read from the message body, not from a property. Loop sets no direction
field, so the first version fell through to its default and rendered every thread as though
the lead had said all of it, Loop's own words included. Loop writes the speaker as a
`Loop Agent:` or `Lead:` prefix instead. The body is read first, the property and the owner
check stay behind it for portals that do populate them, and the prefix is stripped once the
side is decided.

The per stage summary counts the whole stage, not the filtered rows, so the chips above
cannot move it. That means the header has to say when it is describing more than is on
screen: it reads "1 of 6 shown" with a way to see the rest, rather than "6 leads" printed
over a single row.

`ryl_wa_lead_reply_count` counts messages received **from the lead**, not the whole
conversation, so it is labelled "their replies" and never "messages".

Loop writes five summary properties on the contact, including the text of the last reply
only. The conversation lives in the activity timeline as communication records and is read
per lead. Two things there are portal specific: which field carries the direction, and what
the channel type is called. Both are guessed from a list of candidates, and
`/api/callnow2/lead/:id/activity/raw` returns the raw records so a wrong guess costs one
call rather than a deploy.

## 23. Why an agent's dashboard reads zero

A lead passes several gates on its way to an agent's screen, and when any one of them drops
everything, the symptom is the same: zero. The owner is not in our cache, because the owners
list is read at boot and a new joiner arrived after it. The creator is not tracked, so the
lead was never fetched. The stage is outside the set. Nothing qualifies. The list was frozen
at 00:05 before the leads were assigned. The owner is deactivated, or listed in
`NONCOUNT_OWNERS`. Or the person signs in with an address that does not exactly match the
email on their HubSpot user, in which case they are scoped to no owner at all.

Seven faults, one appearance, and working out which one it is from the outside takes an
afternoon of querying HubSpot. `/api/callnow2/why-zero?owner=<id>` or `?email=<work email>`
walks them in order, reports every gate with its detail, and names the first that fails.

Team mapping deserves a note of its own, because it fails partially rather than completely.
An agent who is on no team still sees their own Call Now list, since that is scoped by owner
id. But the daily review, the team rollups and the agent summary are built from team-mapped
agents, so they are missing from all three. Half working is harder to spot than not working.

## 24. A frozen list must never be born short

The day's calling list is frozen once, early, and never shrinks. That rule protected against
a list getting smaller during the day. It did nothing about a list that was small to begin
with.

On 27 August the app restarted near midnight. The first capture after the freeze hour landed
at 00:12, six minutes into a boot, while the priority fresh and unassigned lead syncs were
still running. The list froze against a quarter of the pool and locked. The floor got 1,031
leads across 34 agents instead of roughly 4,015 across 37, and several agents opened an empty
dashboard. Nothing errored, because a short list and a quiet day look identical.

The guard's own comment said "everything feeding the pool has to have landed". The code
checked only `cn2Ready()`, which goes true the moment a list exists, including one built
without fresh leads. The comment described the intent and the code never implemented it,
which is worse than having no comment: it stops the next person looking.

The rule now: a partial pool may still freeze, so nobody is left with no list at all, but the
base is stamped with what was missing and upgraded once the missing pieces land. The upgrade
merges rather than replaces, so it can only add. A lead an agent was told to call at nine
does not disappear at lunchtime.

Health reports the base size, the usual size, whether it was partial, and whether the pool is
complete now. A quarter sized list is a number somebody can see rather than a quiet morning.

## 25. Three call numbers, because one would be a lie

The idle tracker introduced three definitions and they are not interchangeable. Anything
reporting "calls" has to say which it means.

**Dialled** is calls after de-duplication. A call can reach HubSpot twice: FreJun logs the
dial as an `INTEGRATION` record, then the agent writes the same call up and the CRM logs it
again fifteen to fifty seconds later. Records from different sources, on the same lead, by
the same agent, within two minutes, are one call. Two FreJun dials to the same lead four
minutes apart stay two, because those are real retries and merging them would hide an agent
redialling a dead number all afternoon.

How much this matters depends entirely on the agent, and the first estimate written here
was wrong. One sampled agent logged nearly every call manually straight after FreJun, at
101 records for 55 calls, and that was generalised to the floor. Measured properly in
production the floor merges about 87 records out of 1,400, roughly six per cent. The split
is stable: around 29 per cent of records are manual, but most manual logs are genuine
standalone calls rather than second copies. So the correction is worth having, for the
agents it affects it is large, and floor totals move by single digits. Do not quote the
per-agent figure as a floor figure.

**Answered** is duration above zero. It includes voicemail. It cannot not include voicemail:
the floor marked exactly one call "Left voicemail" in two days, so the disposition is
useless for separating it, and 403 of 1,039 calls marked Connected lasted under thirty
seconds.

**Conversations** is duration at or above `CONVERSATION_MS`, default sixty seconds. This is
a proxy and the screens label it as a duration, not as "spoke to a human".

The Loop WA per-lead call counts were counting records and have been corrected to use the
same de-duplication. Agent day was already safe: it counts contacts with a call today, not
call records.

## 26. Idle time is measured in working minutes

The shift is 12:30 to 22:00 IST, Monday to Saturday, with breaks at 14:30 to 15:00 and
17:00 to 17:30. All of it is configurable, none of it is hardcoded in a view.

An agent whose last call was at 14:20 has been idle for 22 minutes at 15:12, not 52,
because lunch sits in between. Wall-clock subtraction would make the whole floor look idle
after every break, and the alarm would be ignored by the second day. Nothing fires outside
the shift, during a break, or on a Sunday.

The stretch before the first call of the day counts as a gap. Leaving it out would reward
turning up late.

A call cannot have happened yet. Hand-logged calls with mistyped dates put records months
in the future, and one of them would leave that agent looking busy until October. Those are
dropped rather than clamped, because clamping invents activity at a moment nothing
happened, and the count of dropped records is shown on the page.

## 27. What the idle tracker cannot see, and says so

Agents follow up with leads on WhatsApp from their own phones. Those messages never reach
HubSpot, so follow-up is counted from email only and both the payload and the screen say
so. A low number means little email was sent, not that nothing was done. Reporting it
without that sentence would punish exactly the behaviour the floor wants.

Phase one has no way for an agent to explain a gap, so a genuine client meeting looks
identical to an empty hour. Both views state this. Until declarations exist, the tracker is
for managers to look at, not for anybody to be judged on.

## 28. How much HubSpot the app actually uses

`/api/health` reports it under `hubspot`: total since boot, the last rolling hour, the
implied burst per ten seconds, a projected day, and the twelve busiest endpoints with ids
collapsed. Counting costs one increment per request and no extra calls.

This exists because "is it heavy" used to be a question about a number nobody kept, which
meant reasoning about twenty scheduled readers one at a time and arriving at an estimate.
The burst figure is the one to watch: HubSpot's ceiling is per ten seconds, not per hour,
so a sweep that fires everything at once is riskier than a larger total spread evenly.

The busiest-endpoint list is the point of it. It is what showed that recounting the calls
behind the Loop WA list was running inside the three minute reply sweep, re-reading about
two thousand call records twenty times an hour for a number that changes when somebody
makes a call. That was roughly half of the app's daily HubSpot usage for no benefit. It now
runs every fifteen minutes on its own cycle, `WA_CALLS_MINUTES`, and the reply sweep, which
does need to be quick, is untouched.

The rule when adding a sweep: ask how often the number it produces actually changes, not
how fresh you would like it to feel. Anything re-reading a large fixed set on a short timer
is the shape to be suspicious of.

## 29. The creator planner was removed

Removed on 31 August 2026 at the user's request. It was three pages, not one:
`creator_plan.html`, `plan_summary.html` and `plan_tracking.html`, which shared the
`/api/creator-plan`, `/api/plan-tracking` and `/api/plan-prefs` endpoints, an `adminOnly`
gate used by nothing else, and a twelve hourly sync that walked every contact for nine
creators to keep the plan from ageing. About 430 lines of `server.js` and 87KB of page.

Removing only the page it was asked about would have left two siblings linking to a dead
address and a large sync feeding nothing, which is the worse outcome: the HubSpot cost
stays and the reason for it disappears.

The data files `plan_data.json`, `plan_prefs.json` and `plan_state.json` may still be on
the volume. Nothing reads them. They were left rather than deleted, because discarding
somebody's saved targets during a tidy-up is not a decision to make on their behalf. Delete
them by hand if the volume needs the room.

## 30. Tech or not, blue or white collar

The forms ask "what is your current role" and the lead types free text: "software
engineer", "chef", "forklift operator", "i don't have one atm". There is no tech field and
no collar field in HubSpot, so this is a classification and it will be wrong sometimes.

Different creators are asking different questions, so the axis follows the creator.
`simrankhokha` reads tech against non-tech, because her cohort is a move into technology
and what matters is whether they are already in it. `payalineurope` and
`wanderess_priyanka` read blue collar against white collar, because those are relocation
cohorts where a welder and a data engineer are both "non-tech" and that tells nobody which
visa route they are on. A creator with no axis set gets no chip rather than the wrong one.
Override with `CREATOR_ROLE_AXIS` as `creator:axis,creator:axis`.

Three answers, not two. Titles like consultant, manager, associate or product manager
genuinely go either way, and forcing them would put a confident wrong label in front of an
agent about to dial, so they come back **unclear**. A lead who never answered gets nothing
at all: never answering and answering ambiguously are different facts and collapsing them
would hide how much of the list has no answer.

The chip carries the exact words it judged on hover, so a wrong call can be traced to what
the lead actually typed rather than argued about.

Order in the rule list matters more than the word lists. "data analyst" is tech and
"business analyst" is not; "software engineer" is tech and "civil engineer" is not. Specific
patterns sit above general ones and the first match wins. The patterns are stems that allow
the word to continue: ending them at a word boundary meant "physiotherap" never matched
"physiotherapist".

Coverage is uneven and worth knowing before reading anything into it. The role field is
populated on 1,572 of Simran's leads, but only 10 for payalineurope and 2 for
wanderess_priyanka.

## 31. The day's list follows assignment

The list is written once, early. It used to be that a lead counted against whoever held it
that morning whatever happened afterwards, which protected an agent's denominator from
moving under them. It also meant a lead handed to somebody at eleven never appeared on
their screen, which is the opposite of useful, so that rule is now reversed.

Assignment moves a lead, in all three shapes it comes in. A lead created and assigned after
the list froze joins it. A lead that sat unassigned and was picked up joins it, which
already worked through promotion. And a lead taken from one agent and given to another
moves, which is the real change: the receiving agent's count goes up and the previous
agent's goes down.

Only leads assigned today, only to somebody who is actually working, and only if the lead
belongs on the list on its own merits. Calls already made stay credited to whoever made
them, because calls are counted from call records rather than from this list.

Both numbers are reported on the page, because a denominator that moves without explanation
is how a manager stops trusting a dashboard.
