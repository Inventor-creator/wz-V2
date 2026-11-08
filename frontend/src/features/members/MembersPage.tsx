import { useState } from "react";
import {
  Link,
  useSearchParams,
  useParams,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../lib/api";
import { money, dateLabel } from "../../lib/dates";
import {
  PageHeader,
  StatCard,
  DataTable,
  Person,
  StatusBadge,
  ConfirmDialog,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
import { MemberForm } from "./MemberForm";
import { useMemberRefresh } from "./useMemberRefresh";
import type { Member, MemberDeletion } from "../../types/domain";
import { ReasonDialog, SubscriptionDialog } from "../payments/SubscriptionDialog";
import { FinancialNotice } from "../payments/financialShared";

const deletionMessage = (mode: MemberDeletion["mode"]) =>
  mode === "DELETED"
    ? "Member deleted."
    : "Member removed from the directory. Subscription and financial history are retained.";
function DeleteMemberDialog({
  member,
  onClose,
  onDeleted,
}: {
  member: Member;
  onClose: () => void;
  onDeleted: (result: MemberDeletion) => void;
}) {
  const refresh = useMemberRefresh();
  const remove = useMutation({
    mutationFn: () => api.members.delete(member.id),
    onSuccess: async (result) => {
      await refresh();
      onDeleted(result);
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Delete member?"
      description={`Remove ${member.fullName} from the member directory? Unused profiles are permanently deleted. Profiles with subscriptions or invoices are retained as inactive records. Existing dates, prices, invoices, payments and trainer payouts are not deleted.`}
      onClose={onClose}
      pending={remove.isPending}
      error={remove.error}
      onConfirm={() => remove.mutate()}
      confirmLabel="Delete member"
      danger
    />
  );
}

export function MembersPage() {
  const q = useQuery({ queryKey: ["members"], queryFn: api.members.list });
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [notice, setNotice] = useState(() => {
    const mode = (
      location.state as { memberDeletion?: MemberDeletion["mode"] } | null
    )?.memberDeletion;
    return mode ? deletionMessage(mode) : "";
  });
  const [edit, setEdit] = useState<Member | null | undefined>();
  const [deleting, setDeleting] = useState<Member | null>(null);
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const { members, summary } = q.data;
  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true },
    );
  const rows = members
    .filter(
      (m) =>
        `${m.fullName} ${m.email} ${m.phone} ${m.memberNumber ?? ""}`
          .toLowerCase()
          .includes((params.get("q") ?? "").trim().toLowerCase()) &&
        (!params.get("status") ||
          m.membershipStatus === params.get("status")) &&
        (!params.get("trainer") || m.pt?.trainerId === params.get("trainer")) &&
        (!params.get("plan") || m.gym?.planId === params.get("plan")),
    )
    .sort((a, b) =>
      params.get("sort") === "trainer"
        ? (a.pt?.trainerName ?? "").localeCompare(b.pt?.trainerName ?? "")
        : params.get("sort") === "plan"
          ? (a.gym?.planName ?? "").localeCompare(b.gym?.planName ?? "")
          : (a.gym?.daysRemaining ?? Infinity) -
              (b.gym?.daysRemaining ?? Infinity) ||
            a.fullName.localeCompare(b.fullName),
    );
  const trainers = Array.from(
    new Map(
      members.flatMap((m) =>
        m.pt?.trainerId
          ? [[m.pt.trainerId, m.pt.trainerName ?? "Trainer"] as const]
          : [],
      ),
    ).entries(),
  );
  const plans = Array.from(
    new Map(
      members.flatMap((m) =>
        m.gym ? [[m.gym.planId, m.gym.planName] as const] : [],
      ),
    ).entries(),
  );
  return (
    <>
      <PageHeader
        title="Members"
        description="Member profiles, subscriptions and recorded balances."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Plus size={16} />
          Add Member
        </button>
      </PageHeader>
      {q.error && <ErrorState error={q.error} retry={() => void q.refetch()} />}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <div className="metrics four">
        <StatCard
          main
          label="Active Members"
          value={summary.activeMembers}
          note="Gym subscriptions covering today"
        />
        <StatCard
          label="Expiring Soon"
          value={summary.expiringSoon}
          note="Within the next 7 days, inclusively"
        />
        <StatCard
          label="Expired Memberships"
          value={summary.expiredMemberships}
        />
        <StatCard
          label="Outstanding Fees"
          value={money(summary.outstandingAmount)}
          note="Issued invoices less completed allocations"
        />
      </div>
      <div className="toolbar panel members-toolbar">
        <input
          aria-label="Search members"
          placeholder="Search name, contact or member number…"
          value={params.get("q") ?? ""}
          onChange={(e) => set("q", e.target.value)}
        />
        <select
          aria-label="Membership status"
          value={params.get("status") ?? ""}
          onChange={(e) => set("status", e.target.value)}
        >
          <option value="">All statuses</option>
          {[
            "Active",
            "Expiring Soon",
            "Expired",
            "Upcoming",
            "No plan",
            "Archived",
          ].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="Filter trainer"
          value={params.get("trainer") ?? ""}
          onChange={(e) => set("trainer", e.target.value)}
        >
          <option value="">All trainers</option>
          {trainers.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter plan"
          value={params.get("plan") ?? ""}
          onChange={(e) => set("plan", e.target.value)}
        >
          <option value="">All plans</option>
          {plans.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort members"
          value={params.get("sort") ?? "days"}
          onChange={(e) => set("sort", e.target.value)}
        >
          <option value="days">Days remaining ↑</option>
          <option value="trainer">Trainer</option>
          <option value="plan">Membership plan</option>
        </select>
      </div>
      <div className="members-directory-table">
        <DataTable
          rows={rows}
          columns={[
            {
              label: "Member",
              render: (m) => (
                <Link to={"/members/" + m.id}>
                  <Person name={m.fullName} email={m.email} />
                </Link>
              ),
            },
            { label: "Joined", render: (m) => dateLabel(m.joiningDate) },
            {
              label: "Days remaining",
              render: (m) => (
                <>
                  <strong>{m.gym?.daysRemaining ?? "—"}</strong>
                  <small>
                    <StatusBadge status={m.membershipStatus} />
                  </small>
                </>
              ),
            },
            { label: "Gym plan", render: (m) => m.gym?.planName ?? "No plan" },
            {
              label: "Trainer / PT plan",
              render: (m) => (
                <>
                  {m.pt?.trainerName ?? "No trainer"}
                  <small>{m.pt?.planName ?? ""}</small>
                </>
              ),
            },
            { label: "Outstanding", render: (m) => money(m.outstandingAmount) },
            {
              label: "Actions",
              render: (m) => (
                <div className="row-actions">
                  <Link to={"/members/" + m.id}>View</Link>
                  <button onClick={() => setEdit(m)}>Edit</button>
                  <button onClick={() => setDeleting(m)}>Delete</button>
                </div>
              ),
            },
          ]}
        />
      </div>
      {edit !== undefined && (
        <MemberForm
          member={edit ?? undefined}
          onClose={() => setEdit(undefined)}
          onSaved={() =>
            setNotice(
              "Member saved. Subscription and financial history are preserved.",
            )
          }
        />
      )}
      {deleting && (
        <DeleteMemberDialog
          member={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(result) => setNotice(deletionMessage(result.mode))}
        />
      )}
    </>
  );
}

export function MemberDetails() {
  const { memberId = "" } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["member-details", memberId],
    queryFn: () => api.members.get(memberId),
    enabled: !!memberId,
  });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [cancelling, setCancelling] = useState<{ id: string; kind: string } | null>(null);
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const { member, subscriptions, invoices, payments } = q.data;
  return (
    <>
      <PageHeader
        title={member.fullName}
        description="Member profile, original subscription terms and recorded financial history"
      >
        <Link className="btn" to="/members">
          Back to members
        </Link>
        <button className="btn" onClick={() => setEditing(true)}>
          Edit member
        </button>
        <button className="btn danger" onClick={() => setDeleting(true)}>
          Delete member
        </button>
        <button className="btn primary" onClick={() => setRenewing(true)}>
          New membership / renewal
        </button>
        <Link className="btn" to={`/fees-due?memberId=${memberId}`}>
          Fees and payments
        </Link>
      </PageHeader>
      <FinancialNotice />
      {q.error && <ErrorState error={q.error} retry={() => void q.refetch()} />}
      <div className="panel detail-profile">
        <div className="detail-grid">
          <div>
            <small>Member number</small>
            {member.memberNumber ?? member.id}
          </div>
          <div>
            <small>Email</small>
            {member.email || "Not recorded"}
          </div>
          <div>
            <small>Phone</small>
            {member.phone || "Not recorded"}
          </div>
          <div>
            <small>Joined</small>
            {dateLabel(member.joiningDate)}
          </div>
          <div>
            <small>Profile status</small>
            <StatusBadge status={member.status} />
          </div>
          <div>
            <small>Notes</small>
            {member.notes || "No notes"}
          </div>
        </div>
      </div>
      <h2 className="section-title">
        Membership &amp; personal training history
      </h2>
      <DataTable
        rows={subscriptions}
        columns={[
          {
            label: "Plan",
            render: (s) => (
              <>
                {s.planName}
                <small>{s.trainerName ?? ""}</small>
              </>
            ),
          },
          {
            label: "Type",
            render: (s) =>
              s.type === "GYM" ? "Gym membership" : "Personal training",
          },
          { label: "Start", render: (s) => dateLabel(s.startDate) },
          { label: "End (inclusive)", render: (s) => dateLabel(s.endDate) },
          { label: "Purchase price", render: (s) => money(s.priceAtPurchase) },
          { label: "Status", render: (s) => <StatusBadge status={s.status} /> },
          { label: "Actions", render: (s) => s.status !== "Cancelled" && <button className="btn small" onClick={() => setCancelling({ id: s.id, kind: s.type })}>Cancel subscription</button> },
        ]}
      />
      <h2 className="section-title">Invoice history</h2>
      <DataTable
        rows={invoices}
        columns={[
          { label: "Invoice", render: (i) => i.invoiceNumber },
          { label: "Date", render: (i) => dateLabel(i.invoiceDate) },
          { label: "Invoice state", render: (i) => i.status },
          { label: "Amount", render: (i) => money(i.totalAmount) },
          { label: "Outstanding", render: (i) => money(i.outstandingAmount) },
          {
            label: "Payment state",
            render: (i) => <StatusBadge status={i.paymentStatus} />,
          },
        ]}
      />
      <h2 className="section-title">Payment history</h2>
      <DataTable
        rows={payments}
        columns={[
          { label: "Receipt / payment", render: (p) => p.id },
          {
            label: "Received",
            render: (p) =>
              p.receivedAt ? dateLabel(p.receivedAt) : "Not received",
          },
          { label: "Method", render: (p) => p.method },
          { label: "Status", render: (p) => <StatusBadge status={p.status} /> },
          { label: "Reference", render: (p) => p.reference || "—" },
          { label: "Amount", render: (p) => money(p.amount) },
        ]}
      />
      {editing && (
        <MemberForm member={member} onClose={() => setEditing(false)} />
      )}
      {renewing && <SubscriptionDialog memberId={memberId} onClose={() => setRenewing(false)} />}
      {cancelling && <ReasonDialog title="Cancel subscription" description="Cancellation preserves original charges, paid receipts and outstanding debts. Record any authorized fee waiver or refund separately in Fees Due." url={`/financial-subscriptions/${cancelling.id}/cancel`} extra={{ kind: cancelling.kind }} onClose={() => setCancelling(null)} />}
      {deleting && (
        <DeleteMemberDialog
          member={member}
          onClose={() => setDeleting(false)}
          onDeleted={(result) =>
            navigate("/members", {
              replace: true,
              state: { memberDeletion: result.mode },
            })
          }
        />
      )}
    </>
  );
}
