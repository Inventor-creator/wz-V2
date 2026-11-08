import { Routes, Route, Navigate, Link } from "react-router-dom";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AuthProvider,
  ProtectedRoute,
  RoleGuard,
  useAuth,
} from "./features/auth/AuthProvider";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ui";
import { LoginPage } from "./pages/LoginPage";
const MembersPage = lazy(() =>
  import("./features/members/MembersPage").then((m) => ({
    default: m.MembersPage,
  })),
);
const MemberDetails = lazy(() =>
  import("./features/members/MembersPage").then((m) => ({
    default: m.MemberDetails,
  })),
);
const PlansPage = lazy(() =>
  import("./features/plans/PlansPage").then((m) => ({ default: m.PlansPage })),
);
const TrainerPlansPage = lazy(() =>
  import("./features/plans/PlansPage").then((m) => ({
    default: m.TrainerPlansPage,
  })),
);
const TrainersPage = lazy(() =>
  import("./features/trainers/TrainersPage").then((m) => ({
    default: m.TrainersPage,
  })),
);
const TrainerDetails = lazy(() =>
  import("./features/trainers/TrainersPage").then((m) => ({
    default: m.TrainerDetails,
  })),
);
const TrainerDashboard = lazy(() =>
  import("./features/trainers/TrainerDashboard").then((m) => ({
    default: m.TrainerDashboard,
  })),
);
const FeesPage = lazy(() =>
  import("./features/payments/FeesPage").then((m) => ({ default: m.FeesPage })),
);
const FinancesPage = lazy(() =>
  import("./features/finances/FinancesPage").then((m) => ({
    default: m.FinancesPage,
  })),
);
const AccessPage = lazy(() =>
  import("./features/access/AccessPage").then((m) => ({
    default: m.AccessPage,
  })),
);
import { landing } from "./lib/permissions";
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
function Home() {
  const { user, loading } = useAuth();
  if (loading) return <div className="empty">Loading session…</div>;
  return <Navigate to={user ? landing(user.role) : "/login"} replace />;
}
function Unauthorized() {
  const { user } = useAuth();
  return (
    <main className="empty">
      <h1>Access not authorized</h1>
      <p>
        Your account does not have permission to open this page. Contact your
        Super Admin.
      </p>
      <Link className="btn primary" to={user ? landing(user.role) : "/login"}>
        {user ? "Back to workspace" : "Back to sign in"}
      </Link>
    </main>
  );
}
function LoginError() {
  return (
    <main className="empty">
      <h1>Unable to sign in</h1>
      <p>
        Google sign-in could not be completed, or this email is not authorized.
      </p>
      <Link className="btn primary" to="/login">
        Try again
      </Link>
    </main>
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/login/error" element={<LoginError />} />
            <Route path="/auth/callback" element={<Home />} />
            <Route path="/unauthorized" element={<Unauthorized />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/" element={<Home />} />
                <Route element={<RoleGuard />}>
                  <Route path="/members" element={<MembersPage />} />
                  <Route
                    path="/members/:memberId"
                    element={<MemberDetails />}
                  />
                  <Route path="/membership-plans" element={<PlansPage />} />
                  <Route
                    path="/personal-training-plans"
                    element={<TrainerPlansPage />}
                  />
                  <Route path="/trainers" element={<TrainersPage />} />
                  <Route
                    path="/trainers/:trainerId"
                    element={<TrainerDetails />}
                  />
                  <Route path="/trainer" element={<TrainerDashboard />} />
                  <Route path="/fees-due" element={<FeesPage />} />
                  <Route
                    path="/finances"
                    element={
                      <Suspense
                        fallback={
                          <div
                            className="skeleton line"
                            role="status"
                            aria-label="Loading finances"
                          />
                        }
                      >
                        <FinancesPage />
                      </Suspense>
                    }
                  />
                  <Route path="/access-management" element={<AccessPage />} />
                </Route>
              </Route>
            </Route>
            <Route
              path="*"
              element={
                <main className="empty">
                  <h1>Page not found</h1>
                  <Link className="btn" to="/">
                    Return to workspace
                  </Link>
                </main>
              }
            />
          </Routes>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
