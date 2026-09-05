import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import type { Bar, VisitSummary } from './events.js';
import {
  buildDiscoveredNotification,
  buildMasteredNotification,
  buildReminderNotification,
  buildSignedOutNotification,
  discoveredId,
  masteredId,
  reminderId,
  signedOutId,
} from './notifications.js';

const NOW_MS = 1_700_000_000_000;

function visit(overrides: Partial<VisitSummary> = {}): VisitSummary {
  return {
    id: 1,
    barId: 10,
    barName: 'The Fox and Hound',
    startedAt: 1_700_000_000,
    lastSampleAt: 1_700_000_000,
    onsiteSamples: 1,
    confirmedS: 0,
    remainingS: 0,
    status: 'pending',
    ...overrides,
  };
}

function bar(id: number, name: string, overrides: Partial<Bar> = {}): Bar {
  return {
    id,
    districtId: null,
    name,
    address: null,
    lat: 0,
    lon: 0,
    source: 'osm',
    discoveredAt: 0,
    mastered: false,
    ...overrides,
  };
}

describe('id scheme', () => {
  it('reminderId is "reminder:<visitId>"', () => {
    expect(reminderId(42)).toBe('reminder:42');
  });

  it('masteredId is "mastered:<visitId>"', () => {
    expect(masteredId(42)).toBe('mastered:42');
  });

  it('discoveredId is "discovered:<nowMs>"', () => {
    expect(discoveredId(NOW_MS)).toBe(`discovered:${NOW_MS}`);
  });

  it('signedOutId is the fixed string "signedOut"', () => {
    expect(signedOutId()).toBe('signedOut');
  });
});

describe('the reminder', () => {
  it('title is the bar name, body is the on-site sentence verbatim (SPEC.md 7.5)', () => {
    const n = buildReminderNotification(visit({ barName: 'The Fox and Hound' }));

    expect(n.id).toBe('reminder:1');
    expect(n.title).toBe('The Fox and Hound');
    expect(n.body).toBe("Open Tipsy Trails again while you're still here to complete this visit.");
  });

  it('atMs is startedAt (wire seconds) converted to ms, plus VISIT_PUSH_AFTER_MS', () => {
    const startedAtS = 1_700_000_000;
    const n = buildReminderNotification(visit({ startedAt: startedAtS }));

    expect(n.atMs).toBe(startedAtS * 1000 + CONFIG.VISIT_PUSH_AFTER_MS);
  });

  it('the id carries the visit id and nothing else identifies it', () => {
    const n = buildReminderNotification(visit({ id: 777 }));

    expect(n.id).toBe('reminder:777');
  });
});

describe('mastered', () => {
  it('title is "<bar name> mastered", body is fixed, atMs is now', () => {
    const n = buildMasteredNotification(visit({ id: 3, barName: 'The Fox and Hound' }), NOW_MS);

    expect(n.id).toBe('mastered:3');
    expect(n.title).toBe('The Fox and Hound mastered');
    expect(n.body).toBe('Your visit is complete.');
    expect(n.atMs).toBe(NOW_MS);
  });
});

describe('discovered', () => {
  it('one bar: "New bar discovered", body is just the name', () => {
    const n = buildDiscoveredNotification([bar(1, 'Alpha')], NOW_MS);

    expect(n.id).toBe(`discovered:${NOW_MS}`);
    expect(n.title).toBe('New bar discovered');
    expect(n.body).toBe('Alpha');
    expect(n.atMs).toBe(NOW_MS);
  });

  it('three bars: "3 new bars discovered", all three joined by commas, no "more"', () => {
    const n = buildDiscoveredNotification(
      [bar(1, 'Alpha'), bar(2, 'Beta'), bar(3, 'Gamma')],
      NOW_MS,
    );

    expect(n.title).toBe('3 new bars discovered');
    expect(n.body).toBe('Alpha, Beta, Gamma');
  });

  it('five bars: "5 new bars discovered", first three named and "and 2 more"', () => {
    const n = buildDiscoveredNotification(
      [bar(1, 'Alpha'), bar(2, 'Beta'), bar(3, 'Gamma'), bar(4, 'Delta'), bar(5, 'Epsilon')],
      NOW_MS,
    );

    expect(n.title).toBe('5 new bars discovered');
    expect(n.body).toBe('Alpha, Beta, Gamma and 2 more');
  });

  it('names appear in the order the response gave them', () => {
    const n = buildDiscoveredNotification([bar(9, 'Zulu'), bar(1, 'Alpha')], NOW_MS);

    expect(n.body).toBe('Zulu, Alpha');
  });
});

describe('signed out', () => {
  it('title "Signed out", body tells the player to open the app to sign in again', () => {
    const n = buildSignedOutNotification(NOW_MS);

    expect(n.id).toBe('signedOut');
    expect(n.title).toBe('Signed out');
    expect(n.body).toBe('Open Tipsy Trails to sign in again.');
    expect(n.atMs).toBe(NOW_MS);
  });
});

// SPEC.md 7.7's fourth rule: "a notification carries the bar's name and
// nothing else - no coordinate, no distance, no cell count." The fixture
// below gives its bar and visit distinctive, long digit runs - a
// coordinate, a visit id and a bar id all long enough that no legitimate
// piece of copy (a bar count, or "and N more") could produce the same run
// by coincidence - and asserts none of it reaches a title or a body. The id
// field is explicitly exempted: it is the notification centre's handle, not
// its text, and 7.7 says nothing about what it may carry.
describe('privacy - a notification carries the bar name and nothing else (7.7)', () => {
  const DISTINCTIVE_LAT = 49.123456789;
  const DISTINCTIVE_LON = 8.987654321;
  const VISIT_ID = 4_242_424_242;
  const BAR_ID = 13_579_113;
  const BAR_NAME = 'The Fox and Hound';

  // Digit runs longer than this cannot come from the small integers this
  // module's own copy prints (a bar count, or the "N" in "and N more");
  // anything longer than that is a coordinate, a visit id or a bar id
  // leaking through instead.
  const MAX_COPY_DIGIT_RUN_LENGTH = 2;

  function fixtureVisit(): VisitSummary {
    return visit({ id: VISIT_ID, barId: BAR_ID, barName: BAR_NAME });
  }

  function fixtureBar(): Bar {
    return bar(BAR_ID, BAR_NAME, { lat: DISTINCTIVE_LAT, lon: DISTINCTIVE_LON });
  }

  function assertTitleAndBodyCarryNothingElse(notification: { title: string; body: string }): void {
    const text = `${notification.title} ${notification.body}`;
    expect(text).not.toContain(String(DISTINCTIVE_LAT));
    expect(text).not.toContain(String(DISTINCTIVE_LON));
    expect(text).not.toContain(String(VISIT_ID));
    expect(text).not.toContain(String(BAR_ID));
    for (const run of text.match(/\d+/g) ?? []) {
      expect(
        run.length,
        `digit run "${run}" in "${text}" is longer than this copy's own numbers`,
      ).toBeLessThanOrEqual(MAX_COPY_DIGIT_RUN_LENGTH);
    }
  }

  it('the reminder', () => {
    const n = buildReminderNotification(fixtureVisit());
    assertTitleAndBodyCarryNothingElse(n);
    // The id MAY carry the visit id - it is the handle, not the text.
    expect(n.id).toBe(`reminder:${VISIT_ID}`);
  });

  it('mastered', () => {
    const n = buildMasteredNotification(fixtureVisit(), NOW_MS);
    assertTitleAndBodyCarryNothingElse(n);
    expect(n.id).toBe(`mastered:${VISIT_ID}`);
  });

  it('discovered', () => {
    const n = buildDiscoveredNotification([fixtureBar()], NOW_MS);
    assertTitleAndBodyCarryNothingElse(n);
  });

  it('signed out', () => {
    const n = buildSignedOutNotification(NOW_MS);
    assertTitleAndBodyCarryNothingElse(n);
  });
});
