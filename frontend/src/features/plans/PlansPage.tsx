import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { planSchema } from "../../lib/validation";
import { money, calculateDaysRemaining } from "../../lib/dates";
import type {
  Database,
  GymMembershipPlan,
  MembershipPlanDeletion,
} from "../../types/domain";
import {
  PageHeader,
  Modal,
  Field,
  FormLayout,
  StatusBadge,
  ConfirmDialog,
  LoadingSkeleton,
  ErrorState,
  EmptyState,
} from "../../components/ui";
export function PlanForm({
  plan,
  trainerId,
  onClose,
}: {
  plan?: GymMembershipPlan;
  trainerId?: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const durationHelpId = useId();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Omit<GymMembershipPlan, "id">>({
    resolver: zodResolver(planSchema),
    defaultValues: plan || {
      name: "",
      price: 2500,
      duration: trainerId ? 1 : 30,
      durationUnit: trainerId ? "MONTH" : "DAY",
      description: "",
      isActive: true,
    },
  });
  const save = useMutation({
    mutationFn: (v: Omit<GymMembershipPlan, "id">) =>
      trainerId
        ? plan
          ? api.personalTrainingPlans.update(plan.id, { ...v, trainerId })
          : api.personalTrainingPlans.create({ ...v, trainerId })
        : plan
          ? api.membershipPlans.update(plan.id, v)
          : api.membershipPlans.create(v),
    onSuccess: async () => {
      await Promise.all(
        (trainerId ? ["workspace"] : ["membership-plans", "workspace"]).map(
          (key) => client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      onClose();
    },
  });
  return (
    <Modal
      title={
        plan
          ? "Edit plan"
          : trainerId
            ? "Add personal training plan"
            : "Add membership plan"
      }
      onClose={onClose}
    >
      <FormLayout
        onSubmit={handleSubmit((v) => save.mutate(v))}
        pending={save.isPending}
        error={save.error}
        onClose={onClose}
      >
        <Field label="Plan name" error={errors.name?.message}>
          <input maxLength={120} {...register("name")} />
        </Field>
        <Field label="Price (INR)" error={errors.price?.message}>
          <input
            type="number"
            min="0"
            step="0.01"
            {...register("price", { valueAsNumber: true })}
          />
        </Field>
        <Field
          label={trainerId ? "Duration" : "Duration (days)"}
          error={errors.duration?.message}
          wide={!trainerId}
        >
          <input
            type="number"
            min="1"
            max="36500"
            aria-label={trainerId ? "Duration" : "Duration (days)"}
            aria-describedby={trainerId ? undefined : durationHelpId}
            {...register("duration", { valueAsNumber: true })}
          />
          {!trainerId && (
            <small id={durationHelpId}>
              Fixed calendar days. Months and years are not approximated.
            </small>
          )}
        </Field>
        {trainerId && (
          <Field label="Duration unit">
            <select {...register("durationUnit")}>
              <option value="DAY">Days</option>
              <option value="MONTH">Months</option>
              <option value="YEAR">Years</option>
            </select>
          </Field>
        )}
        <Field
          label="Description (optional)"
          error={errors.description?.message}
          wide
        >
          <textarea maxLength={2000} {...register("description")} />
        </Field>
        <label className="plan-availability">
          <input
            type="checkbox"
            aria-label="Active"
            {...register("isActive")}
          />
          <span>
            <strong>Active</strong>
            <small>
              Available for new{" "}
              {trainerId ? "training subscriptions" : "memberships"}.
            </small>
          </span>
        </label>
        <p className="text-muted plan-form-note">
          Existing subscriptions retain their purchase price and original dates.
        </p>
      </FormLayout>
    </Modal>
  );
}
export function PlanCards({
  db,
  trainerId,
  plans: suppliedPlans,
  showAddAction = true,
}: {
  db?: Database;
  trainerId?: string;
  plans?: GymMembershipPlan[];
  showAddAction?: boolean;
}) {
  const client = useQueryClient();
  const [notice, setNotice] = useState("");
  const [edit, setEdit] = useState<GymMembershipPlan | null | undefined>();
  const [toggle, setToggle] = useState<GymMembershipPlan | null>(null);
  const mutate = useMutation<
    GymMembershipPlan | MembershipPlanDeletion,
    Error,
    GymMembershipPlan
  >({
    mutationFn: (p: GymMembershipPlan) =>
      trainerId
        ? api.personalTrainingPlans.update(p.id, {
            ...p,
            trainerId,
            isActive: !p.isActive,
          })
        : api.membershipPlans.delete(p.id),
    onSuccess: async (result) => {
      if ("mode" in result)
        setNotice(
          result.mode === "DELETED"
            ? "Plan deleted."
            : "Plan removed from the catalogue. Existing subscriptions and financial history are retained.",
        );
      await Promise.all(
        (trainerId ? ["workspace"] : ["membership-plans", "workspace"]).map(
          (key) => client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      setToggle(null);
    },
  });
  const plans = trainerId
    ? db?.personalTrainingPlans.filter((p) => p.trainerId === trainerId) || []
    : (suppliedPlans ?? db?.membershipPlans ?? []);
  return (
    <>
      {showAddAction && (
        <div className="section-actions">
          <button className="btn primary" onClick={() => setEdit(null)}>
            + Add {trainerId ? "PT " : ""}Plan
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {notice}
        </div>
      )}
      {!plans.length && (
        <EmptyState text="No plans match. Add a plan or change your filters." />
      )}
      <div
        className={"plan-grid" + (!trainerId ? " membership-plan-grid" : "")}
      >
        {plans.map((p) => (
          <article
            className={"plan-card" + (!trainerId ? " membership-card" : "")}
            key={p.id}
          >
            <StatusBadge
              status={
                p.isActive ? "Active" : trainerId ? "Archived" : "Inactive"
              }
            />
            <h2>{p.name}</h2>
            <p
              className={!trainerId ? "plan-description" : undefined}
              title={p.description}
            >
              {p.description}
            </p>
            <div className="price">
              {money(p.price)}{" "}
              <small>
                / {p.duration} {p.durationUnit.toLowerCase()}
                {p.duration > 1 ? "s" : ""}
              </small>
            </div>
            <div className="bottom">
              <span className="plan-member-count">
                {p.activeMembersCount ??
                  (trainerId
                    ? db?.trainingSubscriptions || []
                    : db?.gymSubscriptions || []
                  ).filter(
                    (s) =>
                      s.planId === p.id &&
                      s.status === "ACTIVE" &&
                      calculateDaysRemaining(s.endDate) >= 0,
                  ).length}{" "}
                active members
              </span>
              <div className="actions">
                <button className="btn small" onClick={() => setEdit(p)}>
                  Edit
                </button>
                <button className="btn small" onClick={() => setToggle(p)}>
                  {trainerId
                    ? p.isActive
                      ? "Archive"
                      : "Reactivate"
                    : "Delete"}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {edit !== undefined && (
        <PlanForm
          plan={edit || undefined}
          trainerId={trainerId}
          onClose={() => setEdit(undefined)}
        />
      )}
      {toggle && (
        <ConfirmDialog
          title={
            trainerId
              ? toggle.isActive
                ? "Archive plan?"
                : "Reactivate plan?"
              : "Delete membership plan?"
          }
          description={
            trainerId
              ? "Historical subscriptions and prices will not be changed."
              : `Remove ${toggle.name} from the catalogue? Unused plans are permanently deleted. Plans with subscription history are retained but cannot be purchased again. Existing subscription dates, prices and invoices are not changed.`
          }
          onClose={() => setToggle(null)}
          onConfirm={() => mutate.mutate(toggle)}
          pending={mutate.isPending}
          error={mutate.error}
          confirmLabel={trainerId ? "Confirm" : "Delete plan"}
          danger={!trainerId}
        />
      )}
    </>
  );
}
export function PlansPage() {
  const q = useQuery({
    queryKey: ["membership-plans"],
    queryFn: api.membershipPlans.list,
  });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  return (
    <>
      <PageHeader
        title="Membership plans"
        description="Flexible plans. Consistent progress."
      >
        <button className="btn primary" onClick={() => setCreating(true)}>
          + Add Plan
        </button>
      </PageHeader>
      {q.error && <ErrorState error={q.error} retry={() => void q.refetch()} />}
      <div className="toolbar panel membership-toolbar">
        <input
          aria-label="Search membership plans"
          placeholder="Search plans…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Plan status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
      <PlanCards
        showAddAction={false}
        plans={q.data.filter(
          (p) =>
            p.name.toLowerCase().includes(search.toLowerCase()) &&
            (!status || p.isActive === (status === "active")),
        )}
      />
      {creating && <PlanForm onClose={() => setCreating(false)} />}
    </>
  );
}
