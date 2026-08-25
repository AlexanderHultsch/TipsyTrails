import { describe, expect, it } from 'vitest';
import {
  BADGE_CATALOGUE,
  BADGE_COMPETITION_NOTE,
  badgeDescription,
  badgeName,
  unearnedBadgeTypes,
} from './badges.js';
import type { BadgeType } from './badges.js';
import { BADGE_PERIODS } from './berlin-time.js';
import { CONFIG } from './config.js';

function key(type: BadgeType): string {
  return `${type.kind}/${type.period}`;
}

describe('BADGE_CATALOGUE', () => {
  it('holds every kind in every period, once each', () => {
    const kinds = Object.keys(CONFIG.BADGE_THRESHOLDS);
    expect(BADGE_CATALOGUE).toHaveLength(kinds.length * BADGE_PERIODS.length);
    expect(new Set(BADGE_CATALOGUE.map(key)).size).toBe(BADGE_CATALOGUE.length);

    for (const kind of kinds) {
      for (const period of BADGE_PERIODS) {
        expect(BADGE_CATALOGUE.map(key)).toContain(`${kind}/${period}`);
      }
    }
  });

  it('is kind-major with the periods ascending, which is the order a shelf draws', () => {
    expect(BADGE_CATALOGUE.map(key)).toEqual([
      'explorer/week',
      'explorer/month',
      'explorer/year',
      'barfly/week',
      'barfly/month',
      'barfly/year',
    ]);
  });
});

describe('unearnedBadgeTypes', () => {
  it('returns the whole catalogue for a player who has earned nothing', () => {
    expect(unearnedBadgeTypes([])).toEqual([...BADGE_CATALOGUE]);
  });

  it('drops a type the player holds and keeps the rest in catalogue order', () => {
    expect(unearnedBadgeTypes([{ kind: 'explorer', period: 'week' }]).map(key)).toEqual([
      'explorer/month',
      'explorer/year',
      'barfly/week',
      'barfly/month',
      'barfly/year',
    ]);
  });

  it('returns nothing once every type has been held', () => {
    expect(unearnedBadgeTypes(BADGE_CATALOGUE)).toEqual([]);
  });

  // The rule the whole feature rests on: a type is gone for good after one
  // award, so a badge that recurs every week does not put its placeholder back
  // on the shelf every Monday. Awards are never revoked (Section 7.7), so the
  // earned set only grows and this set only shrinks - it cannot flicker.
  it('drops a type for good however many period keys it was won in', () => {
    const once = unearnedBadgeTypes([{ kind: 'barfly', period: 'week' }]);
    const thrice = unearnedBadgeTypes([
      { kind: 'barfly', period: 'week' },
      { kind: 'barfly', period: 'week' },
      { kind: 'barfly', period: 'week' },
    ]);
    expect(thrice).toEqual(once);
    expect(once.map(key)).not.toContain('barfly/week');
  });

  // Section 7.7 publishes no threshold and no standing. The placeholder set is
  // keyed on what a player has earned and on nothing else, so that no part of
  // it can move as the player's running value moves - a placeholder that
  // changed at the floor would let the floor be read off the screen.
  it('ignores everything on an award except its kind and period', () => {
    const earned = { kind: 'explorer', period: 'month' } as const;
    const withValue = { ...earned, periodKey: '2026-08', value: 99.9, awardedAt: 1 };
    const withoutValue = { ...earned, periodKey: '1970-01', value: 0, awardedAt: 2 };

    expect(unearnedBadgeTypes([withValue])).toEqual(unearnedBadgeTypes([withoutValue]));
    expect(unearnedBadgeTypes([withValue])).toEqual(unearnedBadgeTypes([earned]));
  });
});

// SPEC.md Section 7.7 decides every word of this copy: a description may say
// what the badge is, what earns it and over what window, and may never carry
// the threshold, a distance from it, a rank, a standing or a share of a
// target. The tests below are that rule, read from both sides - what each
// description must distinguish, and what none of them may contain.
describe('badge copy', () => {
  const descriptions = BADGE_CATALOGUE.map((type) => badgeDescription(type.kind, type.period));

  it('gives every badge in the catalogue a description of its own', () => {
    expect(new Set(descriptions).size).toBe(BADGE_CATALOGUE.length);
  });

  // The kind carries what counts. A player reading the barfly sheet must not
  // be told the explorer rule, and the exclusion clause is the half of it
  // they cannot guess - a second visit to a mastered bar scores nothing.
  it('names the activity of the kind, exclusion and all', () => {
    expect(badgeDescription('explorer', 'week')).toContain(
      'city area you clear for the first time',
    );
    expect(badgeDescription('explorer', 'week')).toContain(
      'Walking a street you have already cleared adds nothing.',
    );
    expect(badgeDescription('barfly', 'week')).toContain('bars you master for the first time');
    expect(badgeDescription('barfly', 'week')).toContain(
      'A second completed visit to a bar you have already mastered counts for nothing.',
    );
  });

  // The period carries the window, and an ISO week is not "the last seven
  // days" (Section 5.8) - which is the reading a player arrives with, and the
  // one that has them counting from the wrong day.
  it('names the window of the period, in Europe/Berlin', () => {
    expect(badgeDescription('explorer', 'week')).toContain('an ISO week (Monday to Sunday)');
    expect(badgeDescription('explorer', 'month')).toContain('a calendar month');
    expect(badgeDescription('explorer', 'year')).toContain('a calendar year');
    for (const description of descriptions) {
      expect(description).toContain('Europe/Berlin');
    }
  });

  // Two sentences at most, so a sheet is read rather than skipped.
  it('says it in no more than two sentences', () => {
    for (const description of descriptions) {
      expect(description.split('. ').length).toBeLessThanOrEqual(2);
    }
  });

  // The rule this whole feature is bounded by. No description, name or note
  // may carry a digit at all: a threshold, a distance from one, a rank or a
  // share of a target would each be a number, and the surest way to publish
  // none of them is to publish no number.
  it('carries no digit and nothing that reads as a target or a standing', () => {
    const everything = [
      ...descriptions,
      ...BADGE_CATALOGUE.map((type) => badgeName(type.kind, type.period)),
      BADGE_COMPETITION_NOTE,
    ];
    for (const text of everything) {
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/%/);
      expect(text.toLowerCase()).not.toMatch(
        /threshold|target|at least|rank|leader|to go|so close|nearly there/,
      );
    }
  });

  // Said identically on every badge, because it is true of every badge: a
  // badge goes to the period's best, so no score wins one. It is the honest
  // answer to the question a description raises and cannot answer.
  it('answers "what must I do" in words rather than leaving a number to be invented', () => {
    expect(BADGE_COMPETITION_NOTE).toContain('whoever does the most of it');
    expect(BADGE_COMPETITION_NOTE).toContain('no fixed score wins one');
  });

  it('titles a badge by its kind and its period', () => {
    expect(badgeName('explorer', 'week')).toBe('Explorer · Week');
    expect(badgeName('barfly', 'year')).toBe('Barfly · Year');
    expect(new Set(BADGE_CATALOGUE.map((type) => badgeName(type.kind, type.period))).size).toBe(
      BADGE_CATALOGUE.length,
    );
  });
});
