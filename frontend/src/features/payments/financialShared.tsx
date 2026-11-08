import { useEffect, useState } from "react";
import {
  amountError,
  methodOptions,
  useFinancialCommand,
} from "../../lib/financial";
import { Field, Modal, ErrorState } from "../../components/ui";
import { today } from "../../lib/dates";
import type { FinancialFilters } from "../../types/financial";

export function FinancialNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const completed = (event: Event) => {
      const result = (event as CustomEvent<{ id: string; action: string }>)
        .detail;
      setMessage(
        `${result.action.replaceAll("_", " ")} confirmed · ${result.id}. Financial history retained.`,
      );
    };
    window.addEventListener("financial-command-completed", completed);
    return () =>
      window.removeEventListener("financial-command-completed", completed);
  }, []);
  return message ? (
    <div className="notice" role="status">
      {message}
      <button className="btn small" onClick={() => setMessage("")}>
        Dismiss
      </button>
    </div>
  ) : null;
}

export function SortSelect({
  value,
  update,
  options,
}: {
  value: FinancialFilters;
  update: (key: string, value: string) => void;
  options: string[];
}) {
  return (
    <>
      <select
        aria-label="Sort by"
        value={value.sort}
        onChange={(e) => update("sort", e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/([A-Z])/g, " $1")}
          </option>
        ))}
      </select>
      <select
        aria-label="Sort direction"
        value={value.direction}
        onChange={(e) => update("direction", e.target.value)}
      >
        <option value="asc">Ascending</option>
        <option value="desc">Descending</option>
      </select>
    </>
  );
}
export function MoneyCommandDialog({
  title,
  url,
  maximum,
  onClose,
  reason = false,
  reversal = false,
  noDate = false,
}: {
  title: string;
  url: string;
  maximum: string;
  onClose: () => void;
  reason?: boolean;
  reversal?: boolean;
  noDate?: boolean;
}) {
  const [amount, setAmount] = useState(maximum);
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [invalid, setInvalid] = useState("");
  const command = useFinancialCommand(onClose);
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!command.isPending) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const error = amountError(amount, maximum);
          if (error) {
            setInvalid(error);
            return;
          }
          command.mutate({
            url,
            fields: reason
              ? { amount, reason: notes, ...(noDate ? {} : { date, reversal }) }
              : { amount, date, method, reference, notes },
          });
        }}
      >
        <div className="modal-body">
          <p className="notice">
            {reason
              ? "This creates a permanent compensating entry; original history is retained. Refunds reopen the outstanding debt."
              : "Record cash already received. No online charge is made."}{" "}
            If a request times out, retry unchanged to reuse its request key.
          </p>
          <fieldset disabled={command.isPending} className="financial-fieldset">
            <Field label="Amount (INR)" error={invalid}>
              <input
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            {!noDate && (
              <Field label="Payment date">
                <input
                  type="date"
                  required
                  max={today()}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
            )}
            {!reason && (
              <>
                <Field label="Payment method">
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    {methodOptions.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Transaction reference">
                  <input
                    maxLength={200}
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label={reason ? "Reason" : "Notes"}>
              <textarea
                required={reason}
                minLength={reason ? 3 : undefined}
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </fieldset>
          {command.error && <ErrorState error={command.error} />}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            disabled={command.isPending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="btn primary" disabled={command.isPending}>
            {command.isPending ? "Saving…" : "Confirm " + title.toLowerCase()}
          </button>
        </div>
      </form>
    </Modal>
  );
}
