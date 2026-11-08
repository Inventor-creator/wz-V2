import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { today } from "../../lib/dates";
import { Modal, Field, ErrorState, LoadingSkeleton } from "../../components/ui";
import { useFinancialCommand } from "../../lib/financial";

export function SubscriptionDialog({
  onClose,
  memberId = "",
}: {
  onClose: () => void;
  memberId?: string;
}) {
  const [member, setMember] = useState(memberId);
  const [memberSearch, setMemberSearch] = useState("");
  const [kind, setKind] = useState("GYM");
  const [planId, setPlan] = useState("");
  const [trainerId, setTrainer] = useState("");
  const [startDate, setStart] = useState(today());
  const options = useQuery({
    queryKey: ["member-options"],
    queryFn: api.members.options,
  });
  const members = useQuery({
    queryKey: ["members"],
    queryFn: api.members.list,
  });
  const command = useFinancialCommand(onClose);
  const search = memberSearch.trim().toLowerCase();
  const matchingMembers = (members.data?.members || []).filter(
    (m) =>
      m.status === "ACTIVE" &&
      [m.fullName, m.memberNumber, m.id, m.phone, m.email].some((value) =>
        value?.toLowerCase().includes(search),
      ),
  );
  const availablePlans = (
    (kind === "GYM"
      ? options.data?.membershipPlans
      : options.data?.personalTrainingPlans) || []
  ).filter((plan) => plan.isActive);
  const availableTrainers = (options.data?.trainers || []).filter(
    (trainer) => trainer.isActive,
  );
  const selectKind = (next: string) => {
    if (next === kind) return;
    setKind(next);
    setPlan("");
    setTrainer("");
  };
  return (
    <Modal
      title="New membership / renewal"
      onClose={() => {
        if (!command.isPending) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          command.mutate({
            url: "/financial-subscriptions",
            fields: {
              memberId: member,
              kind,
              planId,
              trainerId: kind === "PT" ? trainerId : null,
              startDate,
            },
          });
        }}
      >
        <div className="modal-body">
          <p className="notice">
            Creates a new subscription at the current catalogue price and issues
            its fee obligation atomically. Previous debts and purchases remain
            unchanged. Check dates before confirming; renewals do not
            automatically cancel old plans. Choose Gym membership or Personal
            training below; renew each separately when both are needed.
          </p>
          {options.isPending || members.isPending ? (
            <LoadingSkeleton />
          ) : options.error || members.error ? (
            <ErrorState error={options.error || members.error} />
          ) : (
            <fieldset
              disabled={command.isPending}
              className="financial-fieldset"
            >
              <Field label="Search members for renewal">
                <input
                  type="search"
                  placeholder="Name, member ID, phone or email"
                  value={memberSearch}
                  onChange={(e) => {
                    setMemberSearch(e.target.value);
                    setMember("");
                  }}
                />
              </Field>
              {!matchingMembers.length && (
                <p role="status">No eligible members match your search.</p>
              )}
              <Field label="Member">
                <select
                  required
                  value={member}
                  onChange={(e) => setMember(e.target.value)}
                >
                  <option value="">Select member</option>
                  {matchingMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.fullName} · {m.memberNumber}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <span>Renewal type</span>
                <div className="actions" role="group" aria-label="Renewal type">
                  <button
                    type="button"
                    className={kind === "GYM" ? "btn primary" : "btn"}
                    aria-pressed={kind === "GYM"}
                    onClick={() => selectKind("GYM")}
                  >
                    Gym membership
                  </button>
                  <button
                    type="button"
                    className={kind === "PT" ? "btn primary" : "btn"}
                    aria-pressed={kind === "PT"}
                    onClick={() => selectKind("PT")}
                  >
                    Personal training
                  </button>
                </div>
              </div>
              <Field label={kind === "PT" ? "Trainer plan" : "Plan"}>
                <select
                  required
                  value={planId}
                  onChange={(e) => setPlan(e.target.value)}
                >
                  <option value="">
                    {kind === "PT" ? "Select trainer plan" : "Select plan"}
                  </option>
                  {availablePlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · INR {p.price} · {p.duration} days
                    </option>
                  ))}
                </select>
              </Field>
              {kind === "PT" && (
                <Field label="Trainer">
                  <select
                    required
                    value={trainerId}
                    onChange={(e) => setTrainer(e.target.value)}
                  >
                    <option value="">Select trainer</option>
                    {availableTrainers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {kind === "PT" &&
                (!availablePlans.length || !availableTrainers.length) && (
                  <p role="status">
                    {!availablePlans.length
                      ? "No active trainer plans are available. Add or reactivate a plan in Trainer Plans. "
                      : ""}
                    {!availableTrainers.length
                      ? "No active trainers are available. Add or reactivate a trainer in Trainers."
                      : ""}
                  </p>
                )}
              <Field label="Start date">
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field>
            </fieldset>
          )}
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
          <button
            className="btn primary"
            disabled={command.isPending || !options.data || !members.data}
          >
            {command.isPending ? "Saving…" : "Create subscription"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ReasonDialog({
  title,
  description,
  url,
  extra = {},
  onClose,
}: {
  title: string;
  description: string;
  url: string;
  extra?: Record<string, unknown>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
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
          command.mutate({ url, fields: { ...extra, reason } });
        }}
      >
        <div className="modal-body">
          <p className="notice">{description}</p>
          <Field label="Reason">
            <textarea
              required
              minLength={3}
              maxLength={2000}
              disabled={command.isPending}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
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
          <button className="btn danger" disabled={command.isPending}>
            {command.isPending ? "Saving…" : title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
