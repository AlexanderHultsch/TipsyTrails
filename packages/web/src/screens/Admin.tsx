import { compareBarsByName } from '@tipsytrails/shared';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ApiError,
  createAdminBar,
  deleteAdminBar,
  getAdminBars,
  getAdminUsers,
  updateAdminBar,
} from '../api/client.js';
import type { AdminBar, AdminUser } from '../api/types.js';
import { BurgerMenu } from '../components/BurgerMenu.js';

type SourceFilter = 'all' | 'osm' | 'community' | 'admin';

const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'osm', label: 'OSM' },
  { value: 'community', label: 'Community' },
  { value: 'admin', label: 'Admin' },
];

interface BarFormState {
  name: string;
  address: string;
  lat: string;
  lon: string;
}

const EMPTY_BAR_FORM: BarFormState = { name: '', address: '', lat: '', lon: '' };

function genericError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

// GET /api/admin/bars sends the list ordered by name (SPEC.md Section 9.3),
// but this screen then edits that list in place: a created bar would sit at
// the bottom and a renamed one would keep its old slot until the admin
// reloaded the page. The two local changes that can move a row - creating a
// bar and saving an edited name - go through here, using the same comparator
// the server sorted with (packages/shared/src/bars.ts), so the order the
// admin sees is the order Section 9.3 promises whatever they have just done
// to it. Hiding and deleting need no re-sort: neither touches a name, and
// removing a row cannot disorder the rest. `sort` mutates, so this copies
// first - the argument is React state.
function sortedByName(bars: AdminBar[]): AdminBar[] {
  return [...bars].sort(compareBarsByName);
}

// SPEC.md Section 8.3/9.3, Phase 7 step 3: bar management (list including
// hidden, filter by source, create, edit, hide, delete) plus the user list.
// Reachable only via /admin, itself gated by RequireAdmin
// (auth/route-guards.tsx) - a cosmetic redirect, not a security boundary;
// every mutation here still goes through requireAdmin server-side
// (packages/api/src/auth/cookie.ts), which is what actually enforces this.
export function Admin() {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [bars, setBars] = useState<AdminBar[]>([]);
  const [barsLoading, setBarsLoading] = useState(true);
  const [barsError, setBarsError] = useState<string | null>(null);
  const [rowActionError, setRowActionError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<BarFormState>(EMPTY_BAR_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<BarFormState>(EMPTY_BAR_FORM);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBarsLoading(true);
    setBarsError(null);
    getAdminBars(sourceFilter === 'all' ? undefined : { source: sourceFilter })
      .then((result) => {
        if (!cancelled) setBars(result.bars);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBarsError(genericError(err));
      })
      .finally(() => {
        if (!cancelled) setBarsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceFilter]);

  useEffect(() => {
    let cancelled = false;
    getAdminUsers()
      .then((result) => {
        if (!cancelled) setUsers(result.users);
      })
      .catch((err: unknown) => {
        if (!cancelled) setUsersError(genericError(err));
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function parseLatLon(form: BarFormState): { lat: number; lon: number } | null {
    const lat = Number(form.lat);
    const lon = Number(form.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    return { lat, lon };
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError(null);
    const coords = parseLatLon(createForm);
    if (!coords) {
      setCreateError('Latitude and longitude must be numbers.');
      return;
    }
    setCreating(true);
    try {
      const bar = await createAdminBar({
        name: createForm.name,
        address: createForm.address.trim() ? createForm.address.trim() : null,
        lat: coords.lat,
        lon: coords.lon,
      });
      setBars((current) => sortedByName([...current, bar]));
      setCreateForm(EMPTY_BAR_FORM);
    } catch (err) {
      setCreateError(genericError(err));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(bar: AdminBar) {
    setEditingId(bar.id);
    setEditError(null);
    setEditForm({
      name: bar.name,
      address: bar.address ?? '',
      lat: String(bar.lat),
      lon: String(bar.lon),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>, barId: number) {
    event.preventDefault();
    setEditError(null);
    const coords = parseLatLon(editForm);
    if (!coords) {
      setEditError('Latitude and longitude must be numbers.');
      return;
    }
    setSavingEdit(true);
    try {
      const updated = await updateAdminBar(barId, {
        name: editForm.name,
        address: editForm.address.trim() ? editForm.address.trim() : null,
        lat: coords.lat,
        lon: coords.lon,
      });
      setBars((current) => sortedByName(current.map((bar) => (bar.id === barId ? updated : bar))));
      setEditingId(null);
    } catch (err) {
      setEditError(genericError(err));
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleToggleStatus(bar: AdminBar) {
    setRowActionError(null);
    const nextStatus = bar.status === 'active' ? 'hidden' : 'active';
    try {
      const updated = await updateAdminBar(bar.id, { status: nextStatus });
      setBars((current) => current.map((entry) => (entry.id === bar.id ? updated : entry)));
    } catch (err) {
      setRowActionError(genericError(err));
    }
  }

  // Phase 7 task brief: deletion is destructive and irreversible, so the
  // confirmation must name the bar - window.confirm is the plainest way to
  // block on that and to make "dismissed means no API call" trivial to
  // verify, matching this codebase's other irreversible action
  // (Settings.tsx's account deletion, which instead requires re-entering
  // the password - not applicable here since this acts on someone else's
  // data).
  async function handleDelete(bar: AdminBar) {
    if (!window.confirm(`Delete "${bar.name}"? This cannot be undone.`)) {
      return;
    }
    setRowActionError(null);
    try {
      await deleteAdminBar(bar.id);
      setBars((current) => current.filter((entry) => entry.id !== bar.id));
    } catch (err) {
      setRowActionError(genericError(err));
    }
  }

  return (
    <main className="screen">
      <BurgerMenu />
      <div className="screen__content admin">
        <h1>Admin</h1>

        <section className="admin__section">
          <h2>Bars</h2>

          <div className="leaderboard__toggle" role="group" aria-label="Filter by source">
            {SOURCE_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  option.value === sourceFilter
                    ? 'leaderboard__toggle-button leaderboard__toggle-button--active'
                    : 'leaderboard__toggle-button'
                }
                aria-pressed={option.value === sourceFilter}
                onClick={() => setSourceFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {barsLoading && <p role="status">Loading bars…</p>}
          {barsError && (
            <p className="error-message" role="alert">
              {barsError}
            </p>
          )}
          {rowActionError && (
            <p className="error-message" role="alert">
              {rowActionError}
            </p>
          )}
          {!barsLoading && bars.length === 0 && <p>No bars match this filter.</p>}

          {bars.length > 0 && (
            <ul className="admin-bar-list">
              {bars.map((bar) =>
                editingId === bar.id ? (
                  <li key={bar.id} className="admin-bar-row">
                    <form
                      className="admin-bar-row__edit-form"
                      onSubmit={(event) => void handleEditSubmit(event, bar.id)}
                    >
                      {editError && (
                        <p className="error-message" role="alert">
                          {editError}
                        </p>
                      )}
                      <div className="field">
                        <label htmlFor={`admin-edit-name-${bar.id}`}>Name</label>
                        <input
                          id={`admin-edit-name-${bar.id}`}
                          value={editForm.name}
                          onChange={(event) =>
                            setEditForm((current) => ({ ...current, name: event.target.value }))
                          }
                          required
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`admin-edit-address-${bar.id}`}>Address</label>
                        <input
                          id={`admin-edit-address-${bar.id}`}
                          value={editForm.address}
                          onChange={(event) =>
                            setEditForm((current) => ({
                              ...current,
                              address: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`admin-edit-lat-${bar.id}`}>Latitude</label>
                        <input
                          id={`admin-edit-lat-${bar.id}`}
                          value={editForm.lat}
                          onChange={(event) =>
                            setEditForm((current) => ({ ...current, lat: event.target.value }))
                          }
                          inputMode="decimal"
                          required
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`admin-edit-lon-${bar.id}`}>Longitude</label>
                        <input
                          id={`admin-edit-lon-${bar.id}`}
                          value={editForm.lon}
                          onChange={(event) =>
                            setEditForm((current) => ({ ...current, lon: event.target.value }))
                          }
                          inputMode="decimal"
                          required
                        />
                      </div>
                      <div className="admin-bar-row__actions">
                        <button
                          className="button button--primary"
                          type="submit"
                          disabled={savingEdit}
                        >
                          Save
                        </button>
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={cancelEdit}
                          disabled={savingEdit}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </li>
                ) : (
                  <li key={bar.id} className="admin-bar-row">
                    <div className="admin-bar-row__info">
                      <p className="admin-bar-row__name">
                        {bar.name}
                        {bar.source === 'community' && (
                          <span className="admin-bar-row__tag">Community</span>
                        )}
                        {bar.status === 'hidden' && (
                          <span className="admin-bar-row__tag admin-bar-row__tag--hidden">
                            Hidden
                          </span>
                        )}
                      </p>
                      {bar.address && <p className="admin-bar-row__address">{bar.address}</p>}
                      <p className="admin-bar-row__meta">Source: {bar.source}</p>
                    </div>
                    <div className="admin-bar-row__actions">
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => startEdit(bar)}
                      >
                        Edit
                      </button>
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => void handleToggleStatus(bar)}
                      >
                        {bar.status === 'active' ? 'Hide' : 'Unhide'}
                      </button>
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => void handleDelete(bar)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ),
              )}
            </ul>
          )}

          <form className="admin-create-form" onSubmit={handleCreateSubmit}>
            <h3>Add a bar</h3>
            {createError && (
              <p className="error-message" role="alert">
                {createError}
              </p>
            )}
            <div className="field">
              <label htmlFor="admin-create-name">Name</label>
              <input
                id="admin-create-name"
                value={createForm.name}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, name: event.target.value }))
                }
                required
              />
            </div>
            <div className="field">
              <label htmlFor="admin-create-address">Address</label>
              <input
                id="admin-create-address"
                value={createForm.address}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, address: event.target.value }))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="admin-create-lat">Latitude</label>
              <input
                id="admin-create-lat"
                value={createForm.lat}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, lat: event.target.value }))
                }
                inputMode="decimal"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="admin-create-lon">Longitude</label>
              <input
                id="admin-create-lon"
                value={createForm.lon}
                onChange={(event) =>
                  setCreateForm((current) => ({ ...current, lon: event.target.value }))
                }
                inputMode="decimal"
                required
              />
            </div>
            <button className="button button--primary" type="submit" disabled={creating}>
              Create bar
            </button>
          </form>
        </section>

        <section className="admin__section">
          <h2>Users</h2>
          {usersLoading && <p role="status">Loading users…</p>}
          {usersError && (
            <p className="error-message" role="alert">
              {usersError}
            </p>
          )}
          {!usersLoading && users.length > 0 && (
            <ul className="admin-user-list">
              {users.map((entry) => (
                <li key={entry.id} className="admin-user-row">
                  <span className="admin-user-row__name">
                    {entry.username}
                    {entry.isAdmin && <span className="admin-bar-row__tag">Admin</span>}
                  </span>
                  <span className="admin-user-row__stat">
                    {entry.areaPercent.toFixed(1)}% explored
                  </span>
                  <span className="admin-user-row__stat">{entry.barsMastered} mastered</span>
                  <span className="admin-user-row__stat">{entry.badgeCount} badges</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
