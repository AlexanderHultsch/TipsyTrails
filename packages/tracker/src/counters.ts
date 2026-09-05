// ios/SPEC.md Section 7.8. `Counters` is the closed set that section lists,
// structured as one interface with the eight nested groups it names - fixes,
// queue, flushes, samples, results, state, process, session.
//
// Section 7.8's opening sentence is the constraint every field below is
// bent to fit: "every counter is an integer or a timestamp, none is a
// coordinate, and the set is closed." Its closing sentence is why that
// constraint is enforced by a test rather than trusted by eye: a report
// built only from integers and timestamps, none of them a coordinate, is a
// report that can be shared without becoming a location history
// (counters.test.ts's privacy property).
//
// Two places in the prose do not fit that constraint as written, and both
// are resolved here the same way, not independently invented for each:
//
// 1. **Transitions of `tracking` with timestamps.** An unbounded array of
//    (state, timestamp) pairs, growing for as long as the process runs, is
//    neither an integer nor a timestamp and nothing bounds it. Resolved as
//    a COUNT PER TARGET STATE (`transitions.idle/tracking/blocked`) plus one
//    `lastTransitionAtMs` - which state the tracker is in *now* is not
//    recoverable from this, only how many times and when it last changed,
//    which is what a diagnostic count is for. `ios/SPEC.md` 7.8's wording
//    should be brought into line with this in a later commit; this file
//    does not edit that spec.
// 2. **"The current profile" and the "low-power flag."** A profile name or
//    a boolean is exactly as unbounded-by-neither-int-nor-timestamp a shape
//    as the transitions array, for the same reason: 7.8 wants a *value*,
//    not a count, and a value is not what this closed set can hold. The
//    same transformation applies: `profileActivations.foreground/walking/
//    dwelling` counts how many times the tracker entered each profile, and
//    `lowPowerActivations` counts how many times low power was newly
//    observed on, alongside `fixesUnderLowPower` (7.8's own count, unchanged).
//    Like (1), this is a count of history, not a live snapshot; the tracker's
//    own state machine is the live source for "which profile is this,
//    right now."
//
// Every field name below is otherwise 7.8's own words in camelCase -
// `results.newCells` and `results.barsDiscovered` included. A counter a
// reader cannot trace back to the sentence that asked for it is a counter
// that drifts; counters.test.ts's privacy property is a shape check on
// what a key merely *looks like* it could hold, not a ban on the words
// "cell" or "bar" appearing in an aggregate count's name, and it is written
// to tell the two apart (see that file for how).
//
// `process.lastExceptionMessage` is the one field in the whole set that is
// neither an integer nor a timestamp: 7.8 names it as a message, a string
// is what a message is, and it is not turned into a count because there is
// nothing to count that would still answer "what did it say."
export interface Counters {
  fixes: {
    received: number;
    droppedInvalid: number;
    droppedReducedAccuracy: number;
    droppedAccuracy: number;
    droppedStaleAtEnqueue: number;
    droppedStaleAtFlush: number;
    droppedByCap: number;
  };
  queue: {
    currentDepth: number;
    currentBehind: number;
    maxDepthSeen: number;
  };
  flushes: {
    attempted: number;
    succeeded: number;
    // `other` is not dead: Section 7.2's `fetch` follows no redirect and
    // returns every status as a response, so a 3xx - reachable, not merely
    // theoretical - has nowhere else to be counted. A failure with nowhere
    // to be counted is an invisible failure, which is the one thing this
    // report exists to prevent.
    failedByStatusClass: {
      '4xx': number;
      '5xx': number;
      other: number;
    };
    transportFailures: number;
    backoffCurrentlyInForceMs: number;
  };
  samples: {
    sent: number;
    rejected: {
      accuracy: number;
      future: number;
      stale: number;
      outsideCity: number;
      tooFast: number;
    };
  };
  results: {
    newCells: number;
    barsDiscovered: number;
    visitsCompleted: number;
    tooFastToRevealBatches: number;
  };
  state: {
    transitions: {
      idle: number;
      tracking: number;
      blocked: number;
    };
    lastTransitionAtMs: number;
    profileActivations: {
      foreground: number;
      walking: number;
      dwelling: number;
    };
    lowPowerActivations: number;
    fixesUnderLowPower: number;
  };
  process: {
    startsByCause: {
      user: number;
      location: number;
      unknown: number;
    };
    contextRestartsAfterException: number;
    lastExceptionMessage: string | null;
  };
  session: {
    sessionLostByCause: {
      cookie: number;
      unauthenticated: number;
      passwordChangeRequired: number;
    };
  };
}

export function createCounters(): Counters {
  return {
    fixes: {
      received: 0,
      droppedInvalid: 0,
      droppedReducedAccuracy: 0,
      droppedAccuracy: 0,
      droppedStaleAtEnqueue: 0,
      droppedStaleAtFlush: 0,
      droppedByCap: 0,
    },
    queue: {
      currentDepth: 0,
      currentBehind: 0,
      maxDepthSeen: 0,
    },
    flushes: {
      attempted: 0,
      succeeded: 0,
      failedByStatusClass: {
        '4xx': 0,
        '5xx': 0,
        other: 0,
      },
      transportFailures: 0,
      backoffCurrentlyInForceMs: 0,
    },
    samples: {
      sent: 0,
      rejected: {
        accuracy: 0,
        future: 0,
        stale: 0,
        outsideCity: 0,
        tooFast: 0,
      },
    },
    results: {
      newCells: 0,
      barsDiscovered: 0,
      visitsCompleted: 0,
      tooFastToRevealBatches: 0,
    },
    state: {
      transitions: {
        idle: 0,
        tracking: 0,
        blocked: 0,
      },
      lastTransitionAtMs: 0,
      profileActivations: {
        foreground: 0,
        walking: 0,
        dwelling: 0,
      },
      lowPowerActivations: 0,
      fixesUnderLowPower: 0,
    },
    process: {
      startsByCause: {
        user: 0,
        location: 0,
        unknown: 0,
      },
      contextRestartsAfterException: 0,
      lastExceptionMessage: null,
    },
    session: {
      sessionLostByCause: {
        cookie: 0,
        unauthenticated: 0,
        passwordChangeRequired: 0,
      },
    },
  };
}
