import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage, login } from '../api/client.js';
import { useCurrentUser } from '../auth/CurrentUserContext.js';

export function Login() {
  const navigate = useNavigate();
  const { setUser } = useCurrentUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login({ username, password });
      setUser(user);
      navigate(user.mustChangePassword ? '/change-password' : '/app', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="screen">
      <form className="form" onSubmit={handleSubmit}>
        <h1>Sign in</h1>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <p className="screen__footnote">
          <Link to="/reset">Forgot password?</Link>
        </p>
        <div className="screen__actions">
          <button className="button button--primary" type="submit" disabled={submitting}>
            Sign in
          </button>
        </div>
        <p className="screen__footnote">
          New here? <Link to="/register">Register</Link>
        </p>
      </form>
    </main>
  );
}
