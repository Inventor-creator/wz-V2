import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { api } from "../../lib/api";
import { dateLabel, money } from "../../lib/dates";
import {
  PageHeader,
  StatCard,
  DataTable,
  StatusBadge,
  Person,
  Modal,
  LoadingSkeleton,
  ErrorState,
  EmptyState,
} from "../../components/ui";

export function TrainerDashboard() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [detail, setDetail] = useState("");
  const canChoose = user?.role !== "GYM_TRAINER";
  const trainerId = canChoose ? params.get("trainer") || undefined : undefined;
  const search = params.get("q") || "";
  const planId = params.get("plan") || "";
  const status = params.get("status") || "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const filters = { trainerId, search, planId, status, page, pageSize: 8 };
  const options = useQuery({
    queryKey: ["trainer-options"],
    queryFn: api.trainerDashboard.options,
    enabled: canChoose,
  });
  const q = useQuery({
    queryKey: ["trainer-dashboard", filters],
    queryFn: () => api.trainerDashboard.get(filters),
    placeholderData: keepPreviousData,
  });
  const selected = q.data?.trainer?.id;
  const member = useQuery({
    queryKey: ["trainer-member", selected, detail],
    queryFn: () => api.trainerDashboard.member(detail, selected),
    enabled: !!detail && !!selected,
  });
  const set = (key: string, value: string) =>
    setParams((p) => {
      p.set(key, value);
      if (key !== "page") p.set("page", "1");
      if (key === "trainer") p.delete("plan");
      return p;
    });
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const data = q.data;
  const summary = data.summary;
  return (
    <>
      <PageHeader
        title="Trainer dashboard"
        description="Your members. Their progress. One place."
      >
        {canChoose && (
          <select
            aria-label="Choose trainer"
            value={trainerId || selected || ""}
            onChange={(e) => {
              set("trainer", e.target.value);
              setDetail("");
            }}
          >
            <option value="" disabled>
              Select a trainer
            </option>
            {options.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {!t.isActive ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        )}
      </PageHeader>
      {q.isFetching && (
        <p role="status" className="text-muted">
          Updating dashboard…
        </p>
      )}
      {options.error && (
        <ErrorState
          error={options.error}
          retry={() => void options.refetch()}
        />
      )}
      {!data.trainer ? (
        <EmptyState text="No trainer profiles yet. Create and link one from Access Management when granting trainer access." />
      ) : (
        <>
          <div className="metrics four">
            <StatCard
              main
              label="Total Assigned Members"
              value={summary.totalAssignedMembers}
            />
            <StatCard
              label="Active Training Members"
              value={summary.activeTrainingMembers}
            />
            <StatCard
              label="Total PT Plan Value"
              value={money(summary.planValue)}
              note="Non-cancelled subscription value, not collections"
            />
            <StatCard
              label="Estimated Trainer Payout"
              value={
                summary.estimatedPayout !== null
                  ? money(summary.estimatedPayout)
                  : summary.payoutStatus === "NOT_CONFIGURED"
                    ? "Not Configured"
                    : "Needs Review"
              }
              note="This month · unsettled collected PT fees"
            />
          </div>
          <div className="notice">
            <strong>
              Payout estimate · {dateLabel(summary.periodStart)} –{" "}
              {dateLabel(summary.periodEnd)}:{" "}
            </strong>
            {summary.payoutNote}
          </div>
          <div className="toolbar panel">
            <input
              aria-label="Search assigned members"
              placeholder="Search members…"
              maxLength={120}
              value={search}
              onChange={(e) => set("q", e.target.value)}
            />
            <select
              aria-label="PT plan filter"
              value={planId}
              onChange={(e) => set("plan", e.target.value)}
            >
              <option value="">All training plans</option>
              {data.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Training status filter"
              value={status}
              onChange={(e) => set("status", e.target.value)}
            >
              <option value="">All statuses</option>
              {["Active", "Expired", "Expiring Soon", "Upcoming"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <DataTable
            rows={data.rows}
            pageSize={data.pageSize}
            pagination={{
              page: data.page,
              total: data.total,
              onChange: (p) => set("page", String(p)),
            }}
            columns={[
              { label: "Sr No", render: (_, i) => i + 1 },
              {
                label: "Member name",
                render: (r) => (
                  <button
                    className="link-btn"
                    onClick={() => setDetail(r.memberId)}
                  >
                    <Person name={r.fullName} />
                  </button>
                ),
              },
              {
                label: "Contact",
                render: (r) => (
                  <>
                    {r.phone}
                    <small>{r.email}</small>
                  </>
                ),
              },
              { label: "PT plan", render: (r) => r.planName },
              { label: "Start date", render: (r) => dateLabel(r.startDate) },
              { label: "End date", render: (r) => dateLabel(r.endDate) },
              { label: "Days remaining ↑", render: (r) => r.daysRemaining },
              { label: "Plan cost", render: (r) => money(r.priceAtPurchase) },
              {
                label: "Status",
                render: (r) => <StatusBadge status={r.status} />,
              },
            ]}
          />
        </>
      )}
      {detail && (
        <Modal
          title={member.data?.member.fullName || "Training member"}
          onClose={() => setDetail("")}
        >
          <div className="modal-body">
            {member.isPending ? (
              <LoadingSkeleton />
            ) : member.error ? (
              <ErrorState
                error={member.error}
                retry={() => void member.refetch()}
              />
            ) : (
              member.data && (
                <>
                  <Person
                    name={member.data.member.fullName}
                    email={member.data.member.email}
                  />
                  <p>{member.data.member.phone}</p>
                  <p className="text-muted">
                    Only this trainer’s non-cancelled assignments are shown.
                  </p>
                  <DataTable
                    rows={member.data.trainingHistory}
                    columns={[
                      { label: "PT plan", render: (r) => r.planName },
                      {
                        label: "Start date",
                        render: (r) => dateLabel(r.startDate),
                      },
                      {
                        label: "End date",
                        render: (r) => dateLabel(r.endDate),
                      },
                      {
                        label: "Status",
                        render: (r) => <StatusBadge status={r.status} />,
                      },
                    ]}
                  />
                </>
              )
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
