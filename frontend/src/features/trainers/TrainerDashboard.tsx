import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import {
  calculateDaysRemaining,
  dateLabel,
  getMembershipStatus,
  money,
} from "../../lib/dates";
import {
  useWorkspace,
  PageHeader,
  StatCard,
  DataTable,
  StatusBadge,
  Person,
  Modal,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
export function TrainerDashboard() {
  const q = useWorkspace();
  const { user } = useAuth();
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("");
  const [detail, setDetail] = useState("");
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data) return <ErrorState error={q.error} />;
  const db = q.data;
  const trainerId =
    user?.role === "GYM_TRAINER"
      ? user.trainerId
      : selected || db.trainers[0]?.id;
  const all = db.trainingSubscriptions.filter(
    (s) => s.trainerId === trainerId && s.status === "ACTIVE",
  );
  const member = (id: string) => db.members.find((m) => m.id === id);
  const rows = all
    .filter(
      (s) =>
        member(s.memberId)
          ?.fullName.toLowerCase()
          .includes(search.toLowerCase()) &&
        (!plan || s.planId === plan) &&
        (!status || getMembershipStatus(s.endDate) === status),
    )
    .sort(
      (a, b) =>
        calculateDaysRemaining(a.endDate) - calculateDaysRemaining(b.endDate),
    );
  const value = all.reduce((n, s) => n + s.priceAtPurchase, 0);
  const payout = db.payoutConfigurations.find((p) => p.trainerId === trainerId);
  const m = member(detail);
  return (
    <>
      <PageHeader
        title="Trainer dashboard"
        description="Your members. Their progress. One place."
      >
        {user?.role !== "GYM_TRAINER" && (
          <select
            aria-label="Choose trainer"
            value={trainerId}
            onChange={(e) => {
              setSelected(e.target.value);
              setPlan("");
            }}
          >
            {db.trainers.map((t) => (
              <option value={t.id} key={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </PageHeader>
      <div className="metrics four">
        <StatCard
          main
          label="Total Assigned Members"
          value={new Set(all.map((s) => s.memberId)).size}
        />
        <StatCard
          label="Active Training Members"
          value={
            new Set(
              all
                .filter((s) => calculateDaysRemaining(s.endDate) >= 0)
                .map((s) => s.memberId),
            ).size
          }
        />
        <StatCard
          label="Total PT Plan Value"
          value={money(value)}
          note="Recorded subscription value, not collections"
        />
        <StatCard
          label="Estimated Trainer Payout"
          value={
            payout
              ? money(
                  payout.payoutType === "COMMISSION"
                    ? (value * payout.commissionRate) / 100
                    : payout.fixedAmount,
                )
              : "Not Configured"
          }
          note="Estimate based on configured payout rules"
        />
      </div>
      <div className="toolbar panel">
        <input
          aria-label="Search assigned members"
          placeholder="Search members…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="PT plan filter"
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
        >
          <option value="">All training plans</option>
          {db.personalTrainingPlans
            .filter((p) => p.trainerId === trainerId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <select
          aria-label="Training status filter"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {["Active", "Expired", "Expiring Soon"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <DataTable
        rows={rows}
        columns={[
          { label: "Sr No", render: (_, i) => i + 1 },
          {
            label: "Member name",
            render: (s) => (
              <button
                className="link-btn"
                onClick={() => setDetail(s.memberId)}
              >
                <Person
                  name={member(s.memberId)?.fullName || "Archived member"}
                />
              </button>
            ),
          },
          { label: "Contact", render: (s) => member(s.memberId)?.phone },
          {
            label: "PT plan",
            render: (s) =>
              db.personalTrainingPlans.find((p) => p.id === s.planId)?.name,
          },
          { label: "Start date", render: (s) => dateLabel(s.startDate) },
          { label: "End date", render: (s) => dateLabel(s.endDate) },
          {
            label: "Days remaining ↑",
            render: (s) => calculateDaysRemaining(s.endDate),
          },
          { label: "Plan cost", render: (s) => money(s.priceAtPurchase) },
          {
            label: "Status",
            render: (s) => (
              <StatusBadge status={getMembershipStatus(s.endDate)} />
            ),
          },
        ]}
      />
      {m && (
        <Modal title={m.fullName} onClose={() => setDetail("")}>
          <div className="modal-body">
            <Person name={m.fullName} email={m.email} />
            <p>{m.phone}</p>
            <Link className="btn primary" to={"/members/" + m.id}>
              View training details
            </Link>
          </div>
        </Modal>
      )}
    </>
  );
}
