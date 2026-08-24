import { COCKTAIL_GLASS_VIEW_BOX, cocktailGlassPathData } from './cocktail-glass.js';

// The React half of the mark defined in cocktail-glass.ts - the same paths
// the map marker draws, rendered as elements instead of as a markup string.
// It holds no geometry of its own on purpose: two renderings of one shape is
// the arrangement, two shapes is the bug.
//
// Always decorative. SPEC.md Section 8.1 forbids a state that only a visual
// channel carries, so every caller puts the state in words beside the glass
// (components/BarSheet.tsx, screens/BarDetail.tsx) - which makes this
// element itself something a screen reader should skip rather than announce
// twice.
export function CocktailGlass({ mastered, className }: { mastered: boolean; className?: string }) {
  return (
    <svg
      className={className ? `cocktail-glass ${className}` : 'cocktail-glass'}
      viewBox={COCKTAIL_GLASS_VIEW_BOX}
      aria-hidden="true"
      focusable="false"
    >
      {cocktailGlassPathData(mastered).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
