import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, changePassword } from '../api/client.js';
import { useCurrentUser } from '../auth/CurrentUserContext.js';

export function ChangePassword() {
  const navigate = useNavigate();
  const { user, setUser } = useCurrentUser();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      if (user) {
        setUser({ ...user, mustChangePassword: false });
      }
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="screen">
      <form className="form" onSubmit={handleSubmit}>
        <h1>Change password</h1>
        {user?.mustChangePassword && <p>You must set a new password before continuing.</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="change-current-password">Current password</label>
          <input
            id="change-current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="change-new-password">New password</label>
          <input
            id="change-new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
        </div>
        <div className="screen__actions">
          <button className="button button--primary" type="submit" disabled={submitting}>
            Change password
          </button>
        </div>
      </form>
    </main>
  );
}
