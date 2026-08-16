import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, register } from '../api/client.js';
import { useCurrentUser } from '../auth/CurrentUserContext.js';

export function Register() {
  const navigate = useNavigate();
  const { setUser } = useCurrentUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [securityQuestion, setSecurityQuestion] = useState('');
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ageConfirmed) {
      setError('Please confirm you are 18 years of age or older.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const user = await register({
        username,
        password,
        securityQuestion,
        securityAnswer,
        ageConfirmed,
      });
      setUser(user);
      navigate(user.mustChangePassword ? '/change-password' : '/app', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="screen">
      <form className="form" onSubmit={handleSubmit}>
        <h1>Register</h1>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="register-username">Username</label>
          <input
            id="register-username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="register-security-question">Security question</label>
          <input
            id="register-security-question"
            name="securityQuestion"
            value={securityQuestion}
            onChange={(event) => setSecurityQuestion(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="register-security-answer">Security answer</label>
          <input
            id="register-security-answer"
            name="securityAnswer"
            value={securityAnswer}
            onChange={(event) => setSecurityAnswer(event.target.value)}
            required
          />
        </div>
        <div className="field field--checkbox">
          <label htmlFor="register-age-confirmed">
            <input
              id="register-age-confirmed"
              name="ageConfirmed"
              type="checkbox"
              checked={ageConfirmed}
              onChange={(event) => setAgeConfirmed(event.target.checked)}
              required
            />
            I confirm that I am 18 years of age or older.
          </label>
        </div>
        <p className="screen__footnote">
          <Link to="/privacy">See what Tipsy Trails stores about you</Link>
        </p>
        <div className="screen__actions">
          <button className="button button--primary" type="submit" disabled={submitting}>
            Create account
          </button>
        </div>
        <p className="screen__footnote">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
