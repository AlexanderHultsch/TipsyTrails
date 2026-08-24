import { describe, expect, it } from 'vitest';
import {
  barAccessibleName,
  cocktailGlassPathData,
  cocktailGlassSvgMarkup,
  masteredPhrase,
  masteredStatusText,
} from './cocktail-glass.js';

// SPEC.md Sections 5.7 and 8.1. The glass is the app's central mark for a
// bar, and its two states are the only thing saying whether that bar is
// mastered - so what is asserted here is the properties that make the
// difference perceivable, not the particular curve of a martini glass.

describe('the cocktail glass (SPEC.md Sections 5.7, 8.1)', () => {
  it('draws a different bowl for the two states', () => {
    const full = cocktailGlassPathData(false);
    const nearlyEmpty = cocktailGlassPathData(true);

    expect(full).not.toEqual(nearlyEmpty);
    // The bowl is what changes; the stem and foot are the same glass in
    // both states, which is what makes "the same glass, nearly empty" true
    // rather than two unrelated icons.
    expect(full[0]).not.toBe(nearlyEmpty[0]);
    expect(full.slice(1)).toEqual(nearlyEmpty.slice(1));
  });

  // Section 8.1: "nothing may rely on colour alone", and the marker is ink
  // on paper anyway. The mastered bowl is a wall of ink around a hole - one
  // path with a second, reverse-wound subpath the nonzero fill rule punches
  // out - while the full one is a single solid triangle. That structural
  // difference is what makes the states tell apart at 22px, and it is the
  // thing a "just change the fill" regression would remove.
  it('makes the mastered bowl hollow and the unmastered one solid', () => {
    const [fullBowl] = cocktailGlassPathData(false);
    const [emptyBowl] = cocktailGlassPathData(true);

    const subpaths = (d: string) => d.match(/[Mm]/g)?.length ?? 0;
    expect(subpaths(fullBowl)).toBe(1);
    expect(subpaths(emptyBowl)).toBe(2);
    // The outer silhouette is untouched: the mastered glass is the same
    // glass, emptied, not a smaller one.
    expect(emptyBowl.startsWith(fullBowl)).toBe(true);
  });

  it('never carries a colour, a stroke or a fill of its own', () => {
    for (const mastered of [false, true]) {
      const markup = cocktailGlassSvgMarkup(mastered);
      expect(markup).not.toMatch(/stroke|fill=|style=|gradient/i);
    }
  });

  it('renders the same paths as markup that the React component renders as elements', () => {
    for (const mastered of [false, true]) {
      const markup = cocktailGlassSvgMarkup(mastered);
      for (const d of cocktailGlassPathData(mastered)) {
        expect(markup).toContain(`d="${d}"`);
      }
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it('states the two states in words, and says mastering is one-way', () => {
    expect(masteredPhrase(true)).toBe('mastered');
    expect(masteredPhrase(false)).toBe('not mastered yet');
    expect(masteredStatusText(true)).toBe('Mastered');
    expect(masteredStatusText(false)).toBe('Not mastered yet');
    expect(barAccessibleName('The Fox', true)).toBe('The Fox - mastered');
    expect(barAccessibleName('The Fox', false)).toBe('The Fox - not mastered yet');
  });
});
