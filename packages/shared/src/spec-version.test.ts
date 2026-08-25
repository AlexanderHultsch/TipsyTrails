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

describe("SPEC.md's version", () => {
  it('is the same in the front matter and in the closing line', () => {
    const front = SPEC.match(/^\*\*Version:\*\* (\d+\.\d+)$/m);
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
