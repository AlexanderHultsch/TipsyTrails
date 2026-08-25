import { describe, expect, it } from 'vitest';
import {
  BADGE_CATALOGUE,
  BADGE_COMPETITION_NOTE,
  BADGE_PERIOD_NAME,
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

// SPEC.md Section 7.7 decides every word of this copy: it may say what the
// badge is called and, in words, that a badge goes to the period's best, and
// it may never carry the threshold, a distance from it, a rank, a standing or
// a share of a target. The tests below are that rule read from both sides.
//
// Since v1.38 there is no per-badge description at all - the owner's "remove
// the detailed description for all of them, the name is enough" - so what a
// badge says about itself is its name plus one sentence shared by all six.
// The tests that used to hold six composed descriptions apart are gone with
// the descriptions; the ones that bounded what any of that copy could contain
// are kept and now run over the names and the note.
describe('badge copy', () => {
  const names = BADGE_CATALOGUE.map((type) => badgeName(type.kind, type.period));

  // The owner's six names, verbatim and pinned individually. A table of six
  // strings is exactly the thing a refactor "tidies" back into a composition,
  // and the composition it came from produced "Barfly · Year" for a badge he
  // calls a Bar Legend.
  it('gives each pair the owner’s own name', () => {
    expect(badgeName('barfly', 'week')).toBe('Bar Hopper');
    expect(badgeName('barfly', 'month')).toBe('Bar Champion');
    expect(badgeName('barfly', 'year')).toBe('Bar Legend');
    expect(badgeName('explorer', 'week')).toBe('Explorer');
    expect(badgeName('explorer', 'month')).toBe('Explorer Champion');
    expect(badgeName('explorer', 'year')).toBe('Explorer Legend');
  });

  // Six badges, six names. Two pairs sharing a name would put one title on
  // two different sheets and one label on two different glyphs, which is a
  // player being told they are looking at a badge they are not.
  it('gives every badge in the catalogue a name of its own', () => {
    expect(new Set(names).size).toBe(BADGE_CATALOGUE.length);
  });

  // The names deliberately stopped saying which period they belong to - "Bar
  // Legend" is the point of the rename - so the period has to survive
  // somewhere a screen reader can reach it, because the crown that carries it
  // on screen (Section 8.1) is silent. This is the vocabulary the accessible
  // labels are built from (components/Badge.tsx), and it is lower case
  // because every one of them uses it inside a sentence fragment.
  it('keeps a spoken word for each period, since no name carries one', () => {
    expect(BADGE_PERIOD_NAME).toEqual({ week: 'week', month: 'month', year: 'year' });
    for (const word of Object.values(BADGE_PERIOD_NAME)) {
      expect(word).toBe(word.toLowerCase());
    }
  });

  // The rule this whole feature is bounded by. No name and no note may carry
  // a digit at all: a threshold, a distance from one, a rank or a share of a
  // target would each be a number, and the surest way to publish none of them
  // is to publish no number.
  it('carries no digit and nothing that reads as a target or a standing', () => {
    for (const text of [...names, ...Object.values(BADGE_PERIOD_NAME), BADGE_COMPETITION_NOTE]) {
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/%/);
      expect(text.toLowerCase()).not.toMatch(
        /threshold|target|at least|rank|leader|to go|so close|nearly there/,
      );
    }
  });

  // Said identically on every badge, because it is true of every badge: a
  // badge goes to the period's best, so no score wins one. It is the honest
  // answer to the question a name raises and cannot answer, and since v1.38
  // it is the whole of what a sheet says beyond the name and the status.
  it('answers "what must I do" in words rather than leaving a number to be invented', () => {
    expect(BADGE_COMPETITION_NOTE).toBe(
      'Each badge goes to whoever does the most of it in the period.',
    );
    // One sentence, and the owner's "not more" is the reason. The clause this
    // used to end with - "- no fixed score wins one" - is what "not more" cut.
    expect(BADGE_COMPETITION_NOTE.split('. ')).toHaveLength(1);
  });
});
