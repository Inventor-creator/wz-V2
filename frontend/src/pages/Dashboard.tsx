import { useState, useEffect, type FC } from "react";
import { useNavigate } from "react-router-dom";
import { Sidebar } from "../components/Sidebar";
import { FinanceView } from "../components/FinanceView";
import { MemberListView } from "../components/MemberListView";
import { AnalyticsView } from "../components/AnalyticsView";
import { PlansAndTrainersView } from "../components/PlansAndTrainersView";
import { ExpenseLogView } from "../components/ExpenseLogView";
import { DayPassView } from "../components/DayPassView";
import { ThemeToggle } from "../components/ThemeToggle";
import { useActiveEntity } from "../contexts/ActiveEntityContext";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { MobileDashboard } from "../components/mobile/MobileDashboard";

export const Dashboard: FC = () => {
    const [view, setView] = useState("finances");
    const { activeEntityId } = useActiveEntity();
    const navigate = useNavigate();
    const isMobile = useMediaQuery("(max-width: 768px)");

    useEffect(() => {
        if (!activeEntityId) {
            navigate("/select");
        }
    }, [activeEntityId, navigate]);

    if (!activeEntityId) return null;

    if (isMobile) {
        return <MobileDashboard />;
    }

    return (
        <div className="flex min-h-screen">
            <Sidebar activeView={view} setView={setView} />
            <main className="flex-1 ml-sidebar flex flex-col">
                <header className="h-header border-b border-brand-border bg-brand-surface flex items-center px-8 justify-between sticky top-0 z-5">
                    <div className="font-medium capitalize">{view}</div>
                    <div className="flex items-center gap-4">
                        <ThemeToggle />
                        <button
                            onClick={() => navigate("/select")}
                            className="text-[12px] text-brand-accent hover:underline"
                        >
                            Switch
                        </button>
                    </div>
                </header>

                {view === "finances" && <FinanceView />}
                {view === "members" && <MemberListView gymId={activeEntityId} />}
                {view === "plans" && <PlansAndTrainersView />}
                {view === "expenses" && <ExpenseLogView />}
                {view === "analytics" && <AnalyticsView />}
                {view === "daypass" && <DayPassView />}
            </main>
        </div>
    );
};