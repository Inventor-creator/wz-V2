import { useState } from "react";
import { keepPreviousData, useQuery, useMutation } from "@tanstack/react-query";
import { financialApi } from "../../lib/financialApi";
import type {
  Expense,
  FinancialFilters,
  Transaction,
} from "../../types/financial";
import { today, dateLabel } from "../../lib/dates";
import {
  PageHeader,
  StatCard,
  DataTable,
  StatusBadge,
  Modal,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
import { FinancialNotice, SortSelect } from "../payments/financialShared";
import { inr, methodOptions } from "../../lib/financial";
import { ReasonDialog } from "../payments/SubscriptionDialog";
import { InvoiceDialog } from "../payments/FeesPage";
import { ExpenseDialog, PostExpenseDialog } from "./ExpenseDialog";

function Breakdown({
  title,
  values,
}: {
  title: string;
  values: Record<string, string>;
}) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      <DataTable
        rows={Object.entries(values).map(([id, amount]) => ({ id, amount }))}
        columns={[
          { label: "Category / plan", render: (r) => r.id },
          { label: "Net amount", render: (r) => inr(r.amount) },
        ]}
      />
    </section>
  );
}

export function FinancesPage() {
  const [filters, setFilters] = useState<FinancialFilters>({
    start: today().slice(0, 7) + "-01",
    end: today(),
    search: "",
    type: "",
    method: "",
    status: "",
    sort: "date",
    direction: "desc",
    page: 1,
    pageSize: 20,
  });
  const [tab, setTab] = useState("transactions");
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [posting, setPosting] = useState<Expense | null>(null);
  const [reversing, setReversing] = useState<Expense | null>(null);
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [invoiceId, setInvoice] = useState<string | null>(null);
  const [expenseSearch, setExpenseSearch] = useState("");
  const [expenseStatus, setExpenseStatus] = useState("");
  const [expensePage, setExpensePage] = useState(1);
  const query = useQuery({
    queryKey: ["finances", filters],
    queryFn: () => financialApi.finances(filters),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const exporting = useMutation({
    mutationFn: () => financialApi.export(filters),
  });
  const update = (key: string, value: string) =>
    setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  const data = query.data;
  const expenses = (data?.expenses || [])
    .filter(
      (e) =>
        (!expenseStatus || e.status === expenseStatus) &&
        `${e.category} ${e.description} ${e.reference}`
          .toLowerCase()
          .includes(expenseSearch.toLowerCase()),
    )
    .sort(
      (a, b) =>
        b.incurredOn.localeCompare(a.incurredOn) || a.id.localeCompare(b.id),
    );
  return (
    <>
      <PageHeader
        title="Finances"
        description="Cash collections, expenses and reports from the same financial ledger as Fees Due."
      >
        <button
          className="btn"
          disabled={exporting.isPending}
          onClick={() => exporting.mutate()}
        >
          Export transactions CSV
        </button>
        <button className="btn primary" onClick={() => setEditing("new")}>
          Add expense
        </button>
      </PageHeader>
      <FinancialNotice />
      <div className="toolbar">
        <label>
          From{" "}
          <input
            aria-label="Report start"
            type="date"
            value={filters.start}
            onChange={(e) => update("start", e.target.value)}
          />
        </label>
        <label>
          Through{" "}
          <input
            aria-label="Report end"
            type="date"
            value={filters.end}
            onChange={(e) => update("end", e.target.value)}
          />
        </label>
      </div>
      {exporting.error && <ErrorState error={exporting.error} />}
      {exporting.isSuccess && <p role="status">CSV downloaded.</p>}
      {query.isPending ? (
        <LoadingSkeleton />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        data && (
          <>
            {data.warnings.map((w) => (
              <p className="notice" role="alert" key={w}>
                {w}
              </p>
            ))}
            <div className="metrics">
              <StatCard
                label="Net collections"
                value={inr(data.summary.collections)}
                note={`Gross ${inr(data.summary.grossCollections)} less refunds ${inr(data.summary.refunds)}`}
              />
              <StatCard
                label="Paid expenses"
                value={inr(data.summary.expenses)}
                note="Payments less returned/reversed expenses"
              />
              <StatCard
                label="Net cash flow"
                value={inr(data.summary.netCashFlow)}
                note={`After expenses and ${inr(data.summary.trainerPayouts)} actual trainer payouts; not profit`}
              />
              <StatCard
                label="Outstanding receivables"
                value={inr(data.summary.outstanding)}
                note="Current balances, not revenue or period-end receivables"
              />
              <StatCard
                label="This month collections"
                value={inr(data.summary.currentMonthCollections)}
                note="Current calendar month, Asia/Kolkata"
              />
              <StatCard
                label="This month expenses"
                value={inr(data.summary.currentMonthExpenses)}
                note="Current calendar month, not selected report range"
              />
            </div>
            <p className="notice">
              Report KPIs use the inclusive date range above. Transaction
              search/type/status filters affect the table and CSV only. Refunds
              are dated cash outflows; fee adjustments are non-cash. Expense
              reversals represent money returned, not merely cancelling a vendor
              bill.
            </p>
            <div className="tabs" role="tablist" aria-label="Finance view">
              {["transactions", "expenses", "reports"].map((t) => (
                <button
                  className={tab === t ? "btn primary" : "btn"}
                  role="tab"
                  aria-selected={tab === t}
                  key={t}
                  onClick={() => setTab(t)}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            {tab === "transactions" && (
              <>
                <div className="toolbar">
                  <input
                    aria-label="Search transactions"
                    placeholder="Search transactions"
                    value={filters.search}
                    onChange={(e) => update("search", e.target.value)}
                  />
                  <select
                    aria-label="Transaction type"
                    value={filters.type}
                    onChange={(e) => update("type", e.target.value)}
                  >
                    <option value="">All types</option>
                    {[
                      "payment",
                      "refund",
                      "reversal",
                      "expense",
                      "expense_reversal",
                      "trainer_payout",
                      "adjustment",
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Transaction method"
                    value={filters.method}
                    onChange={(e) => update("method", e.target.value)}
                  >
                    <option value="">All methods</option>
                    {methodOptions.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Transaction status"
                    value={filters.status}
                    onChange={(e) => update("status", e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {[
                      "completed",
                      "pending",
                      "failed",
                      "reversed",
                      "partially_refunded",
                      "recorded",
                      "paid",
                      "void",
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <SortSelect
                    value={filters}
                    update={update}
                    options={["date", "amount", "type", "entity", "status"]}
                  />
                </div>
                <DataTable
                  rows={data.rows}
                  columns={[
                    {
                      label: "Transaction / date",
                      render: (r) => (
                        <>
                          <small>{r.id}</small>
                          {dateLabel(r.date || "")}
                        </>
                      ),
                    },
                    {
                      label: "Type",
                      render: (r) => r.type.replaceAll("_", " "),
                    },
                    { label: "Entity", render: (r) => r.entity },
                    { label: "Amount", render: (r) => inr(r.amount) },
                    { label: "Method", render: (r) => r.method || "—" },
                    {
                      label: "Status",
                      render: (r) => <StatusBadge status={r.status} />,
                    },
                    { label: "Reference", render: (r) => r.reference || "—" },
                    {
                      label: "Actions",
                      render: (r) => (
                        <button
                          className="btn small"
                          onClick={() => setDetail(r)}
                        >
                          Details
                        </button>
                      ),
                    },
                  ]}
                  pageSize={data.pageSize}
                  pagination={{
                    page: data.page,
                    total: data.total,
                    onChange: (page) => setFilters((f) => ({ ...f, page })),
                  }}
                />
              </>
            )}
            {tab === "expenses" && (
              <>
                <p>
                  All expense drafts and payment history, independent of report
                  dates. Paid entries are immutable; voiding a paid expense
                  records returned cash today.
                </p>
                <div className="toolbar">
                  <input
                    aria-label="Search expenses"
                    placeholder="Search expenses"
                    value={expenseSearch}
                    onChange={(e) => {
                      setExpenseSearch(e.target.value);
                      setExpensePage(1);
                    }}
                  />
                  <select
                    aria-label="Expense status"
                    value={expenseStatus}
                    onChange={(e) => {
                      setExpenseStatus(e.target.value);
                      setExpensePage(1);
                    }}
                  >
                    <option value="">All statuses</option>
                    <option value="recorded">Draft</option>
                    <option value="paid">Paid</option>
                    <option value="void">Void</option>
                  </select>
                </div>
                <DataTable
                  rows={expenses.slice(
                    (expensePage - 1) * 20,
                    expensePage * 20,
                  )}
                  columns={[
                    {
                      label: "Expense",
                      render: (e) => (
                        <>
                          <strong>{e.category}</strong>
                          <small>{e.description}</small>
                        </>
                      ),
                    },
                    {
                      label: "Incurred / paid",
                      render: (e) =>
                        `${dateLabel(e.incurredOn)} / ${dateLabel(e.date || "")}`,
                    },
                    { label: "Amount", render: (e) => inr(e.amount) },
                    {
                      label: "Status",
                      render: (e) => (
                        <StatusBadge
                          status={e.status === "recorded" ? "Draft" : e.status}
                        />
                      ),
                    },
                    {
                      label: "Method / reference",
                      render: (e) =>
                        `${e.method || "—"} / ${e.reference || "—"}`,
                    },
                    {
                      label: "Created by",
                      render: (e) => e.createdBy || "Legacy / unknown",
                    },
                    {
                      label: "Actions",
                      render: (e) => (
                        <div className="actions">
                          {e.status === "recorded" && (
                            <>
                              <button
                                className="btn small"
                                onClick={() => setEditing(e)}
                              >
                                Edit
                              </button>
                              <button
                                className="btn small"
                                onClick={() => setPosting(e)}
                              >
                                Record payment
                              </button>
                            </>
                          )}
                          {e.status !== "void" && (
                            <button
                              className="btn small danger"
                              onClick={() => setReversing(e)}
                            >
                              {e.status === "recorded"
                                ? "Void draft"
                                : "Reverse"}
                            </button>
                          )}
                          <button
                            className="btn small"
                            onClick={() =>
                              setDetail({
                                id: e.id,
                                date: e.date || e.incurredOn,
                                type: "expense",
                                amount: e.amount,
                                entity: e.category,
                                method: e.method,
                                status: e.status,
                                reference: e.reference,
                                notes: e.description,
                                createdBy: e.createdBy,
                              })
                            }
                          >
                            History
                          </button>
                        </div>
                      ),
                    },
                  ]}
                  pageSize={20}
                  pagination={{
                    page: expensePage,
                    total: expenses.length,
                    onChange: setExpensePage,
                  }}
                />
              </>
            )}
            {tab === "reports" && (
              <>
                <h2>Monthly cash-flow summary</h2>
                <DataTable
                  rows={data.trends.map((t) => ({ ...t, id: t.month }))}
                  columns={[
                    { label: "Month", render: (r) => r.month },
                    {
                      label: "Net collections",
                      render: (r) => inr(r.collections),
                    },
                    { label: "Net expenses", render: (r) => inr(r.expenses) },
                    {
                      label: "Trainer payouts",
                      render: (r) => inr(r.trainerPayouts),
                    },
                  ]}
                />
                <div className="financial-reports">
                  <Breakdown
                    title="Collections by payment method"
                    values={data.methods}
                  />
                  <Breakdown
                    title="Collections by purchased plan / charge"
                    values={data.plans}
                  />
                  <Breakdown
                    title="Net expenses by category"
                    values={data.categories}
                  />
                </div>
                <p>
                  Outstanding fees:{" "}
                  <strong>{inr(data.summary.outstanding)}</strong>. Open Fees
                  Due for member-level receivables, including archived and
                  expired memberships.
                </p>
              </>
            )}
          </>
        )
      )}
      {editing && (
        <ExpenseDialog
          expense={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {posting && (
        <PostExpenseDialog expense={posting} onClose={() => setPosting(null)} />
      )}
      {reversing && (
        <ReasonDialog
          title={
            reversing.status === "paid"
              ? "Reverse expense"
              : "Void draft expense"
          }
          description={
            reversing.status === "paid"
              ? "Confirm that this expense payment was returned/reversed. An offsetting cash entry is dated today; the original payment stays in history."
              : "Void this unpaid draft. It has no cash-flow impact. The draft and audit history are retained."
          }
          url={`/financial-expenses/${reversing.id}/reverse`}
          extra={{ version: reversing.version }}
          onClose={() => setReversing(null)}
        />
      )}
      {detail && (
        <Modal title="Transaction details" onClose={() => setDetail(null)}>
          <div className="modal-body">
            <h3>
              {detail.entity} · {inr(detail.amount)}
            </h3>
            <p>
              {detail.id} · {detail.type} · {detail.status}
            </p>
            <p>
              {dateLabel(detail.date || "")} · {detail.method || "—"}
            </p>
            <p>Reference: {detail.reference || "—"}</p>
            <p>Notes: {detail.notes || "—"}</p>
            <p>Created by: {detail.createdBy || "Legacy / unknown"}</p>
            {detail.invoiceId && (
              <button
                className="btn"
                onClick={() => {
                  setInvoice(detail.invoiceId!);
                  setDetail(null);
                }}
              >
                View invoice / reverse payment
              </button>
            )}
            <h3>Audit history</h3>
            {data?.events
              .filter((e) => e.target_id === detail.id)
              .map((e) => (
                <section className="financial-history" key={e.id}>
                  <strong>
                    {e.action} · {dateLabel(e.created_at)}
                  </strong>
                  <p>
                    Actor {e.actor_id} ·{" "}
                    {String(
                      e.after_state.reason || e.after_state.description || "",
                    )}
                  </p>
                  <pre>
                    {JSON.stringify(
                      { before: e.before_state, after: e.after_state },
                      null,
                      2,
                    )}
                  </pre>
                </section>
              ))}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
      {invoiceId && (
        <InvoiceDialog id={invoiceId} onClose={() => setInvoice(null)} />
      )}
    </>
  );
}
