// SPEC.md Section 7.3: "Newly revealed cells animate from opaque to clear
// over 600 ms." Section 8.2: `prefers-reduced-motion` disables that
// animation entirely - not "shortens it", so a reduced-motion caller must
// receive the finished state on the very first frame, not an accelerated
// transition.
//
// This constant is spec-normative (the "600 ms" above) and would ordinarily
// live in packages/shared/src/config.ts alongside every other spec constant
// (CLAUDE.md's constant rule) - it is defined here instead only because
// this task's scope explicitly excludes touching packages/shared. See the
// task report's NOTES.
export const FOG_REVEAL_ANIMATION_MS = 600;

/**
 * Fraction (0..1) of the reveal animation completed after `elapsedMs`.
 * Pure function of time, independent of any GL state, so it is testable
 * without a GPU - see reveal-animation.test.ts.
 */
export function revealProgress(
  elapsedMs: number,
  durationMs: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion || durationMs <= 0) {
    return 1;
  }
  if (elapsedMs <= 0) {
    return 0;
  }
  if (elapsedMs >= durationMs) {
    return 1;
  }
  return elapsedMs / durationMs;
}

/** The R8 fog-alpha texel value (255 = opaque fog, 0 = clear) at a given animation progress. */
export function fogTexelAt(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.round(255 * (1 - clamped));
}
