// Deterministic avatar generator (SPEC.md Section 8.5).
//
// Turns a user's `avatar_seed` into a small black-on-paper geometric mark —
// no image files, no uploads, just an inline SVG string derived purely from
// the seed. Pure and side-effect free: no `Math.random`, no `Date`, no DOM,
// so it runs identically on the server and in the browser and is safe to
// unit-test without a DOM environment.

/** Default black ink and paper-ground tones; callers may pass their own tokens. */
const DEFAULT_INK = '#1a1a1a';
const DEFAULT_PAPER = '#f4efe6';

/** The mark is laid out on a GRID_SIZE x GRID_SIZE grid, mirrored left-right. */
const GRID_SIZE = 5;
const VIEWBOX = 100;
const CELL = VIEWBOX / GRID_SIZE;
/** Only the left half plus the centre column need their own decision; the right half mirrors it. */
const DECISION_COLUMNS = Math.ceil(GRID_SIZE / 2);
const CELL_COUNT = GRID_SIZE * DECISION_COLUMNS;

/**
 * Expands the seed string into `count` deterministic 32-bit words.
 *
 * Step 1: fold the whole seed into a single 32-bit value with FNV-1a, so
 * every character of the seed affects the result (an empty seed simply
 * keeps the FNV offset basis untouched).
 * Step 2: walk that value forward with a splitmix32 step to produce as
 * many further well-mixed words as the layout needs. Both steps are plain
 * integer arithmetic — no randomness, no clock, fully reproducible.
 */
function deriveWords(seed: string, count: number): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;

  const words: number[] = [];
  let state = h;
  for (let i = 0; i < count; i++) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z ^= z >>> 16;
    words.push(z >>> 0);
  }
  return words;
}

/** Renders one schematic shape, centred at (cx, cy), spanning roughly `size` units. */
function renderShape(kind: number, cx: number, cy: number, size: number, ink: string): string {
  const half = size / 2;
  switch (kind) {
    case 0: // circle
      return `<circle cx="${cx}" cy="${cy}" r="${half}" fill="${ink}"/>`;
    case 1: // rectangle
      return `<rect x="${cx - half}" y="${cy - half}" width="${size}" height="${size}" fill="${ink}"/>`;
    case 2: {
      // triangle
      const points = `${cx},${cy - half} ${cx - half},${cy + half} ${cx + half},${cy + half}`;
      return `<polygon points="${points}" fill="${ink}"/>`;
    }
    default: // line
      return `<line x1="${cx - half}" y1="${cy - half}" x2="${cx + half}" y2="${cy + half}" stroke="${ink}" stroke-width="${size * 0.18}"/>`;
  }
}

/**
 * Builds the avatar SVG for a given seed.
 *
 * `ink` and `paper` default to this package's tokens but are plain
 * parameters, not literals baked into the geometry, so the web package can
 * pass its own design tokens instead.
 */
export function generateAvatarSvg(
  seed: string,
  ink: string = DEFAULT_INK,
  paper: string = DEFAULT_PAPER,
): string {
  const words = deriveWords(seed, CELL_COUNT);

  const shapes: string[] = [];
  let wordIndex = 0;

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < DECISION_COLUMNS; col++) {
      const word = words[wordIndex];
      wordIndex += 1;

      // ~55% of decided cells carry a shape; the rest stay empty paper.
      const active = word % 100 < 55;
      if (!active) continue;

      const kind = Math.floor(word / 100) % 4;
      const sizeStep = Math.floor(word / 400) % 3;
      const scale = 0.5 + sizeStep * 0.2; // 0.5, 0.7 or 0.9 of the cell

      const cy = row * CELL + CELL / 2;
      const size = CELL * scale;

      const cx = col * CELL + CELL / 2;
      shapes.push(renderShape(kind, cx, cy, size, ink));

      const mirrorCol = GRID_SIZE - 1 - col;
      if (mirrorCol !== col) {
        const mirrorCx = mirrorCol * CELL + CELL / 2;
        shapes.push(renderShape(kind, mirrorCx, cy, size, ink));
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">` +
    `<rect x="0" y="0" width="${VIEWBOX}" height="${VIEWBOX}" fill="${paper}"/>` +
    shapes.join('') +
    `</svg>`
  );
}
