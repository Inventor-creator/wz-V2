import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../features/auth/AuthProvider";
import { MOCK_MODE } from "../lib/api";
import { landing } from "../lib/permissions";
import { Brand } from "../components/AppShell";
import { ErrorState } from "../components/ui";
export function LoginPage() {
  const { user, login, error } = useAuth();
  const [email, setEmail] = useState("admin@form.example");
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);
  const handleGoogleLogin = () => {
    const backendUrl = (
      import.meta.env.VITE_API_URL || "http://localhost:8080"
    ).replace(/\/+$/, "");
    window.location.href = `${backendUrl}/auth/login`;
  };

  if (user) return <Navigate to={landing(user.role)} replace />;
  return (
    <main className="auth">
      <section className="auth-story">
        <Brand />
        <div>
          <h1>
            Stronger
            <br />
            together.
          </h1>
          <p>
            Your members. Your team. Your business.
            <br />
            One space to keep it all moving.
          </p>
        </div>
        <small>WORKOUT ZONE · BUILT FOR PROGRESS</small>
      </section>
      <section className="auth-card-wrap">
        <div className="auth-card">
          <span className="label">YOUR WORKSPACE, CONNECTED</span>
          <h2>Welcome back.</h2>
          <p>
            Sign in with your authorized Google account to access Workout Zone.
          </p>
          <button className="btn primary" onClick={handleGoogleLogin}>
            <span className="google" aria-hidden="true">
              G
            </span>
            Continue with Google
          </button>
          <small>
            Only accounts approved by your administrator can access this
            workspace.
          </small>
          {error && <p role="status">{error}</p>}
          {MOCK_MODE && (
            <div className="demo-note">
              <b>Development-only simulation</b>
              <p>
                Not Google authentication. No real billing or payments. Use a
                seeded authorized email; roles are not selected at sign-in.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setPending(true);
                  login(email)
                    .catch((e) =>
                      setFailure(
                        e instanceof Error ? e.message : "Sign-in failed",
                      ),
                    )
                    .finally(() => setPending(false));
                }}
              >
                <label className="field">
                  Authorized demo email
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <button className="btn" disabled={pending}>
                  {pending ? "Opening…" : "Open demo workspace"}
                </button>
              </form>
              {failure && <ErrorState error={new Error(failure)} />}
            </div>
          )}
          <p>
            <Link to="/unauthorized">
              Having trouble accessing your account?
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
