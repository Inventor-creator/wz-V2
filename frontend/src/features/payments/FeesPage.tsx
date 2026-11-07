import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Invoice, Payment } from "../../types/domain";
import { api } from "../../lib/api";
import { paymentSchema } from "../../lib/validation";
import { dateLabel, money, today } from "../../lib/dates";
import {
  useWorkspace,
  useAction,
  PageHeader,
  StatCard,
  DataTable,
  Person,
  StatusBadge,
  Modal,
  Field,
  FormLayout,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
export function PaymentDialog({
  invoice,
  onClose,
}: {
  invoice: Invoice;
  onClose: () => void;
}) {
  const [receipt, setReceipt] = useState<Payment | null>(null);
  type Values = Omit<Payment, "id" | "invoiceId" | "memberId">;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(paymentSchema(invoice.outstandingAmount)),
    defaultValues: {
      amount: invoice.outstandingAmount,
      paymentDate: today(),
      method: "UPI",
      transactionReference: "",
      notes: "",
    },
  });
  const save = useAction((v: Values) =>
    api.payments.create({ ...v, invoiceId: invoice.id }),
  );
  return (
    <Modal
      title={receipt ? "Payment receipt" : "Log payment"}
      onClose={onClose}
    >
      {receipt ? (
        <div className="modal-body">
          <div className="receipt">
            <small>WORKOUT ZONE · DEVELOPMENT RECEIPT</small>
            <h3>{receipt.id}</h3>
            <div className="amount">{money(receipt.amount)}</div>
            <p>
              {invoice.id} · {receipt.method} · {dateLabel(receipt.paymentDate)}
            </p>
            <p>Reference: {receipt.transactionReference || "Not provided"}</p>
            <p>{receipt.notes}</p>
          </div>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <>
          <div className="notice">
            {invoice.id} · Outstanding balance:{" "}
            <strong>{money(invoice.outstandingAmount)}</strong>
          </div>
          <FormLayout
            onSubmit={handleSubmit((v) =>
              save.mutate(v, { onSuccess: (r) => setReceipt(r as Payment) }),
            )}
            pending={save.isPending}
            error={save.error}
            onClose={onClose}
          >
            <Field label="Payment amount (INR)" error={errors.amount?.message}>
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={invoice.outstandingAmount}
                {...register("amount", { valueAsNumber: true })}
              />
            </Field>
            <Field label="Payment date" error={errors.paymentDate?.message}>
              <input type="date" max={today()} {...register("paymentDate")} />
            </Field>
            <Field label="Payment method">
              <select {...register("method")}>
                {["Cash", "UPI", "Card", "Bank Transfer"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Transaction reference">
              <input {...register("transactionReference")} />
            </Field>
            <Field label="Notes" wide>
              <textarea {...register("notes")} />
            </Field>
          </FormLayout>
        </>
      )}
    </Modal>
  );
}
export function FeesPage() {
  const q = useWorkspace();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [due, setDue] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [history, setHistory] = useState(false);
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data) return <ErrorState error={q.error} />;
  const db = q.data;
  const member = (id: string) => db.members.find((m) => m.id === id);
  const rows = db.invoices.filter(
    (i) =>
      i.outstandingAmount > 0 &&
      member(i.memberId)
        ?.fullName.toLowerCase()
        .includes(search.toLowerCase()) &&
      (!type || i.lineItems.some((l) => l.feeType === type)) &&
      (!status || i.status === status) &&
      (!due || i.dueDate <= due),
  );
  return (
    <>
      <PageHeader
        title="Fees due"
        description="Keep collections clear, accurate and up to date."
      >
        <button className="btn" onClick={() => setHistory(true)}>
          Payment history & receipts
        </button>
      </PageHeader>
      <div className="metrics">
        <StatCard
          main
          label="Outstanding Fees"
          value={money(
            db.invoices.reduce((s, i) => s + i.outstandingAmount, 0),
          )}
        />
        <StatCard
          label="Unpaid Invoices"
          value={db.invoices.filter((i) => i.status === "UNPAID").length}
        />
        <StatCard
          label="Partially Paid"
          value={db.invoices.filter((i) => i.status === "PARTIAL").length}
        />
      </div>
      <div className="toolbar panel">
        <input
          placeholder="Search member…"
          aria-label="Search invoice member"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Fee type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">All fee types</option>
          <option value="GYM">Gym membership</option>
          <option value="PT">Personal training</option>
        </select>
        <select
          aria-label="Payment status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All payment statuses</option>
          <option value="UNPAID">Unpaid</option>
          <option value="PARTIAL">Partially paid</option>
        </select>
        <label className="field">
          Due on or before
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
      </div>
      <DataTable
        rows={rows}
        columns={[
          {
            label: "Member",
            render: (i) => (
              <Person
                name={member(i.memberId)?.fullName || "Archived member"}
                email={member(i.memberId)?.phone}
              />
            ),
          },
          {
            label: "Fee type / Plan",
            render: (i) =>
              i.lineItems.map((l) => (
                <div key={l.id}>
                  {l.feeType}
                  <small>{l.description}</small>
                </div>
              )),
          },
          {
            label: "Invoice date",
            render: (i) => (
              <>
                {dateLabel(i.invoiceDate)}
                <small>{i.id}</small>
              </>
            ),
          },
          { label: "Due date", render: (i) => dateLabel(i.dueDate) },
          { label: "Amount due", render: (i) => money(i.outstandingAmount) },
          {
            label: "Payment status",
            render: (i) => <StatusBadge status={i.status} />,
          },
          {
            label: "Actions",
            render: (i) => (
              <button className="btn small" onClick={() => setInvoice(i)}>
                Log Payment
              </button>
            ),
          },
        ]}
      />
      {invoice && (
        <PaymentDialog invoice={invoice} onClose={() => setInvoice(null)} />
      )}
      {history && (
        <Modal
          title="Payment history & receipts"
          onClose={() => setHistory(false)}
        >
          <div className="modal-body">
            <DataTable
              rows={db.payments}
              columns={[
                {
                  label: "Receipt",
                  render: (p) => (
                    <>
                      {p.id}
                      <small>{p.invoiceId}</small>
                    </>
                  ),
                },
                { label: "Date", render: (p) => dateLabel(p.paymentDate) },
                {
                  label: "Method / Reference",
                  render: (p) => (
                    <>
                      {p.method}
                      <small>{p.transactionReference}</small>
                    </>
                  ),
                },
                { label: "Collected", render: (p) => money(p.amount) },
              ]}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
