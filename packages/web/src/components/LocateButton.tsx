interface LocateButtonProps {
  disabled: boolean;
  onClick: () => void;
}

// Section 8.3's "to my location" control, shared by the two screens that
// show a map: screens/Map.tsx and map/MapPicker.tsx. One component rather
// than the same markup twice, so the class, the icon and above all the
// accessible name cannot drift apart between them.
//
// Disabled rather than hidden while there is no fix yet: a control that
// appears and disappears is harder to find than one that is visibly inert.
// What the click does is the caller's business - both centre their own map -
// but both do it with flyTo: this is an explicit request, so the animation
// is what tells the player where they were taken from.
export function LocateButton({ disabled, onClick }: LocateButtonProps) {
  return (
    <button
      type="button"
      className="map-locate"
      aria-label="Go to my location"
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">&#9678;</span>
    </button>
  );
}
