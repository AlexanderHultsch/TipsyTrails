# The owner's walk

This file is the field form of `ios/SPEC.md` Section 13.3. Section 13.3 is the
specification: six walks, in a table, each with what the report must show and
what the map must show. That table is not something a person can carry down a
street, so this document turns it into six things to actually do, one walk per
section, in the order 13.3 gives them, plus a closing section for the three
notes 13.3 asks for outside the table.

The evidence for every walk is the Diagnostics report of Section 11.3 —
exported at the end of the walk, per Section 7.8. A walk without an exported
report did not happen; nothing here is judged by memory or impression.

**A result that contradicts this specification is a finding, not a failure to
fix by repeating the walk.** If a walk's report or map does not match what its
section below says it must, that mismatch is written into the "Observed"
column exactly as seen, and Section 12's Step G requires the sentence it
falsifies in `ios/SPEC.md` to be corrected in the same commit, with the report
as the evidence. The walk is not re-run until it agrees.

---

## 1. Baseline

### Before you start

- [ ] Authorization is `.authorizedWhenInUse` or `.authorizedAlways` (6.2) —
      the foreground game needs at least "While Using"
- [ ] Precise Location is on (`accuracyAuthorization: .fullAccuracy`, 6.2); off
      puts the tracker in `blocked(reducedAccuracy)` before the walk starts
- [ ] Location Services is on, device-wide
- [ ] Low Power Mode is off
- [ ] The app is foregrounded, the map on screen, for the whole walk
- [ ] Battery percentage noted at the start

### The walk

1. Confirm the checklist above.
2. Open the app and sign in if needed.
3. Keep the map on screen for twenty minutes (13.3), walking any route.
4. Do not lock the phone or leave the app during the twenty minutes.
5. At the end of the twenty minutes, go to "What to capture" below before
   doing anything else.

### What to capture

Open the Diagnostics screen (11.3) and export the report through "Share
report" (7.8). Read off, named as 7.8 names them:

- **samples**: `rejected` — every one of `accuracy`, `future`, `stale`,
  `outsideCity`, `tooFast`
- **fixes**: received, and every drop counter (`dropped invalid`, `dropped
reduced-accuracy`, `dropped accuracy`, `dropped stale at enqueue`, `dropped
stale at flush`, `dropped by cap`)
- **process**: starts by cause — whether a `location`-cause start appears at
  all, since this is the first sustained run of the map screen and the
  question this walk also settles (see the table below)

### What the report must show / what the map must show

> `rejected` all zero; fixes received ≈ 1/s; no drops

> The walked streets revealed as they are today

### Answers to fill in

| Question                                                                                                  | Observed | Open item |
| --------------------------------------------------------------------------------------------------------- | -------- | --------- |
| `rejected` — all zero?                                                                                    |          |           |
| fixes received — approximately one per second?                                                            |          |           |
| every drop counter — zero?                                                                                |          |           |
| the walked streets — revealed as they are today?                                                          |          |           |
| did the web app's Service Worker register under App-Bound Domains (8.5), so the offline shell is present? |          | O-I6      |

---

## 2. Pocket

### Before you start

- [ ] Authorization is `.authorizedAlways` (6.2) and background tracking
      consent has been given (5.4, 10.1) — otherwise the profile never leaves
      `foreground` and there is nothing this walk can show
- [ ] Precise Location is on
- [ ] Location Services is on, device-wide
- [ ] Low Power Mode is off (walk 5 repeats this walk with it on, for the
      comparison 13.3 asks for)
- [ ] Battery percentage noted at the start
- [ ] The app is backgrounded, not force-quit, and the phone is locked before
      walking (walk 3 is where force-quit belongs)

### The walk

1. Before locking the phone, open the map and note which nearby streets are
   not yet revealed — 13.3 asks for "streets not yet revealed", and the only
   way to pick them is to look before going dark.
2. Plan a route of about thirty minutes over those streets.
3. Confirm the checklist above.
4. Lock the phone and put it away — a pocket or a bag, out of sight.
5. Walk the planned route for thirty minutes without taking the phone out.
6. At the end of the thirty minutes, take the phone out and go to "What to
   capture" below.

### What to capture

Export the Diagnostics report (7.8, 11.3) as soon as the phone comes out.
Read off:

- **fixes**: received — check this is roughly one per 25 metres walked, not
  one per second
- **flushes**: attempted, succeeded, failed by HTTP status class, transport
  failures
- **state**: count of activations per profile — `walking` should be the only
  one active throughout
- **process**: starts by cause — a `location`-cause start means the system
  killed and relaunched the app during the walk (6.4)
- battery percentage at the end, alongside the one noted at the start

### What the report must show / what the map must show

> Fixes received at roughly one per 25 m; flushes succeeding; the profile
> `walking` throughout; if a `location`-cause start appears, the system killed
> and relaunched the app

> The walked streets revealed on next open, with no gap except at a relaunch

### Answers to fill in

| Question                                                                        | Observed | Open item |
| ------------------------------------------------------------------------------- | -------- | --------- |
| fixes received — roughly one per 25 m?                                          |          |           |
| flushes — succeeding?                                                           |          |           |
| profile — `walking` throughout?                                                 |          |           |
| a `location`-cause start — did one appear?                                      |          |           |
| the walked streets — revealed on next open, with no gap except at a relaunch?   |          |           |
| battery percentage, start and end, and fixes per hour (for walk 5's comparison) |          | O-I7      |

---

## 3. Force-quit

### Before you start

- [ ] Authorization and consent as walk 2 — `.authorizedAlways`, background
      tracking consented
- [ ] Precise Location on, Low Power Mode off, Location Services on — nothing
      here should differ from a plain walk, so a difference in the result is
      the force-quit rule and not some other variable
- [ ] Battery need not be noted for this walk

### The walk

1. Confirm the checklist above.
2. Force-quit the app from the app switcher — not merely backgrounded.
3. Lock the phone and put it away.
4. Walk for fifteen minutes.
5. Take the phone out and open the app.
6. Go to "What to capture" below.

### What to capture

Export the Diagnostics report (7.8, 11.3) once the app is open again. Read
off:

- **process**: starts by cause — whether a start with cause `location`
  occurred at all during the fifteen minutes
- the last time the tracker ran (11.3), against the time the app was
  force-quit and the time it was reopened, so a gap is visible even if no
  start occurred

### What the report must show / what the map must show

> Whether any start with cause `location` occurred — this is the question 6.4
> leaves open

> Either nothing revealed (the documented rule) or the walk revealed (the rule
> has changed; fix 6.4)

### Answers to fill in

| Question                                                                    | Observed | Open item |
| --------------------------------------------------------------------------- | -------- | --------- |
| a start with cause `location` — did one occur while the app was force-quit? |          | O-I5      |
| the map — nothing revealed, or the walk revealed?                           |          |           |

---

## 4. Dwell

### Before you start

- [ ] Authorization is `.authorizedAlways`, background tracking consented, as
      walk 2
- [ ] Precise Location on, Low Power Mode off, Location Services on
- [ ] Notifications permission granted (7.7, 11.2), so the reminder and the
      mastered notification can be observed
- [ ] A bar within reach is picked in advance, and a visit is not already
      pending there

### The walk

1. Confirm the checklist above.
2. Open the app, go to the bar, and check in ("Check in", `SPEC.md` 7.6).
3. Lock the phone and put it away immediately after checking in.
4. Stay at the bar for twenty-five minutes without opening the app.
5. Open the app and go to "What to capture" below.

### What to capture

Export the Diagnostics report (7.8, 11.3) once the app is open again. Read
off:

- **state**: count of activations per profile — `dwelling` should be the one
  active for the stay
- **fixes**: received — check this is roughly one per second, as in the
  dwelling profile every fix is taken (7.3)
- **results**: visits completed
- the reminder notification — cancelled rather than delivered (7.7)
- the mastered notification — delivered once (7.7)

### What the report must show / what the map must show

> Profile `dwelling`; fixes at ~1/s; a `completed` visit; the reminder
> cancelled, the mastered notification delivered

> The glass nearly empty on the marker, without the app having been opened

### Answers to fill in

| Question                                                     | Observed | Open item |
| ------------------------------------------------------------ | -------- | --------- |
| profile — `dwelling` for the stay?                           |          |           |
| fixes — roughly one per second?                              |          |           |
| the visit — completed?                                       |          |           |
| the reminder notification — cancelled, not delivered?        |          |           |
| the mastered notification — delivered?                       |          |           |
| the marker — the glass nearly empty, without the app opened? |          |           |

---

## 5. Low Power Mode

### Before you start

- [ ] The same route and duration as walk 2 — if walk 2's streets are now
      revealed, pick a stretch of the same length and character, since the
      comparison 13.3 asks for is about the rate of fixes and not about which
      streets are new
- [ ] Authorization is `.authorizedAlways`, background tracking consented, as
      walk 2
- [ ] Low Power Mode is on (Settings, Battery)
- [ ] Precise Location on, Location Services on
- [ ] Battery percentage noted at the start

### The walk

1. Confirm the checklist above, including that Low Power Mode is on.
2. Lock the phone and put it away.
3. Walk the same route and for the same thirty minutes as walk 2.
4. At the end, take the phone out and go to "What to capture" below.

### What to capture

Export the Diagnostics report (7.8, 11.3). Read off:

- **state**: the fixes-under-low-power count, and the count of times low
  power was newly observed on
- **fixes**: received, for the fixes-per-hour comparison against walk 2
- battery percentage at the end, alongside the one noted at the start

### What the report must show / what the map must show

> Fixes per hour under the flag, compared with walk 2

> Whatever gaps the rate produced, honestly

### Answers to fill in

| Question                                                             | Observed | Open item |
| -------------------------------------------------------------------- | -------- | --------- |
| fixes per hour under Low Power Mode, and how it compares with walk 2 |          | O-I7      |
| the map — whatever gaps the rate produced, recorded honestly         |          |           |
| battery percentage, start and end                                    |          | O-I7      |

---

## 6. Precise Location off

### Before you start

- [ ] Precise Location is turned off in Settings for this app before opening
      it — this walk is about triggering `reducedAccuracy`, not avoiding it
- [ ] Authorization is otherwise unchanged from the previous walks
- [ ] The app is foregrounded

### The walk

1. In iOS Settings, turn off Precise Location for the app.
2. Open the app.
3. Go to "What to capture" below — 13.3's own "Do" for this walk is "Turn it
   off in Settings, open the app", nothing more.

### What to capture

Export the Diagnostics report (7.8, 11.3). Read off:

- **state**: the current tracking state — should read `blocked(reducedAccuracy)`
- **flushes**: attempted — should be zero
- whether the temporary-accuracy prompt (`requestTemporaryFullAccuracyAuthorization`,
  purpose key `TTPlay`, 6.2) was shown, and how many times

### What the report must show / what the map must show

> State `blocked(reducedAccuracy)`; zero flushes; the temporary-accuracy
> prompt shown once

> The indicator bad, with the words naming Precise Location

### Answers to fill in

| Question                                                     | Observed | Open item |
| ------------------------------------------------------------ | -------- | --------- |
| state — `blocked(reducedAccuracy)`?                          |          |           |
| flushes attempted — zero?                                    |          |           |
| the temporary-accuracy prompt — shown, and exactly once?     |          |           |
| the indicator — bad, with the words naming Precise Location? |          |           |

---

## Beside the six

Three notes 13.3 asks for outside the table above. None of these has a pass
mark — they are what this document could not know in advance.

- [ ] When the Always upgrade prompt appeared (6.2), and what was chosen:

  ***

- [ ] The day the periodic re-ask appeared (6.2):

  ***

- [ ] The battery percentage at the start and end of the longest evening:

  Start: __________ End: __________ (O-I7)
