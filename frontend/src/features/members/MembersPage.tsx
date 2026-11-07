import { useState } from "react";
import { Link, useSearchParams, useParams } from "react-router-dom";
import { Plus, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import {
  money,
  dateLabel,
  calculateDaysRemaining,
  getMembershipStatus,
} from "../../lib/dates";
import {
  useWorkspace,
  useAction,
  PageHeader,
  StatCard,
  DataTable,
  Person,
  StatusBadge,
  ConfirmDialog,
  LoadingSkeleton,
  ErrorState,
  EmptyState,
} from "../../components/ui";
import { MemberForm } from "./MemberForm";
import { BillingPreviewDialog } from "../billing/BillingPreviewDialog";
import type { Member } from "../../types/domain";
import { useAuth } from "../auth/AuthProvider";
export function MembersPage() {
  const q = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [edit, setEdit] = useState<Member | null | undefined>();
  const [archive, setArchive] = useState<Member | null>(null);
  const [billing, setBilling] = useState(false);
  const remove = useAction(
    (id: string) => api.members.archive(id),
    () => setArchive(null),
  );
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const db = q.data;
  const gym = (id: string) =>
    db.gymSubscriptions.filter((s) => s.memberId === id).at(-1);
  const pt = (id: string) =>
    db.trainingSubscriptions.filter((s) => s.memberId === id).at(-1);
  const status = (m: Member) =>
    m.status === "ARCHIVED"
      ? "Archived"
      : gym(m.id)
        ? getMembershipStatus(gym(m.id)!.endDate)
        : "No plan";
  const set = (k: string, v: string) =>
    setParams((p) => {
      p.set(k, v);
      return p;
    });
  const rows = db.members
    .filter(
      (m) =>
        (m.fullName + " " + m.email + " " + m.phone)
          .toLowerCase()
          .includes((params.get("q") || "").toLowerCase()) &&
        (!params.get("status") || status(m) === params.get("status")) &&
        (!params.get("trainer") ||
          pt(m.id)?.trainerId === params.get("trainer")) &&
        (!params.get("plan") || gym(m.id)?.planId === params.get("plan")),
    )
    .sort((a, b) => {
      if (params.get("sort") === "trainer")
        return (
          db.trainers.find((t) => t.id === pt(a.id)?.trainerId)?.name || ""
        ).localeCompare(
          db.trainers.find((t) => t.id === pt(b.id)?.trainerId)?.name || "",
        );
      if (params.get("sort") === "plan")
        return (
          db.membershipPlans.find((p) => p.id === gym(a.id)?.planId)?.name || ""
        ).localeCompare(
          db.membershipPlans.find((p) => p.id === gym(b.id)?.planId)?.name ||
            "",
        );
      return (
        calculateDaysRemaining(gym(a.id)?.endDate || "2099-01-01") -
        calculateDaysRemaining(gym(b.id)?.endDate || "2099-01-01")
      );
    });
  return (
    <>
      <PageHeader
        title="Members"
        description="A stronger community starts with every member."
      >
        <button className="btn" onClick={() => setBilling(true)}>
          <RefreshCw size={15} />
          Run Billing Cycle
        </button>
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Plus size={16} />
          Add Member
        </button>
      </PageHeader>
      <div className="metrics four">
        <StatCard
          main
          label="Active Members"
          value={
            db.members.filter(
              (m) => m.status === "ACTIVE" && status(m) !== "Expired",
            ).length
          }
        />
        <StatCard
          label="Expiring Soon"
          value={db.members.filter((m) => status(m) === "Expiring Soon").length}
          note="Within the next 7 days"
        />
        <StatCard
          label="Expired Memberships"
          value={db.members.filter((m) => status(m) === "Expired").length}
        />
        <StatCard
          label="Outstanding Fees"
          value={money(
            db.invoices.reduce((s, i) => s + i.outstandingAmount, 0),
          )}
          note="Uncollected invoice balances"
        />
      </div>
      <div className="toolbar panel">
        <input
          aria-label="Search members"
          placeholder="Search members…"
          value={params.get("q") || ""}
          onChange={(e) => set("q", e.target.value)}
        />
        <select
          aria-label="Membership status"
          value={params.get("status") || ""}
          onChange={(e) => set("status", e.target.value)}
        >
          <option value="">All statuses</option>
          {["Active", "Expiring Soon", "Expired", "Archived"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="Filter trainer"
          value={params.get("trainer") || ""}
          onChange={(e) => set("trainer", e.target.value)}
        >
          <option value="">All trainers</option>
          {db.trainers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter plan"
          value={params.get("plan") || ""}
          onChange={(e) => set("plan", e.target.value)}
        >
          <option value="">All plans</option>
          {db.membershipPlans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort members"
          value={params.get("sort") || "days"}
          onChange={(e) => set("sort", e.target.value)}
        >
          <option value="days">Days remaining ↑</option>
          <option value="trainer">Trainer</option>
          <option value="plan">Membership plan</option>
        </select>
      </div>
      <DataTable
        rows={rows}
        columns={[
          { label: "Sr No", render: (_, i) => i + 1 },
          {
            label: "Member name",
            render: (m) => (
              <Link to={"/members/" + m.id}>
                <Person name={m.fullName} email={m.email} />
              </Link>
            ),
          },
          { label: "Joining date", render: (m) => dateLabel(m.joiningDate) },
          {
            label: "Days remaining",
            render: (m) => (
              <>
                <strong>
                  {gym(m.id) ? calculateDaysRemaining(gym(m.id)!.endDate) : "—"}
                </strong>
                <small>
                  <StatusBadge status={status(m)} />
                </small>
              </>
            ),
          },
          {
            label: "Gym membership plan",
            render: (m) =>
              db.membershipPlans.find((p) => p.id === gym(m.id)?.planId)
                ?.name || "—",
          },
          {
            label: "Trainer and PT plan",
            render: (m) => (
              <>
                {db.trainers.find((t) => t.id === pt(m.id)?.trainerId)?.name ||
                  "No trainer"}
                <small>
                  {
                    db.personalTrainingPlans.find(
                      (p) => p.id === pt(m.id)?.planId,
                    )?.name
                  }
                </small>
              </>
            ),
          },
          {
            label: "Actions",
            render: (m) => (
              <div className="row-actions">
                <Link to={"/members/" + m.id}>View</Link>
                <button onClick={() => setEdit(m)}>Edit</button>
                <button
                  disabled={m.status === "ARCHIVED"}
                  onClick={() => setArchive(m)}
                >
                  Archive
                </button>
              </div>
            ),
          },
        ]}
      />
      {edit !== undefined && (
        <MemberForm
          db={db}
          member={edit || undefined}
          onClose={() => setEdit(undefined)}
        />
      )}
      {archive && (
        <ConfirmDialog
          title="Archive member?"
          description={`${archive.fullName} will be archived. Subscription, invoice and payment history will be retained.`}
          onClose={() => setArchive(null)}
          pending={remove.isPending}
          error={remove.error}
          onConfirm={() => remove.mutate(archive.id)}
        />
      )}
      {billing && <BillingPreviewDialog onClose={() => setBilling(false)} />}
    </>
  );
}
export function MemberDetails() {
  const { memberId } = useParams();
  const q = useWorkspace();
  const { user } = useAuth();
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data) return <ErrorState error={q.error} />;
  const db = q.data;
  const member = db.members.find((m) => m.id === memberId);
  if (!member)
    return (
      <EmptyState text="This member is unavailable or not assigned to your trainer account." />
    );
  const trainer = user?.role === "GYM_TRAINER";
  const subs = [
    ...(!trainer ? db.gymSubscriptions : []),
    ...db.trainingSubscriptions,
  ].filter((s) => s.memberId === member.id);
  return (
    <>
      <PageHeader
        title={member.fullName}
        description={
          trainer
            ? "Assigned personal training member"
            : "Member profile, subscriptions and payment history"
        }
      >
        <Link className="btn" to={trainer ? "/trainer" : "/members"}>
          Back to {trainer ? "dashboard" : "members"}
        </Link>
      </PageHeader>
      <div className="panel detail-profile">
        <Person name={member.fullName} email={member.email} />
        <div className="detail-grid">
          <div>
            <small>Phone</small>
            {member.phone}
          </div>
          <div>
            <small>Joined</small>
            {dateLabel(member.joiningDate)}
          </div>
          <div>
            <small>Status</small>
            <StatusBadge status={member.status} />
          </div>
          {!trainer && (
            <div>
              <small>Notes</small>
              {member.notes || "No notes"}
            </div>
          )}
        </div>
      </div>
      <h2 className="section-title">
        {trainer
          ? "Personal training history"
          : "Membership & personal training history"}
      </h2>
      <DataTable
        rows={subs}
        columns={[
          {
            label: "Plan",
            render: (s) =>
              [...db.membershipPlans, ...db.personalTrainingPlans].find(
                (p) => p.id === s.planId,
              )?.name || "Plan",
          },
          {
            label: "Type",
            render: (s) =>
              "trainerId" in s ? "Personal training" : "Gym membership",
          },
          { label: "Start date", render: (s) => dateLabel(s.startDate) },
          { label: "End date", render: (s) => dateLabel(s.endDate) },
          { label: "Purchase price", render: (s) => money(s.priceAtPurchase) },
          {
            label: "Status",
            render: (s) => (
              <StatusBadge status={getMembershipStatus(s.endDate)} />
            ),
          },
        ]}
      />
      {!trainer && (
        <>
          <h2 className="section-title">Invoice history</h2>
          <DataTable
            rows={db.invoices.filter((i) => i.memberId === member.id)}
            columns={[
              { label: "Invoice", render: (i) => i.id },
              { label: "Date", render: (i) => dateLabel(i.invoiceDate) },
              { label: "Amount invoiced", render: (i) => money(i.totalAmount) },
              {
                label: "Outstanding",
                render: (i) => money(i.outstandingAmount),
              },
              {
                label: "Status",
                render: (i) => <StatusBadge status={i.status} />,
              },
            ]}
          />
          <h2 className="section-title">Payment history / receipts</h2>
          <DataTable
            rows={db.payments.filter((p) => p.memberId === member.id)}
            columns={[
              { label: "Receipt", render: (p) => p.id },
              { label: "Date", render: (p) => dateLabel(p.paymentDate) },
              { label: "Method", render: (p) => p.method },
              {
                label: "Reference",
                render: (p) => p.transactionReference || "—",
              },
              { label: "Amount collected", render: (p) => money(p.amount) },
            ]}
          />
        </>
      )}
    </>
  );
}
