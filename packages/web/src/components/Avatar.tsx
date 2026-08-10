import { useMemo } from 'react';
import { generateAvatarSvg } from '@tipsytrails/shared';

// Mirrors --color-ink / --color-paper in index.css. Passed explicitly rather
// than relying on the generator's own defaults, so the mark matches the
// surrounding design tokens (Section 8.5).
const AVATAR_INK = '#1c1a17';
const AVATAR_PAPER = '#f4efe6';

// Deterministic geometric mark for a user's avatar_seed (Section 8.5).
// generateAvatarSvg's own tests guarantee the output can never contain a
// <script> element or an event-handler attribute, so it is safe to insert
// directly, nothing is concatenated onto the returned markup before it goes
// into the DOM.
export function Avatar({ seed, className }: { seed: string; className?: string }) {
  const markup = useMemo(() => generateAvatarSvg(seed, AVATAR_INK, AVATAR_PAPER), [seed]);

  return (
    <span
      className={className ? `avatar ${className}` : 'avatar'}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
