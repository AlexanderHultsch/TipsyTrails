import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, getResetQuestion, resetPassword } from '../api/client.js';

type Step = 'username' | 'answer';

export function Reset() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('username');
  const [username, setUsername] = useState('');
  const [question, setQuestion] = useState('');
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleUsernameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await getResetQuestion(username);
      setQuestion(result.question);
      setStep('answer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAnswerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword({ username, securityAnswer, newPassword });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="screen">
        <div className="screen__content screen__content--middle">
          <h1>Password reset</h1>
          <p>Your password has been changed. You can now sign in.</p>
        </div>
        <div className="screen__actions">
          <button
            className="button button--primary"
            type="button"
            onClick={() => navigate('/login')}
          >
            Go to sign in
          </button>
        </div>
      </main>
    );
  }

  if (step === 'username') {
    return (
      <main className="screen">
        <form className="form" onSubmit={handleUsernameSubmit}>
          <h1>Reset password</h1>
          <p>Enter your username to continue.</p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="field">
            <label htmlFor="reset-username">Username</label>
            <input
              id="reset-username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="screen__actions">
            <button className="button button--primary" type="submit" disabled={submitting}>
              Continue
            </button>
          </div>
          <p className="screen__footnote">
            <Link to="/login">Back to sign in</Link>
          </p>
        </form>
      </main>
    );
  }

  return (
    <main className="screen">
      <form className="form" onSubmit={handleAnswerSubmit}>
        <h1>Reset password</h1>
        <p>{question}</p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="reset-security-answer">Answer</label>
          <input
            id="reset-security-answer"
            name="securityAnswer"
            value={securityAnswer}
            onChange={(event) => setSecurityAnswer(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="reset-new-password">New password</label>
          <input
            id="reset-new-password"
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
            Reset password
          </button>
        </div>
      </form>
    </main>
  );
}
