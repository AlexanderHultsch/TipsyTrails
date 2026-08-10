import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, deleteAccount, updateSettings } from '../api/client.js';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { useLogout } from '../auth/useLogout.js';
import { BurgerMenu } from '../components/BurgerMenu.js';

export function Settings() {
  const { user, setUser } = useCurrentUser();
  const handleLogout = useLogout();

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
      setAnonymousError(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
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
      setDeleteError(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="screen">
      <BurgerMenu />
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

        <section className="settings-section">
          <Link className="button button--secondary" to="/change-password">
            Change password
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
