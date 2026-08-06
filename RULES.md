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

**Leads that are shown but never counted.** Unassigned leads and parking buckets go on the
list and appear everywhere, but are excluded from every total. They are visible so the work
does not disappear, and excluded so one bucket cannot swamp the floor.

**Nothing joins the list after 00:05.** A lead created at 11am is not on today's list, and
never will be. It appears as *created after the list locked*, which is real work, counted
separately, and not part of this morning's plan.

**Nothing leaves the list before midnight.** Not by changing stage, not by getting a new
follow-up date, not by being handed to another agent, not by having its creator untracked.
The lead was on the list this morning; it stays on the list until the list is replaced.

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
| **Fresh** | Brand new, nobody has ever worked it |
| **Later date** | The follow-up is dated for a future day |

And any number of **reasons to call**, which overlap on purpose:

form, score 6 or more, international, fresh, refilled form, IFC due, needs owner.
**Any priority** is the deduplicated count of those. It is never a sum of them.

**Needs owner is deliberately not part of any priority.** Confirmed 8 August 2026. A lead
with no owner, or with a deactivated owner, needs someone assigned to it. That is a routing
job for a manager, not a call for an agent, so it never inflates the calling queue. It is
still a column of its own, so the pile stays visible and can be worked deliberately.

---

## 3. Overdue

A follow-up dated **6 August at 2pm** is **due today** for all of 6 August, including at
11pm. It becomes **overdue** on 7 August, and only if a working day has passed.

A follow-up dated on a **non-working day** rolls forward. A Sunday follow-up reads as **due**
on Monday, not overdue, because nobody could have called it.

**Working days are Monday to Saturday.** Confirmed 8 August 2026. Sunday is the only
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
