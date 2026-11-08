import { useState } from "react";
import type { Expense } from "../../types/financial";
import { today } from "../../lib/dates";
import { Modal, Field, ErrorState } from "../../components/ui";
import {
  amountError,
  expenseCategories,
  methodOptions,
  useFinancialCommand,
} from "../../lib/financial";

export function ExpenseDialog({
  expense,
  onClose,
}: {
  expense?: Expense;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(expense?.amount || "");
  const [incurredOn, setDate] = useState(expense?.incurredOn || today());
  const [category, setCategory] = useState(
    expense?.category || "Miscellaneous",
  );
  const [description, setDescription] = useState(expense?.description || "");
  const [reference, setReference] = useState(expense?.reference || "");
  const [invalid, setInvalid] = useState("");
  const command = useFinancialCommand(onClose);
  return (
    <Modal
      title={expense ? "Edit draft expense" : "Add expense"}
      onClose={() => {
        if (!command.isPending) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const error = amountError(amount);
          if (error) {
            setInvalid(error);
            return;
          }
          command.mutate({
            url: "/financial-expenses" + (expense ? "/" + expense.id : ""),
            method: expense ? "PATCH" : "POST",
            fields: {
              amount,
              incurredOn,
              category,
              description,
              reference,
              ...(expense ? { version: expense.version } : {}),
            },
          });
        }}
      >
        <div className="modal-body">
          <p className="notice">
            Saved as a draft. Only posted payments affect cash expenses. Draft
            edits use version checks; paid expenses cannot be silently edited.
          </p>
          <fieldset className="financial-fieldset" disabled={command.isPending}>
            <Field label="Amount (INR)" error={invalid}>
              <input
                required
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Incurred date">
              <input
                type="date"
                required
                value={incurredOn}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Category">
              <select
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {expenseCategories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Description">
              <textarea
                required
                minLength={3}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Reference">
              <input
                maxLength={200}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
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
            {command.isPending ? "Saving…" : "Save draft expense"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PostExpenseDialog({
  expense,
  onClose,
}: {
  expense: Expense;
  onClose: () => void;
}) {
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState("cash");
  const command = useFinancialCommand(onClose);
  return (
    <Modal
      title="Record expense payment"
      onClose={() => {
        if (!command.isPending) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          command.mutate({
            url: `/financial-expenses/${expense.id}/post`,
            fields: { version: expense.version, date, method },
          });
        }}
      >
        <div className="modal-body">
          <p>
            This confirms money has been paid. The amount and description become
            immutable.
          </p>
          <Field label="Payment date">
            <input
              type="date"
              required
              min={expense.incurredOn}
              max={today()}
              value={date}
              disabled={command.isPending}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label="Payment method">
            <select
              value={method}
              disabled={command.isPending}
              onChange={(e) => setMethod(e.target.value)}
            >
              {methodOptions.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          {command.error && <ErrorState error={command.error} />}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            disabled={command.isPending}
            onClick={onClose}
          >
            Back
          </button>
          <button className="btn primary" disabled={command.isPending}>
            {command.isPending ? "Saving…" : "Confirm expense payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
