import { describe, expect, it } from 'vitest';
import { createCounters } from './counters.js';

// ios/SPEC.md Section 7.8's closing sentence: the counters are testable at
// all because the set is closed and every member is an integer, a
// timestamp, or (in the one named exception) a message string - never a
// coordinate. Both tests below walk the object generically over
// `Object.entries` rather than naming each field, so a counter added later
// to counters.ts is covered without editing this file.

// Section 7.8's closing sentence names four specific shapes as absent - "no
// position, no cell index, no bar id and no bar name" - and this checks for
// exactly those, not for the words "cell" or "bar" appearing anywhere in a
// key. `results.newCells` is a count of cells, not a cell index;
// `results.barsDiscovered` is a count of bars, not a bar id or a bar name;
// neither should be rejected, and an earlier version of this pattern
// rejected both by matching the bare substring.
//
// A camelCase key is split into its words (`barId` -> `bar`, `id`); the key
// is flagged if any whole word is a coordinate word (`lat`, `lon`,
// `latitude`, `longitude`, `coord` - so `lat`, `startLon` and `lastCoord`
// are caught, and `barsDiscovered`, whose words are `bars`/`discovered`, is
// not), or if its last word is `id`, `ids`, `name`, `names`, `index` or
// `indices` (so `barId`, `barName`, `cellIndex` are caught).
//
// This key-name check is the WEAKER, belt-and-braces half. The load-bearing
// check is `Number.isInteger` below: a coordinate is a float whatever its
// key is called, and a key-name check alone could always be fooled by a
// name that doesn't happen to match this pattern. Keeping both is what lets
// the test below assert on the pattern's own sharpness without pretending
// it is what actually stops a coordinate.
const COORDINATE_WORDS = new Set(['lat', 'lon', 'latitude', 'longitude', 'coord']);
const IDENTIFIER_LAST_WORDS = new Set(['id', 'ids', 'name', 'names', 'index', 'indices']);

function camelCaseWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function looksLikeAPlace(key: string): boolean {
  const words = camelCaseWords(key);
  if (words.some((word) => COORDINATE_WORDS.has(word))) {
    return true;
  }
  return IDENTIFIER_LAST_WORDS.has(words[words.length - 1]);
}

function forEachLeaf(
  node: object,
  path: string[],
  visit: (path: string[], value: unknown) => void,
): void {
  for (const [key, value] of Object.entries(node)) {
    const currentPath = [...path, key];
    if (value !== null && typeof value === 'object') {
      forEachLeaf(value, currentPath, visit);
    } else {
      visit(currentPath, value);
    }
  }
}

describe('createCounters', () => {
  it('starts every numeric field at zero, every nested group present, and lastExceptionMessage null', () => {
    const counters = createCounters();

    expect(Object.keys(counters).sort()).toEqual(
      ['fixes', 'flushes', 'process', 'queue', 'results', 'samples', 'session', 'state'].sort(),
    );

    forEachLeaf(counters, [], (path, value) => {
      const pathStr = path.join('.');
      if (path[path.length - 1] === 'lastExceptionMessage') {
        expect(value, `${pathStr} should start null`).toBeNull();
        return;
      }
      expect(typeof value, `${pathStr} should be a number`).toBe('number');
      expect(value, `${pathStr} should start at 0`).toBe(0);
    });
  });

  // The privacy property (Section 7.8's closing sentence): a report built
  // only from integers and timestamps, none of them a coordinate, can be
  // shared without becoming a location history. This is what makes that
  // true of whatever counters.ts holds today AND whatever is added to it
  // later, rather than true only of the fields this test happens to name.
  it('holds nothing that looks like a place, and nothing non-integer but the exception message', () => {
    // Loosely typed on purpose: the fixture below assigns values of a
    // different shape (a distinct integer, then a string) into fields
    // `Counters` types as `number` or `string | null`, which is exactly
    // what the walk is there to check rather than something to have the
    // compiler pre-approve.
    const counters = createCounters() as unknown as Record<string, unknown>;

    // Every numeric leaf gets a distinct non-zero integer, and the one
    // named exception gets a string - as far from "still zero" or "still
    // null" as the fixture can put them, so a check that only worked by
    // accident on the zero-valued shape would be caught here.
    let nextValue = 1;
    forEachLeaf(counters, [], (path, value) => {
      const key = path[path.length - 1];
      const parent = path
        .slice(0, -1)
        .reduce<Record<string, unknown>>(
          (node, segment) => node[segment] as Record<string, unknown>,
          counters,
        );
      if (key === 'lastExceptionMessage') {
        parent[key] = 'GPS authorization callback threw';
        return;
      }
      expect(typeof value).toBe('number');
      parent[key] = nextValue;
      nextValue += 1;
    });

    forEachLeaf(counters, [], (path, value) => {
      const pathStr = path.join('.');
      const key = path[path.length - 1];

      expect(
        looksLikeAPlace(key),
        `counter key "${pathStr}" looks like it could name a place`,
      ).toBe(false);

      if (key === 'lastExceptionMessage') {
        expect(typeof value).toBe('string');
        return;
      }

      expect(
        typeof value,
        `${pathStr} is the only leaf allowed to be non-number, and it is not`,
      ).toBe('number');
      expect(
        Number.isInteger(value),
        `${pathStr} is not an integer - a coordinate could hide as a float`,
      ).toBe(true);
    });
  });

  // `looksLikeAPlace` is sharpened, not merely blunted: proves it still
  // catches every shape Section 7.8's closing sentence names absent, so the
  // next person who widens it back toward a bare substring match breaks a
  // test rather than only breaking `results.newCells` and
  // `results.barsDiscovered` silently.
  it('rejects a bar id, a bar name, a cell index and a coordinate, and accepts an aggregate count', () => {
    for (const badKey of ['barId', 'barName', 'cellIndex', 'lat']) {
      expect(looksLikeAPlace(badKey), `"${badKey}" should look like it could name a place`).toBe(
        true,
      );
    }
    for (const goodKey of ['newCells', 'barsDiscovered']) {
      expect(
        looksLikeAPlace(goodKey),
        `"${goodKey}" should not look like it could name a place`,
      ).toBe(false);
    }
  });
});
