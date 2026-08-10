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
