import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SPEC.md states its version twice - in the front matter and in the closing
// line - and the two silently disagreed for eight versions. The cause is worth
// recording, because it will happen again to anyone editing this file with a
// script: Prettier rewrites Markdown emphasis from `*text*` to `_text_`, so an
// edit that searched for the asterisk form stopped matching the moment the
// document was first formatted, and did nothing without failing.
//
// A stale version on a specification whose whole job is to be trusted is worse
// than a missing one, so the agreement is asserted rather than remembered.
const SPEC = readFileSync(fileURLToPath(new URL('../../../SPEC.md', import.meta.url)), 'utf-8');

// HANDOVER.md names the spec version it was last checked against, and that
// marker rotted for forty-one versions - it still said v1.11 at v1.52, on a
// file whose own opening paragraph asks the reader to keep it current.
// Discipline is what failed there, so the claim is asserted instead: the file
// states the version in exactly one place, in the table of Section 1, and this
// test reads that place and SPEC.md's front matter and requires them to agree.
//
// Reading both files is the point. A test that read only HANDOVER.md would
// pass every time SPEC.md was bumped without it, which is precisely the drift
// that happened.
const HANDOVER = readFileSync(
  fileURLToPath(new URL('../../../HANDOVER.md', import.meta.url)),
  'utf-8',
);

// The front-matter version, shared by both tests below. SPEC.md's own two
// markers are checked against each other in the first of them, so either one
// is as good a reference as the other once that passes; the front matter is
// the one a reader looks at.
const SPEC_FRONT_MATTER_VERSION = /^\*\*Version:\*\* (\d+\.\d+)$/m;

describe("SPEC.md's version", () => {
  it('is the same in the front matter and in the closing line', () => {
    const front = SPEC.match(SPEC_FRONT_MATTER_VERSION);
    const end = SPEC.match(/^_End of specification v(\d+\.\d+)_$/m);

    expect(front, 'SPEC.md has no `**Version:** N.N` line in its front matter').not.toBeNull();
    expect(end, 'SPEC.md has no `_End of specification vN.N_` closing line').not.toBeNull();
    expect(
      end?.[1],
      'the closing line disagrees with the front matter - one of the two was bumped and the ' +
        'other was not, which is how this drifted by eight versions once already',
    ).toBe(front?.[1]);
  });
});

describe("HANDOVER.md's spec version", () => {
  it("is the version SPEC.md's front matter states", () => {
    const front = SPEC.match(SPEC_FRONT_MATTER_VERSION);
    const handover = HANDOVER.match(/^\|\s*Spec version\s*\|\s*(\d+\.\d+)\s*\|$/m);

    expect(front, 'SPEC.md has no `**Version:** N.N` line in its front matter').not.toBeNull();
    expect(
      handover,
      'HANDOVER.md has no `| Spec version | N.N |` row in its Section 1 table - it is the one ' +
        'place that file may state a spec version, and this test is what keeps it honest',
    ).not.toBeNull();
    expect(
      handover?.[1],
      "HANDOVER.md states a spec version that is not SPEC.md's - either the spec was bumped " +
        'without the handover being re-read, or the handover was edited to a version the spec ' +
        'never reached',
    ).toBe(front?.[1]);
  });
});
