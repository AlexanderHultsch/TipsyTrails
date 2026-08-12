import { describe, expect, it } from 'vitest';
import { CONFIG } from './config.js';
import type { LatLon } from './grid.js';
import { findConflictingBar, levenshteinRatio, normalizeBarName } from './suggest.js';

// Karlsruhe Schloss (SPEC.md's own worked example, also used by
// packages/shared/src/visits.test.ts and packages/api/src/routes/bars.test.ts).
const SCHLOSS: LatLon = { lat: 49.0135, lon: 8.4044 };
function mPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
function eastOf(base: LatLon, distanceM: number): LatLon {
  return { lat: base.lat, lon: base.lon + distanceM / mPerDegLon(base.lat) };
}

describe('normalizeBarName', () => {
  it('lowercases', () => {
    expect(normalizeBarName('Zum Schlossgarten')).toBe('zum schlossgarten');
  });

  it('strips diacritics', () => {
    expect(normalizeBarName('Café Müller')).toBe('cafe muller');
  });

  it('strips punctuation', () => {
    expect(normalizeBarName("Rosi's Bar")).toBe('rosis');
  });

  it('collapses whitespace', () => {
    expect(normalizeBarName('Zum   Alten   Fritz')).toBe('zum alten fritz');
  });

  it('drops a common trailing suffix', () => {
    expect(normalizeBarName('Kaiser Cafe')).toBe('kaiser');
  });

  it('drops a leading English article', () => {
    expect(normalizeBarName('The Black Cat')).toBe('black cat');
  });

  it('drops a leading German article', () => {
    expect(normalizeBarName('Der Goldene Löwe')).toBe('goldene lowe');
  });

  it('does not drop a suffix-like word that is not the trailing token', () => {
    expect(normalizeBarName('Bar None')).toBe('bar none');
  });

  it('normalizes an empty string to itself', () => {
    expect(normalizeBarName('')).toBe('');
  });

  it('normalizes a name that is only an article plus a suffix to the empty string', () => {
    expect(normalizeBarName('The Bar')).toBe('');
  });

  it('normalizes a name that is only whitespace and punctuation to the empty string', () => {
    expect(normalizeBarName('   ---   ')).toBe('');
  });
});

describe('levenshteinRatio', () => {
  it('is 1 for identical non-empty strings', () => {
    expect(levenshteinRatio('schlossgarten', 'schlossgarten')).toBe(1);
  });

  it('is 1 for two empty strings, without dividing by zero', () => {
    expect(levenshteinRatio('', '')).toBe(1);
  });

  it('is 0 when one side is empty and the other is not', () => {
    expect(levenshteinRatio('', 'schlossgarten')).toBe(0);
    expect(levenshteinRatio('schlossgarten', '')).toBe(0);
  });

  it('sits exactly at the configured threshold for a 3-character difference in 20', () => {
    const a = 'abcdefghijklmnopqrst';
    const b = 'xyzdefghijklmnopqrst';
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(20);
    const ratio = levenshteinRatio(a, b);
    expect(ratio).toBeCloseTo(0.85, 10);
    expect(ratio).toBeGreaterThanOrEqual(CONFIG.SUGGEST_NAME_SIMILARITY);
  });

  it('falls just below the configured threshold for a 4-character difference in 20', () => {
    const a = 'abcdefghijklmnopqrst';
    const b = 'wxyzefghijklmnopqrst';
    expect(a).toHaveLength(20);
    expect(b).toHaveLength(20);
    const ratio = levenshteinRatio(a, b);
    expect(ratio).toBeCloseTo(0.8, 10);
    expect(ratio).toBeLessThan(CONFIG.SUGGEST_NAME_SIMILARITY);
  });
});

describe('findConflictingBar', () => {
  const EXISTING = { id: 1, name: 'Zum Schlossgarten', ...SCHLOSS };

  it('matches a case difference', () => {
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('zum SCHLOSSGARTEN', position, [EXISTING]);
    expect(conflict?.id).toBe(1);
  });

  it('matches a diacritics difference', () => {
    const accented = { id: 2, name: 'Café Müller', ...SCHLOSS };
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('Cafe Muller', position, [accented]);
    expect(conflict?.id).toBe(2);
  });

  it('matches a punctuation difference', () => {
    const punctuated = { id: 3, name: "Rosi's Bar", ...SCHLOSS };
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('Rosis', position, [punctuated]);
    expect(conflict?.id).toBe(3);
  });

  it('matches after a dropped suffix', () => {
    const withSuffix = { id: 4, name: 'Kaiser Cafe', ...SCHLOSS };
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('Kaiser', position, [withSuffix]);
    expect(conflict?.id).toBe(4);
  });

  it('matches after a dropped leading article', () => {
    const withArticle = { id: 5, name: 'The Black Cat', ...SCHLOSS };
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('Black Cat', position, [withArticle]);
    expect(conflict?.id).toBe(5);
  });

  it('does not match a genuinely different name at the same position', () => {
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('Irish Pub Karlsruhe', position, [EXISTING]);
    expect(conflict).toBeUndefined();
  });

  it('rejects at the threshold boundary (a 3-character difference in 20)', () => {
    const nearMatch = { id: 6, name: 'xyzdefghijklmnopqrst', ...SCHLOSS };
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('abcdefghijklmnopqrst', position, [nearMatch]);
    expect(conflict?.id).toBe(6);
  });

  it('accepts just below the threshold boundary (a 4-character difference in 20)', () => {
    const belowThreshold = { id: 7, name: 'wxyzefghijklmnopqrst', ...SCHLOSS };
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('abcdefghijklmnopqrst', position, [belowThreshold]);
    expect(conflict).toBeUndefined();
  });

  it('does not match the same name outside SUGGEST_DUPLICATE_RADIUS_M', () => {
    const farEnough = CONFIG.SUGGEST_DUPLICATE_RADIUS_M + 10;
    const position = eastOf(SCHLOSS, farEnough);
    const conflict = findConflictingBar('Zum Schlossgarten', position, [EXISTING]);
    expect(conflict).toBeUndefined();
  });

  it('matches the same name at exactly SUGGEST_DUPLICATE_RADIUS_M', () => {
    const position = eastOf(SCHLOSS, CONFIG.SUGGEST_DUPLICATE_RADIUS_M);
    const conflict = findConflictingBar('Zum Schlossgarten', position, [EXISTING]);
    expect(conflict?.id).toBe(1);
  });

  it('never matches when the candidate name normalizes to the empty string', () => {
    const position = eastOf(SCHLOSS, 5);
    const conflict = findConflictingBar('The Bar', position, [EXISTING]);
    expect(conflict).toBeUndefined();
  });

  it('never matches an existing bar whose name normalizes to the empty string', () => {
    const emptyNamed = { id: 8, name: 'The Pub', ...SCHLOSS };
    const position = eastOf(SCHLOSS, 5);
    // "The Bar" and "The Pub" both normalize to "" — without the empty-name
    // guard this would report a 1.0 ratio and a false conflict.
    const conflict = findConflictingBar('The Bar', position, [emptyNamed]);
    expect(conflict).toBeUndefined();
  });
});
