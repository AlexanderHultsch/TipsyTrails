import { Link } from 'react-router-dom';

export function Landing() {
  return (
    <main className="screen">
      <div className="screen__content screen__content--middle">
        <h1>Tipsy Trails</h1>
        <p>A location-based exploration game for Karlsruhe.</p>
      </div>
      <div className="screen__actions">
        <Link className="button button--primary" to="/login">
          Sign in
        </Link>
        <Link className="button button--secondary" to="/register">
          Register
        </Link>
      </div>
    </main>
  );
}
