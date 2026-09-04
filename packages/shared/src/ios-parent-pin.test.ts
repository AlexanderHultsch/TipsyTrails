import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `ios/SPEC.md`'s front matter pins the parent it was checked against - "**Parent:**
// `SPEC.md` at the repository root, v1.58". This file is what turns that pin from a
// decoration into a gate: the moment `main` moves and is merged into `ios-app`, this
// branch goes red and stays red until somebody reads the dependency surface in
// `ios/PARENT-CONTRACT.md`, records a merge row, and bumps the pin. The redness is the
// feature - it is the branch declining to pretend a decision was made.
//
// **A new file rather than an edit to spec-version.test.ts, deliberately.** That file
// exists on `main` too and is edited there; this one exists only on `ios-app` and so has
// no merge surface at all. It borrows that file's approach for locating and reading the
// two documents, which is the whole of what the two have in common.
//
// The reason this exists at all is the same reason spec-version.test.ts does: a
// hand-maintained claim about another file rots. `HANDOVER.md` carried "SPEC.md is now
// v1.11" for forty-one versions. A written list of "every change on `main` the iOS
// branch should know about" would be a third copy of the same kind, and mostly noise -
// `ios/PARENT-CONTRACT.md`'s opening says why that was rejected in favour of a surface
// list plus this test.
const REPO_ROOT_SPEC = readFileSync(
  fileURLToPath(new URL('../../../SPEC.md', import.meta.url)),
  'utf-8',
);

const IOS_SPEC = readFileSync(
  fileURLToPath(new URL('../../../ios/SPEC.md', import.meta.url)),
  'utf-8',
);

// Anchored to the front-matter line and not to a bare version pattern. `ios/SPEC.md`
// mentions other versions in its prose - "Superseded by `ios/SPEC.md` (v1.59)" in
// Section 14, "v0.1" in the changelog - and a loose regex would happily pin the branch
// to whichever of them it found first.
const IOS_PARENT_PIN = /^\*\*Parent:\*\* .*?\bv(\d+\.\d+)\b/m;
const SPEC_FRONT_MATTER_VERSION = /^\*\*Version:\*\* (\d+\.\d+)$/m;

const HOW_TO_CLEAR =
  'To clear it, three steps in this order. ' +
  '(1) Read the dependency surface in ios/PARENT-CONTRACT.md Section 1 and check the merged ' +
  'changes against it - the question is "did any of them touch anything on that list?", not ' +
  '"is any of this about iOS?", and Section 2 names what is deliberately out so you can stop ' +
  'looking early. ' +
  '(2) Add one row to the merge record in ios/PARENT-CONTRACT.md Section 3: the date, the main ' +
  'commit merged, the parent version, and the verdict - either "nothing on the surface moved" ' +
  'or what did and what it costs here. One row per merge, never one per change. ' +
  "(3) Bump the **Parent:** pin in ios/SPEC.md's front matter. That edit is you saying the " +
  'check was done, and it is the only thing it means.';

describe("ios/SPEC.md's pin to the parent specification", () => {
  it('exists in the front matter', () => {
    // Asserted separately, and first, because a test that only compared the two
    // versions would PASS once this line was deleted - `undefined` on both sides of a
    // conditional, or a regex that simply found nothing to disagree with. A silently
    // decoupled branch looks exactly like a branch in agreement, and that is the
    // failure this whole arrangement exists to prevent.
    expect(
      IOS_SPEC.match(IOS_PARENT_PIN),
      'ios/SPEC.md has no `**Parent:** ... vN.N` line in its front matter. That line is the pin: ' +
        'it names the root SPEC.md version the iOS specification was last checked against, and it ' +
        'is the only thing tying this branch to the parent. Deleting it does not make the iPhone ' +
        'app independent of main - it makes the drift invisible, which is how HANDOVER.md came to ' +
        'carry a stale spec version for forty-one releases. Restore the line; ' +
        'ios/PARENT-CONTRACT.md Section 4 says what it is for.',
    ).not.toBeNull();
  });

  it('names a version the root SPEC.md states', () => {
    expect(
      REPO_ROOT_SPEC.match(SPEC_FRONT_MATTER_VERSION),
      'SPEC.md has no `**Version:** N.N` line in its front matter, so there is nothing for ' +
        "ios/SPEC.md's parent pin to be checked against. The pin is meaningless without it and " +
        'this branch cannot tell whether it is current.',
    ).not.toBeNull();
  });

  it("is the root SPEC.md's current version", () => {
    const pinned = IOS_SPEC.match(IOS_PARENT_PIN)?.[1];
    const current = REPO_ROOT_SPEC.match(SPEC_FRONT_MATTER_VERSION)?.[1];

    expect(
      pinned,
      `ios/SPEC.md pins the parent at v${String(pinned)} and the root SPEC.md is now ` +
        `v${String(current)}. This is not two strings to bring into line: main has moved, and ` +
        'nobody has yet said what that movement means for the iPhone app. ' +
        HOW_TO_CLEAR +
        ' If the surface did move, the amendment or the fix belongs in the same commit as the ' +
        'row. If the pin is instead AHEAD of the root version, somebody bumped it against a ' +
        'parent release that does not exist yet - revert the pin, not the parent.',
    ).toBe(current);
  });
});
