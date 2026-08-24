import { describe, expect, it } from 'vitest';
import { BADGE_CATALOGUE, unearnedBadgeTypes } from './badges.js';
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
