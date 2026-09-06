import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { deleteAccount, errorMessage, updateSettings } from '../api/client.js';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { useLogout } from '../auth/useLogout.js';
import { BottomNav } from '../components/BottomNav.js';
import { isShell } from '../shell/bridge.js';
import { postShellOpenConsent } from '../shell/messages.js';

export function Settings() {
  const { user, setUser } = useCurrentUser();
  const handleLogout = useLogout();
  // `ios/SPEC.md` 8.6: a "Background tracking" row, under the shell only.
  // "The row does not render in Safari, where it would describe a feature
  // the browser does not have" - a browser cannot track in the background at
  // all (`SPEC.md` 7.2), so a row offering to turn it on would be an offer
  // nothing could honour. Fixed at mount, as everywhere else this page asks.
  const [inShell] = useState(isShell);

  const [anonymousSaving, setAnonymousSaving] = useState(false);
  const [anonymousError, setAnonymousError] = useState<string | null>(null);

  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleAnonymousChange(event: ChangeEvent<HTMLInputElement>) {
    const isAnonymous = event.target.checked;
    setAnonymousError(null);
    setAnonymousSaving(true);
    try {
      const updated = await updateSettings({ isAnonymous });
      setUser(updated);
    } catch (err) {
      setAnonymousError(errorMessage(err));
    } finally {
      setAnonymousSaving(false);
    }
  }

  async function handleDeleteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteAccount({ password: deletePassword });
      setUser(null);
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="screen">
      <BottomNav />
      <div className="screen__content">
        <h1>Settings</h1>

        <section className="settings-section">
          <div className="field field--checkbox">
            <label htmlFor="settings-anonymous">
              <input
                id="settings-anonymous"
                name="isAnonymous"
                type="checkbox"
                checked={user?.isAnonymous ?? false}
                onChange={handleAnonymousChange}
                disabled={anonymousSaving}
              />
              Play anonymously
            </label>
          </div>
          <p>
            Hides your username on the leaderboard - you appear as "Player #{user?.id}" instead.
            Your rank and statistics keep being recorded either way, and you can turn this off again
            at any time.
          </p>
          {anonymousError && (
            <p className="error-message" role="alert">
              {anonymousError}
            </p>
          )}
        </section>

        {/* `ios/SPEC.md` 8.6, and 12's row 7 of "The list for `main`". Two
            things and no third: it *shows* the consent state, and it opens
            the shell's Consent screen.

            **It does not write consent, deliberately.** The write path is the
            shell calling `requestSettingsUpdate(backgroundTracking)` from
            that Consent screen's two call sites, which this page answers with
            `PATCH /api/settings` (8.2, shell/useShellSettingsUpdate.ts). A
            toggle here would be a second way into the same column, racing the
            native screen and racing iOS's own Always prompt, which the
            Consent screen shows *after* recording consent (6.2, 10.1) - a box
            ticked here would record consent for a permission iOS had not been
            asked for yet.

            The state itself is `backgroundTrackingConsentedAt` on the account
            (5.4, `SPEC.md` 9.6), which is where the record lives rather than
            anywhere on this device. It is shown as on or off and not as a
            date: the column is Article 7 evidence held on the server, and the
            player's question here is whether it is on. */}
        {inShell && (
          <section className="settings-section">
            <h2>Background tracking</h2>
            <p>
              <strong>
                Right now: {user?.backgroundTrackingConsentedAt != null ? 'On' : 'Off'}
              </strong>
            </p>
            {user?.backgroundTrackingConsentedAt != null ? (
              <p>
                Tipsy Trails records your position while the app is closed, so a walk counts with
                the phone in your pocket. You can turn that off again on the next screen.
              </p>
            ) : (
              <p>
                Tipsy Trails records your position only while the app is open. Turning background
                tracking on lets a walk count with the phone in your pocket.
              </p>
            )}
            <button
              type="button"
              className="button button--secondary"
              onClick={postShellOpenConsent}
            >
              Background tracking settings
            </button>
          </section>
        )}

        <section className="settings-section">
          <Link className="button button--secondary" to="/change-password">
            Change password
          </Link>
        </section>

        <section className="settings-section">
          <Link className="button button--secondary" to="/privacy">
            Privacy
          </Link>
        </section>

        <section className="settings-section">
          <button type="button" className="button button--secondary" onClick={handleLogout}>
            Log out
          </button>
        </section>

        <section className="settings-section settings-section--danger">
          <h2>Delete account</h2>
          <p>
            This permanently deletes your account. It cannot be undone, and your leaderboard entries
            disappear along with it.
          </p>
          <form onSubmit={handleDeleteSubmit}>
            {deleteError && (
              <p className="error-message" role="alert">
                {deleteError}
              </p>
            )}
            <div className="field">
              <label htmlFor="settings-delete-password">Password</label>
              <input
                id="settings-delete-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                onChange={(event) => setDeletePassword(event.target.value)}
                required
              />
            </div>
            <button className="button button--secondary" type="submit" disabled={deleting}>
              Delete account
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
