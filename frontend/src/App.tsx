import { Routes, Route, Navigate } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { LoginPage } from "./pages/LoginPage";
import { LoginError } from "./pages/LoginError";
import { SelectGym } from "./pages/SelectGym";
import { AdminDashboard } from "./pages/AdminDashboard";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ActiveEntityProvider } from "./contexts/ActiveEntityContext";

function App() {
    return (
        <ActiveEntityProvider>
            <Routes>
                <Route
                    path="/"
                    element={<Navigate to="/select" replace />}
                />
                <Route
                    path="/dashboard"
                    element={
                        <ProtectedRoute>
                            <Dashboard />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/select"
                    element={
                        <ProtectedRoute>
                            <SelectGym />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/admin"
                    element={
                        <ProtectedRoute>
                            <AdminDashboard />
                        </ProtectedRoute>
                    }
                />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/login/error" element={<LoginError />} />
            </Routes>
        </ActiveEntityProvider>
    );
}

export default App;
