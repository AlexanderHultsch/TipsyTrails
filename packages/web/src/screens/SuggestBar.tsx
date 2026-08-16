import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, suggestBar } from '../api/client.js';
import { BurgerMenu } from '../components/BurgerMenu.js';
import { MapPicker } from '../map/MapPicker.js';
import type { PickedPosition } from '../map/MapPicker.js';

// SPEC.md Section 8.3/11.3, Phase 7 step 3: a map picker to place the pin
// (mandatory - Section 11.3 is explicit that this is how position is set,
// not geocoding), plus name and address. On success the bar is already
// discovered server-side (routes/bars.ts's suggest handler inserts the
// bar_discoveries row in the same transaction), so navigating to its detail
// screen shows that immediately via ordinary client-side routing - no
// reload, and no client-side bookkeeping duplicating what the server
// already did.
export function SuggestBar() {
  const navigate = useNavigate();
  const [position, setPosition] = useState<PickedPosition | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!position) {
      setError("Tap the map to place a pin at the bar's location.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const bar = await suggestBar({
        name,
        address: address.trim() ? address.trim() : null,
        lat: position.lat,
        lon: position.lon,
      });
      navigate(`/bars/${bar.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="screen">
      <BurgerMenu />
      <div className="screen__content suggest-bar">
        <h1>Suggest a bar</h1>
        <p>Tap the map to place a pin at the bar&apos;s exact location.</p>
        <MapPicker value={position} onPick={setPosition} />
        <form className="form" onSubmit={handleSubmit}>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="field">
            <label htmlFor="suggest-bar-name">Name</label>
            <input
              id="suggest-bar-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="suggest-bar-address">Address</label>
            <input
              id="suggest-bar-address"
              name="address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </div>
          <div className="screen__actions">
            <button
              className="button button--primary"
              type="submit"
              disabled={submitting || !position}
            >
              Submit
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
