import { compareBarsByName } from '@tipsytrails/shared';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  adminTeleport,
  ApiError,
  cancelVisit,
  createAdminBar,
  deleteAdminBar,
  errorMessage,
  getAdminBars,
  getAdminUsers,
  getPendingVisits,
  updateAdminBar,
  updateAdminUser,
} from '../api/client.js';
import type {
  AdminBar,
  AdminUser,
  BarSource,
  SamplesResponse,
  VisitSummary,
} from '../api/types.js';
import { BottomNav } from '../components/BottomNav.js';
import { MapPicker } from '../map/MapPicker.js';
import type { PickedPosition } from '../map/MapPicker.js';
import { isVisitAlreadyGone } from '../tracking/useVisits.js';

// The bar sources the API can actually report, plus the no-filter option -
// built from `BarSource` rather than retyped, so a fourth source added to the
// server's vocabulary is a compile error in SOURCE_FILTERS below rather than
// a filter button nobody ever adds.
type SourceFilter = 'all' | BarSource;

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

function parseLatLon(form: BarFormState): { lat: number; lon: number } | null {
  const lat = Number(form.lat);
  const lon = Number(form.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
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

// The four fields a bar is described by, rendered identically by the create
// form and by each row's edit form - one component rather than two copies
// that could come to disagree about which fields a bar has or which of them
// are required.
//
// Only the element ids differ, and they have to: the create form is on the
// page once, while an edit form belongs to a particular row and carries that
// bar's id to stay unique. Each id is a label's `htmlFor` target, so
// `fieldId` lets the caller that knows which form this is build them.
function BarFormFields({
  form,
  onChange,
  fieldId,
}: {
  form: BarFormState;
  onChange: (patch: Partial<BarFormState>) => void;
  fieldId: (field: 'name' | 'address' | 'lat' | 'lon') => string;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor={fieldId('name')}>Name</label>
        <input
          id={fieldId('name')}
          value={form.name}
          onChange={(event) => onChange({ name: event.target.value })}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={fieldId('address')}>Address</label>
        <input
          id={fieldId('address')}
          value={form.address}
          onChange={(event) => onChange({ address: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={fieldId('lat')}>Latitude</label>
        <input
          id={fieldId('lat')}
          value={form.lat}
          onChange={(event) => onChange({ lat: event.target.value })}
          inputMode="decimal"
          required
        />
      </div>
      <div className="field">
        <label htmlFor={fieldId('lon')}>Longitude</label>
        <input
          id={fieldId('lon')}
          value={form.lon}
          onChange={(event) => onChange({ lon: event.target.value })}
          inputMode="decimal"
          required
        />
      </div>
    </>
  );
}

// SPEC.md Section 9.3: the bar list including hidden bars, the source filter,
// and create/edit/hide/delete. All of this screen's state that is not the
// user list or the visit list lives here, so those two are unaffected by any
// of it.
function BarsSection() {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [bars, setBars] = useState<AdminBar[]>([]);
  const [barsLoading, setBarsLoading] = useState(true);
  const [barsError, setBarsError] = useState<string | null>(null);
  // Shared by handleToggleStatus and handleDelete below, unlike
  // createError/editError, which each belong to one open form: a toggle or
  // a delete has no form of its own to show its error next to - the click
  // that triggers it comes straight off the row - so one banner above the
  // list is that action's only place to report a failure.
  const [rowActionError, setRowActionError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<BarFormState>(EMPTY_BAR_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<BarFormState>(EMPTY_BAR_FORM);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBarsLoading(true);
    setBarsError(null);
    getAdminBars(sourceFilter === 'all' ? undefined : { source: sourceFilter })
      .then((result) => {
        if (!cancelled) setBars(result.bars);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBarsError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setBarsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceFilter]);

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
      setCreateError(errorMessage(err));
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
      setEditError(errorMessage(err));
    } finally {
      setSavingEdit(false);
    }
  }

  // Unlike handleDelete below, this asks for no confirmation. 'hidden' only
  // removes a bar from player-facing endpoints (routes/bars.ts filters on
  // `status = 'active'`); it does not touch bar_discoveries or visits, so
  // an admin who hides the wrong bar by mistake corrects it with a second
  // tap of the same button, not a support request. The two statuses are the
  // whole vocabulary the server accepts here (patchBarSchema,
  // packages/api/src/routes/admin.ts) - there is no third value to guard
  // against, so the toggle needs no state machine, just the opposite of
  // whatever the row currently shows.
  async function handleToggleStatus(bar: AdminBar) {
    setRowActionError(null);
    const nextStatus = bar.status === 'active' ? 'hidden' : 'active';
    try {
      const updated = await updateAdminBar(bar.id, { status: nextStatus });
      setBars((current) => current.map((entry) => (entry.id === bar.id ? updated : entry)));
    } catch (err) {
      setRowActionError(errorMessage(err));
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
      setRowActionError(errorMessage(err));
    }
  }

  return (
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
                  <BarFormFields
                    form={editForm}
                    onChange={(patch) => setEditForm((current) => ({ ...current, ...patch }))}
                    fieldId={(field) => `admin-edit-${field}-${bar.id}`}
                  />
                  <div className="admin-bar-row__actions">
                    <button className="button button--primary" type="submit" disabled={savingEdit}>
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
                      <span className="admin-bar-row__tag admin-bar-row__tag--hidden">Hidden</span>
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
        <BarFormFields
          form={createForm}
          onChange={(patch) => setCreateForm((current) => ({ ...current, ...patch }))}
          fieldId={(field) => `admin-create-${field}`}
        />
        <button className="button button--primary" type="submit" disabled={creating}>
          Create bar
        </button>
      </form>
    </section>
  );
}

// SPEC.md Section 7.5's cancel endpoint, reached from a second place. This
// is an escape hatch, not a new admin power: GET /api/visits/pending and
// POST /api/visits/:id/cancel both act on the *caller's* own visits and
// nobody else's (packages/api/src/routes/visits.ts), so this list is the
// signed-in admin's own pending visits and no server route was added for
// it. It exists because a pending visit that the map's banner cannot get
// rid of leaves a player stuck with no other way out, and the admin screen
// is a place they can always reach - unlike the banner, which needs a map,
// a position and the right screen.
function PendingVisitsSection() {
  const [pendingVisits, setPendingVisits] = useState<VisitSummary[]>([]);
  const [pendingVisitsError, setPendingVisitsError] = useState<string | null>(null);
  const [cancellingVisitId, setCancellingVisitId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPendingVisits()
      .then((result) => {
        if (!cancelled) setPendingVisits(result.visits);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPendingVisitsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCancelVisit(visit: VisitSummary) {
    if (
      !window.confirm(`Cancel your pending visit to "${visit.barName}"? This cannot be undone.`)
    ) {
      return;
    }
    setPendingVisitsError(null);
    setCancellingVisitId(visit.id);
    try {
      await cancelVisit(visit.id);
      setPendingVisits((current) => current.filter((entry) => entry.id !== visit.id));
    } catch (err) {
      // Section 9.5's identical 404 means the visit is not pending, which is
      // what the click asked for - the same rule the banner follows, from
      // the same helper, so the two screens cannot disagree about it.
      if (isVisitAlreadyGone(err)) {
        setPendingVisits((current) => current.filter((entry) => entry.id !== visit.id));
        return;
      }
      setPendingVisitsError(errorMessage(err));
    } finally {
      setCancellingVisitId(null);
    }
  }

  return (
    <section className="admin__section">
      <h2>Your pending visits</h2>
      {pendingVisitsError && (
        <p className="error-message" role="alert">
          {pendingVisitsError}
        </p>
      )}
      {pendingVisits.length === 0 ? (
        <p>You have no pending visits.</p>
      ) : (
        <ul className="admin-visit-list">
          {pendingVisits.map((visit) => (
            <li key={visit.id} className="admin-visit-row">
              <span className="admin-visit-row__bar">{visit.barName}</span>
              <button
                className="button button--secondary admin-visit-row__cancel"
                type="button"
                disabled={cancellingVisitId === visit.id}
                onClick={() => void handleCancelVisit(visit)}
              >
                Cancel visit
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// SPEC.md Section 9.3, Phase 7 task brief: "user list with stats", plus the
// one thing on this screen that edits a user - Section 7.8's ranking
// exclusion. Everything else about a user stays read-only.
function UsersSection() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  // Shared by every row's toggle, like BarsSection's `rowActionError` above
  // and for the same reason: the click comes straight off a row, so one
  // banner over the list is the only place the failure has to go.
  const [rowActionError, setRowActionError] = useState<string | null>(null);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminUsers()
      .then((result) => {
        if (!cancelled) setUsers(result.users);
      })
      .catch((err: unknown) => {
        if (!cancelled) setUsersError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Like BarsSection's hide/unhide, this asks for no confirmation: the
  // opposite of whatever the row shows is one more tap away, and the server
  // accepts only the two states. What it must never be is silent - the flag
  // decides who can win a badge, so the row says so in words as well as in
  // the button's label.
  async function handleToggleExcluded(user: AdminUser) {
    setRowActionError(null);
    setSavingUserId(user.id);
    try {
      const updated = await updateAdminUser(user.id, {
        excludedFromRankings: !user.excludedFromRankings,
      });
      setUsers((current) => current.map((entry) => (entry.id === user.id ? updated : entry)));
    } catch (err) {
      setRowActionError(errorMessage(err));
    } finally {
      setSavingUserId(null);
    }
  }

  return (
    <section className="admin__section">
      <h2>Users</h2>
      {usersLoading && <p role="status">Loading users…</p>}
      {usersError && (
        <p className="error-message" role="alert">
          {usersError}
        </p>
      )}
      {rowActionError && (
        <p className="error-message" role="alert">
          {rowActionError}
        </p>
      )}
      {!usersLoading && users.length > 0 && (
        <ul className="admin-user-list">
          {users.map((entry) => (
            <li key={entry.id} className="admin-user-row">
              <span className="admin-user-row__name">
                {entry.username}
                {entry.isAdmin && <span className="admin-bar-row__tag">Admin</span>}
                {entry.excludedFromRankings && (
                  <span className="admin-bar-row__tag admin-bar-row__tag--hidden">Not ranked</span>
                )}
              </span>
              <span className="admin-user-row__stat">{entry.areaPercent.toFixed(1)}% explored</span>
              <span className="admin-user-row__stat">{entry.barsMastered} mastered</span>
              <span className="admin-user-row__stat">{entry.badgeCount} badges</span>
              <button
                className="button button--secondary admin-user-row__toggle"
                type="button"
                disabled={savingUserId === entry.id}
                aria-pressed={entry.excludedFromRankings}
                onClick={() => void handleToggleExcluded(entry)}
              >
                {entry.excludedFromRankings ? 'Include in rankings' : 'Exclude from rankings'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="admin__note">
        An excluded account still plays and still sees its own figures. It is left out of the
        leaderboard and cannot win a badge. Badges it already holds are kept.
      </p>
    </section>
  );
}

// SPEC.md Sections 9.3/10.1: the admin teleport. The map picker is
// screens/SuggestBar.tsx's own (map/MapPicker.tsx), not a second one - the
// question is the same question, "which point on the map", and one component
// answering it in both places is one behaviour to keep right.
//
// Nothing here is a security control, and the panel is written so that is
// obvious. It renders for any admin who reaches this screen, sends the two
// numbers the picker produced, and reports what the server said. Every gate
// - the admin check, the environment variable, and the requirement that the
// account already be excluded from the rankings - is applied server-side on
// every request (packages/api/src/routes/admin-teleport.ts). Hiding this
// panel would protect nothing, so it is not offered as protection.
//
// The map is mounted only once the admin asks for it. A MapLibre instance is
// not free, this screen is mostly about bars and users, and on a server that
// never enabled teleport the map would be a WebGL context built for a button
// that answers 404.
function TeleportSection() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [position, setPosition] = useState<PickedPosition | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SamplesResponse | null>(null);
  // The server said this route does not exist, which for this route means
  // the deployment did not enable it. Kept apart from `error` because it is
  // not a failure to retry: the message replaces the control rather than
  // sitting above it.
  const [unavailable, setUnavailable] = useState(false);

  async function handleTeleport() {
    if (!position) {
      return;
    }
    setError(null);
    setResult(null);
    setMoving(true);
    try {
      setResult(await adminTeleport({ lat: position.lat, lon: position.lon }));
    } catch (err) {
      // A 404 from this route is the environment variable being unset, and
      // the body carries Fastify's own not-found shape with no `code`
      // (Section 9.5's first documented exception) - so its message names
      // the route rather than saying anything useful to a person. Answered
      // here in words instead of surfaced raw.
      if (err instanceof ApiError && err.status === 404) {
        setUnavailable(true);
        return;
      }
      setError(errorMessage(err));
    } finally {
      setMoving(false);
    }
  }

  return (
    <section className="admin__section">
      <h2>Teleport</h2>
      {unavailable ? (
        <p role="status">
          Teleport is not enabled on this server. It is switched on with the ADMIN_TELEPORT_ENABLED
          environment variable.
        </p>
      ) : (
        <>
          <p className="admin__note">
            Moves your own position to a point on the map, ignoring the speed limits. It counts:
            fog, discoveries and visit progress are all real. Only an account excluded from the
            rankings may use it.
          </p>
          {/* Section 9.3: teleport is a mode, not a one-shot, and the panel
              that starts it is where that has to be said. The map is where it
              is left - this screen deliberately does not carry a second
              control for that, because the state belongs beside the position
              it is faking and an admin looking at a phantom is looking at the
              map. */}
          <p className="admin__note">
            You stay at that point until you teleport somewhere else or leave teleport from the map,
            where a banner offers the way back. It survives a reload, because the position is held
            by the server rather than by this browser.
          </p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {pickerOpen ? (
            <MapPicker value={position} onPick={setPosition} />
          ) : (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setPickerOpen(true)}
            >
              Choose a point on the map
            </button>
          )}
          {pickerOpen && (
            <div className="screen__actions">
              <button
                className="button button--primary"
                type="button"
                disabled={moving || !position}
                onClick={() => void handleTeleport()}
              >
                Move here
              </button>
            </div>
          )}
          {result && (
            <p role="status">
              Moved. {result.newCells} new cells revealed, {result.newBars.length} bars discovered.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// SPEC.md Section 8.3/9.3, Phase 7 step 3: bar management (list including
// hidden, filter by source, create, edit, hide, delete), the user list with
// Section 7.8's ranking toggle, and Section 10.1's teleport. Reachable only
// via /admin, itself gated by RequireAdmin (auth/route-guards.tsx) - a
// cosmetic redirect, not a security boundary; every mutation here still goes
// through requireAdmin server-side (packages/api/src/auth/cookie.ts), which
// is what actually enforces this.
//
// The four sections below share no state and no request: each fetches what
// it shows and owns the loading and error state for it, which is why they
// are four components rather than one with a dozen `useState` calls between
// them.
export function Admin() {
  return (
    <main className="screen">
      <BottomNav />
      <div className="screen__content admin">
        <h1>Admin</h1>
        <BarsSection />
        <PendingVisitsSection />
        <UsersSection />
        <TeleportSection />
      </div>
    </main>
  );
}
