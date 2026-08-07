# Call Now v2: the rules, in plain English

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

**Parking buckets are not part of this.** They have a real, working owner and were never
asking to be routed, so handing one out mid-day does not promote it. That keeps a manager
from collapsing the floor's coverage by distributing three hundred leads at 5pm. Calls on
those leads still show, in *worked outside this morning's list*.

The number promoted today is shown on the page, under the locked-list note and as its own
row in *What happened to this morning's list*, so a denominator that grew is never a mystery.
Pinned by `test/cn2.test.js`.
