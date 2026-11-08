import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { financialApi } from "../../lib/financialApi";
import type { FinancialFilters } from "../../types/financial";
import { dateLabel } from "../../lib/dates";
import { useAuth } from "../auth/AuthProvider";
import {
  PageHeader,
  StatCard,
  DataTable,
  StatusBadge,
  Modal,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
import {
  FinancialNotice,
  MoneyCommandDialog,
  SortSelect,
} from "./financialShared";
import { inr, paise } from "../../lib/financial";
import { ReasonDialog, SubscriptionDialog } from "./SubscriptionDialog";

export function InvoiceDialog({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const owner = user?.role === "SUPER_ADMIN" || user?.role === "GYM_OWNER";
  const query = useQuery({
    queryKey: ["financial-invoice", id],
    queryFn: () => financialApi.invoice(id),
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const [action, setAction] = useState<{
    title: string;
    url: string;
    maximum: string;
    reason?: boolean;
    reversal?: boolean;
    noDate?: boolean;
  } | null>(null);
  const [reasonAction, setReasonAction] = useState<{
    title: string;
    description: string;
    url: string;
    extra?: Record<string, unknown>;
  } | null>(null);
  const bill = query.data?.invoice;
  return (
    <>
      <Modal title="Invoice and payment history" onClose={onClose}>
        <div className="modal-body">
          {query.isPending ? (
            <LoadingSkeleton />
          ) : query.error ? (
            <ErrorState
              error={query.error}
              retry={() => void query.refetch()}
            />
          ) : (
            bill && (
              <>
                <h3>
                  {bill.memberName} · {bill.memberNumber}
                </h3>
                <p>
                  {bill.invoiceNumber} · Due {dateLabel(bill.dueDate)} ·{" "}
                  {bill.archived
                    ? "Archived member — financial history retained"
                    : "Member account"}
                </p>
                <p>
                  Total {inr(bill.total)} · Net paid {inr(bill.paid)} ·
                  Outstanding <strong>{inr(bill.balance)}</strong>
                </p>
                <div className="actions">
                  {bill.status === "issued" &&
                    !bill.reconciliationRequired &&
                    paise(bill.balance) > 0n && (
                      <>
                        <button
                          className="btn primary"
                          onClick={() =>
                            setAction({
                              title: "Record payment",
                              url: `/fees-due/${id}/payments`,
                              maximum: bill.balance,
                            })
                          }
                        >
                          Record payment
                        </button>
                        {owner && (
                          <button
                            className="btn"
                            onClick={() =>
                              setAction({
                                title: "Adjust unpaid fees",
                                url: `/fees-due/${id}/adjustments`,
                                maximum: bill.balance,
                                reason: true,
                                noDate: true,
                              })
                            }
                          >
                            Adjust unpaid fees
                          </button>
                        )}
                      </>
                    )}
                  {bill.archived && (
                    <button
                      className="btn"
                      onClick={() =>
                        setReasonAction({
                          title: "Restore member",
                          description:
                            "Restore this archived profile without changing any subscriptions or financial records.",
                          url: `/financial-members/${bill.memberId}/restore`,
                        })
                      }
                    >
                      Restore member
                    </button>
                  )}
                </div>
                {bill.reconciliationRequired && (
                  <p className="notice" role="alert">
                    Legacy receipts are not fully allocated. Collection and fee
                    adjustments are blocked until the original receipt
                    allocations are reconciled.
                  </p>
                )}
                <h3>Obligation details</h3>
                <DataTable
                  rows={bill.lines}
                  columns={[
                    { label: "Plan / charge", render: (l) => l.description },
                    {
                      label: "Service dates",
                      render: (l) =>
                        `${dateLabel(l.startDate || "")} – ${dateLabel(l.endDate || "")}`,
                    },
                    { label: "Net charge", render: (l) => inr(l.amount) },
                    {
                      label: "Original charge",
                      render: (l) => inr(l.originalAmount || l.amount),
                    },
                    {
                      label: "Membership status",
                      render: (l) => l.membershipStatus || "—",
                    },
                    {
                      label: "Actions",
                      render: (l) =>
                        l.subscriptionId &&
                        l.membershipStatus !== "Cancelled" && (
                          <button
                            className="btn small"
                            onClick={() =>
                              setReasonAction({
                                title: "Cancel subscription",
                                description:
                                  "Cancellation stops the membership but preserves all charges and payments. Any unpaid waiver or refund must be recorded separately.",
                                url: `/financial-subscriptions/${l.subscriptionId}/cancel`,
                                extra: { kind: l.kind },
                              })
                            }
                          >
                            Cancel subscription
                          </button>
                        ),
                    },
                  ]}
                />
                {!!bill.adjustments?.length && (
                  <>
                    <h3>Fee adjustment history</h3>
                    {bill.adjustments.map((a) => (
                      <p key={a.id}>
                        {inr(a.amount)} waived · {a.reason} ·{" "}
                        {a.createdBy || "Legacy / unknown"} ·{" "}
                        {dateLabel(a.createdAt)} · {a.operationId}
                      </p>
                    ))}
                  </>
                )}
                <h3>Payment history</h3>
                {query.data?.payments.map((p) => (
                  <section className="financial-history" key={p.id}>
                    <strong>
                      {inr(p.amount)} · {p.method} · {dateLabel(p.date || "")}
                    </strong>
                    <p>
                      Transaction {p.id} · {p.status} · Recorded by{" "}
                      {p.createdBy || "Legacy / unknown"}
                      {p.createdAt &&
                        ` · Recorded ${new Date(p.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`}
                    </p>
                    <p>
                      Reference: {p.reference || "—"} · Notes: {p.notes || "—"}
                    </p>
                    {p.refunds.map((r) => (
                      <p key={r.id}>
                        {r.kind}: {inr(r.amount)} · {dateLabel(r.date)} ·{" "}
                        {r.reason} · {r.createdBy || "Legacy / unknown"} ·{" "}
                        {r.id}
                        {r.createdAt &&
                          ` · Recorded ${new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`}
                      </p>
                    ))}
                    {p.status === "completed" && paise(p.refundable) > 0n && (
                      <div className="actions">
                        <button
                          className="btn small"
                          onClick={() =>
                            setAction({
                              title: "Refund payment",
                              url: `/financial-payments/${p.id}/refunds`,
                              maximum: p.refundable,
                              reason: true,
                            })
                          }
                        >
                          Refund
                        </button>
                        <button
                          className="btn small danger"
                          onClick={() =>
                            setAction({
                              title: "Reverse payment",
                              url: `/financial-payments/${p.id}/refunds`,
                              maximum: p.refundable,
                              reason: true,
                              reversal: true,
                            })
                          }
                        >
                          Reverse remaining receipt
                        </button>
                      </div>
                    )}
                  </section>
                ))}
                {!query.data?.payments.length && <p>No payments recorded.</p>}
              </>
            )
          )}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
      {action && (
        <MoneyCommandDialog {...action} onClose={() => setAction(null)} />
      )}
      {reasonAction && (
        <ReasonDialog {...reasonAction} onClose={() => setReasonAction(null)} />
      )}
    </>
  );
}

export function FeesPage() {
  const { user } = useAuth();
  const owner = user?.role === "SUPER_ADMIN" || user?.role === "GYM_OWNER";
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<FinancialFilters>({
    search: "",
    status: "",
    memberId: params.get("memberId") || "",
    page: 1,
    pageSize: 20,
    sort: "dueDate",
    direction: "asc",
  });
  const [invoice, setInvoice] = useState<string | null>(null);
  const [purchase, setPurchase] = useState(false);
  const [archived, setArchived] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState("");
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [unbilled, setUnbilled] = useState(false);
  const [legacy, setLegacy] = useState<{ id: string; kind: string } | null>(
    null,
  );
  const update = (key: string, value: string) =>
    setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  const query = useQuery({
    queryKey: ["fees-due", filters],
    queryFn: () => financialApi.fees(filters),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const summary = query.data?.summary;
  return (
    <>
      <PageHeader
        title="Fees Due"
        description="Actual invoice balances, receipts and retained member debts."
      >
        {owner && (
          <button className="btn" onClick={() => setUnbilled(true)}>
            Review unbilled purchases
          </button>
        )}
        <button className="btn" onClick={() => setArchived(true)}>
          Archived members
        </button>
        <button className="btn primary" onClick={() => setPurchase(true)}>
          New membership / renewal
        </button>
      </PageHeader>
      <FinancialNotice />
      {summary && (
        <div className="metrics">
          <StatCard
            label="Outstanding fees"
            value={inr(summary.outstanding)}
            note={`${summary.members} members with balances`}
          />
          <StatCard
            label="Overdue fees"
            value={inr(summary.overdue)}
            note="Due before today, Asia/Kolkata"
          />
          <StatCard
            label="Collected this month"
            value={inr(summary.collectedThisMonth)}
            note="Receipts minus refunds this calendar month"
          />
          <StatCard
            label="Payment obligations"
            value={`${summary.partial} partial · ${summary.paid} paid`}
            note={`${summary.upcoming} upcoming obligations`}
          />
        </div>
      )}
      <div className="toolbar">
        <input
          aria-label="Search fees"
          placeholder="Search member, ID or plan"
          value={filters.search}
          onChange={(e) => update("search", e.target.value)}
        />
        <input
          aria-label="Member ID filter"
          placeholder="Filter by member UUID"
          value={filters.memberId}
          onChange={(e) => update("memberId", e.target.value)}
        />
        <select
          aria-label="Payment status"
          value={filters.status}
          onChange={(e) => update("status", e.target.value)}
        >
          <option value="">All payments</option>
          {["PAID", "UNPAID", "PARTIAL", "OVERDUE", "UPCOMING"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <SortSelect
          value={filters}
          update={update}
          options={[
            "dueDate",
            "memberName",
            "total",
            "paid",
            "balance",
            "lastPaymentDate",
          ]}
        />
      </div>
      {query.isPending ? (
        <LoadingSkeleton />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        query.data && (
          <>
            <DataTable
              rows={query.data.rows}
              columns={[
                {
                  label: "Member",
                  render: (r) => (
                    <>
                      <strong>{r.memberName}</strong>
                      <small>
                        {r.memberNumber}
                        {r.reconciliationRequired
                          ? " · Reconciliation required"
                          : ""}
                        {r.archived ? " · Archived" : ""}
                      </small>
                    </>
                  ),
                },
                {
                  label: "Membership plan",
                  render: (r) => r.lines.map((l) => l.description).join(", "),
                },
                {
                  label: "Membership status",
                  render: (r) =>
                    r.lines.map((l) => l.membershipStatus || "—").join(", "),
                },
                { label: "Total payable", render: (r) => inr(r.total) },
                { label: "Net paid", render: (r) => inr(r.paid) },
                { label: "Remaining", render: (r) => inr(r.balance) },
                { label: "Due date", render: (r) => dateLabel(r.dueDate) },
                {
                  label: "Payment status",
                  render: (r) => (
                    <>
                      <StatusBadge status={r.paymentStatus || r.status} />
                      {r.overdue && <StatusBadge status="Overdue" />}
                      {r.upcoming && <StatusBadge status="Upcoming" />}
                    </>
                  ),
                },
                {
                  label: "Last payment",
                  render: (r) => dateLabel(r.lastPaymentDate || ""),
                },
                {
                  label: "Actions",
                  render: (r) => (
                    <button
                      className="btn small"
                      onClick={() => setInvoice(r.id)}
                    >
                      View / collect
                    </button>
                  ),
                },
              ]}
              pageSize={query.data.pageSize}
              pagination={{
                page: query.data.page,
                total: query.data.total,
                onChange: (page) => setFilters((f) => ({ ...f, page })),
              }}
            />
          </>
        )
      )}
      <p className="notice">
        Payment status is independent of membership expiry. Archived and expired
        members retain their debts. Existing purchases predating migration 009
        require reviewed billing reconciliation; they are not silently charged.
      </p>
      {invoice && (
        <InvoiceDialog id={invoice} onClose={() => setInvoice(null)} />
      )}
      {purchase && <SubscriptionDialog onClose={() => setPurchase(false)} />}
      {archived && (
        <Modal title="Archived members" onClose={() => setArchived(false)}>
          <div className="modal-body">
            <p>
              Restoration retains original subscriptions, invoice balances and
              financial history.
            </p>
            <input
              aria-label="Search archived members"
              placeholder="Search archived members"
              value={archiveSearch}
              onChange={(e) => setArchiveSearch(e.target.value)}
            />
            <DataTable
              rows={(query.data?.archivedMembers || []).filter((m) =>
                `${m.name} ${m.memberNumber}`
                  .toLowerCase()
                  .includes(archiveSearch.toLowerCase()),
              )}
              columns={[
                {
                  label: "Member",
                  render: (m) => `${m.name} · ${m.memberNumber}`,
                },
                {
                  label: "Actions",
                  render: (m) => (
                    <button
                      className="btn small"
                      onClick={() => {
                        setArchived(false);
                        setRestoreId(m.id);
                      }}
                    >
                      Restore member
                    </button>
                  ),
                },
              ]}
            />
          </div>
        </Modal>
      )}
      {restoreId && (
        <ReasonDialog
          title="Restore member"
          description="Reactivate this profile without changing historical debts, subscriptions or payments."
          url={`/financial-members/${restoreId}/restore`}
          onClose={() => setRestoreId(null)}
        />
      )}
      {unbilled && (
        <Modal
          title="Review unbilled purchases"
          onClose={() => setUnbilled(false)}
        >
          <div className="modal-body">
            <p className="notice">
              These historical purchases have no linked invoice. Verify external
              records, discounts and cancellations before billing. Approval
              issues the original purchase price, not today's catalogue price.
              Nothing is charged automatically.
            </p>
            <DataTable
              rows={query.data?.unbilled || []}
              columns={[
                {
                  label: "Member / plan",
                  render: (r) => `${r.memberName} · ${r.planName}`,
                },
                {
                  label: "Status / dates",
                  render: (r) =>
                    `${r.status} · ${dateLabel(r.startDate)} – ${dateLabel(r.endDate)}`,
                },
                { label: "Purchase price", render: (r) => inr(r.amount) },
                {
                  label: "Actions",
                  render: (r) => (
                    <button
                      className="btn small"
                      onClick={() => {
                        setUnbilled(false);
                        setLegacy({ id: r.id, kind: r.kind });
                      }}
                    >
                      Review and issue charge
                    </button>
                  ),
                },
              ]}
            />
          </div>
        </Modal>
      )}
      {legacy && (
        <ReasonDialog
          title="Issue historical charge"
          description="Confirm that this original purchase remains billable and was not settled outside this ledger. This creates an invoice and debt, never a receipt. Duplicate linked charges are blocked."
          url={`/financial-subscriptions/${legacy.id}/bill`}
          extra={{ kind: legacy.kind }}
          onClose={() => setLegacy(null)}
        />
      )}
    </>
  );
}
