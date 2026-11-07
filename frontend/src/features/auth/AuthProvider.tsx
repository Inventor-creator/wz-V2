import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { auth } from "../../lib/api";
import type { Role, User } from "../../types/domain";
import { canAccess } from "../../lib/permissions";
const Context = createContext<{
  user: User | null;
  loading: boolean;
  error: string;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}>({
  user: null,
  loading: true,
  error: "",
  login: async () => {},
  logout: async () => {},
});
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const client = useQueryClient();
  useEffect(() => {
    auth
      .getCurrentUser()
      .then(setUser)
      .catch(() =>
        setError("Session unavailable or unauthorized. Please sign in."),
      )
      .finally(() => setLoading(false));
    const expire = () => {
      setUser(null);
      client.clear();
      setError("Your session expired. Please sign in again.");
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, [client]);
  return (
    <Context.Provider
      value={{
        user,
        loading,
        error,
        login: async (email) => {
          const u = await auth.demoLogin(email);
          client.clear();
          setUser(u);
          setError("");
        },
        logout: async () => {
          await auth.logout();
          setUser(null);
          client.clear();
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useAuth = () => useContext(Context);
export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="empty" role="status">
        Loading your workspace…
      </div>
    );
  return user ? (
    <Outlet />
  ) : (
    <Navigate to="/login" state={{ from: location.pathname }} replace />
  );
}
export function RoleGuard() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  return user &&
    (canAccess(user.role, pathname) ||
      (pathname.startsWith("/members/") && user.role === "GYM_TRAINER")) ? (
    <Outlet />
  ) : (
    <Navigate to="/unauthorized" replace />
  );
}
export function PermissionGate({
  roles,
  children,
}: {
  roles: Role[];
  children: ReactNode;
}) {
  const { user } = useAuth();
  return user && roles.includes(user.role) ? children : null;
}
