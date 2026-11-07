import { useState, Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Users,
  CreditCard,
  Dumbbell,
  Receipt,
  ChartNoAxesCombined,
  ShieldCheck,
  LayoutDashboard,
  Menu,
  LogOut,
  MapPin,
} from "lucide-react";
import { navigation, roleLabel } from "../lib/permissions";
import { MOCK_MODE } from "../lib/api";
import { useAuth } from "../features/auth/AuthProvider";
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>
        WORKOUT<small>ZONE</small>
      </span>
    </div>
  );
}
const icons = {
  members: Users,
  plans: CreditCard,
  trainers: Dumbbell,
  fees: Receipt,
  finances: ChartNoAxesCombined,
  access: ShieldCheck,
  dashboard: LayoutDashboard,
};
export function AppShell() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  if (!user) return null;
  return (
    <div className={"app" + (open ? " nav-open" : "")}>
      <button
        className="nav-shade"
        aria-label="Close navigation"
        onClick={() => setOpen(false)}
      />
      <aside className="sidebar">
        <Brand />
        <div className="club">
          <span className="club-icon">
            <MapPin size={18} />
          </span>
          <div>
            <strong>Workout Zone Studio</strong>
            <small>Pune, Maharashtra</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="nav" aria-label="Main navigation">
          {navigation
            .filter((n) => n.roles.includes(user.role))
            .map((n) => {
              const Icon = icons[n.icon as keyof typeof icons];
              return (
                <NavLink
                  key={n.path}
                  to={n.path}
                  className={({ isActive }) => (isActive ? "active" : "")}
                  onClick={() => setOpen(false)}
                >
                  <Icon size={18} />
                  {n.label}
                </NavLink>
              );
            })}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-note">
            <b>
              <span className="tiny-dot" />
              {MOCK_MODE ? "Development workspace" : "Connected workspace"}
            </b>
            {MOCK_MODE
              ? "Simulated authentication and financial records. Changes reset on reload."
              : "Permissions are issued by your backend."}
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-menu"
              aria-label="Open navigation"
              onClick={() => setOpen(true)}
            >
              <Menu size={18} />
            </button>
            <span>Workspace</span>
            <span>/</span>
            <span>
              {navigation.find((n) => location.pathname.startsWith(n.path))
                ?.label || "Member details"}
            </span>
          </div>
          <div className="top-actions">
            <div className="profile">
              <span className="avatar">
                {user.name
                  .split(" ")
                  .map((s) => s[0])
                  .join("")}
              </span>
              <span>
                <strong>{user.name}</strong>
                <small>{roleLabel(user.role)}</small>
              </span>
            </div>
            <button
              className="icon-btn"
              onClick={() => void logout()}
              aria-label="Log out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="content">
          <Suspense
            fallback={
              <div
                className="skeleton line"
                role="status"
                aria-label="Loading page"
              />
            }
          >
            <Outlet />
          </Suspense>
          <footer className="footer">
            <span>© {new Date().getFullYear()} Workout Zone</span>
            <span>
              {MOCK_MODE
                ? "Development only · No real payments processed"
                : "All amounts in INR"}{" "}
              · Asia/Kolkata
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
