import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "../../lib/api";
import { planSchema } from "../../lib/validation";
import { money, calculateDaysRemaining } from "../../lib/dates";
import type { Database, GymMembershipPlan } from "../../types/domain";
import {
  useWorkspace,
  useAction,
  PageHeader,
  Modal,
  Field,
  FormLayout,
  StatusBadge,
  ConfirmDialog,
  LoadingSkeleton,
  ErrorState,
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
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Omit<GymMembershipPlan, "id">>({
    resolver: zodResolver(planSchema),
    defaultValues: plan || {
      name: "",
      price: 2500,
      duration: 1,
      durationUnit: "MONTH",
      description: "",
      isActive: true,
    },
  });
  const save = useAction(
    (v: Omit<GymMembershipPlan, "id">) =>
      trainerId
        ? plan
          ? api.personalTrainingPlans.update(plan.id, { ...v, trainerId })
          : api.personalTrainingPlans.create({ ...v, trainerId })
        : plan
          ? api.membershipPlans.update(plan.id, v)
          : api.membershipPlans.create(v),
    onClose,
  );
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
          <input {...register("name")} />
        </Field>
        <Field label="Price (INR)" error={errors.price?.message}>
          <input
            type="number"
            min="1"
            step="0.01"
            {...register("price", { valueAsNumber: true })}
          />
        </Field>
        <Field label="Duration" error={errors.duration?.message}>
          <input
            type="number"
            min="1"
            {...register("duration", { valueAsNumber: true })}
          />
        </Field>
        <Field label="Duration unit">
          <select {...register("durationUnit")}>
            <option value="DAY">Days</option>
            <option value="MONTH">Months</option>
            <option value="YEAR">Years</option>
          </select>
        </Field>
        <Field label="Description" error={errors.description?.message} wide>
          <textarea {...register("description")} />
        </Field>
        <Field label="Active">
          <input type="checkbox" {...register("isActive")} />
        </Field>
        <p className="text-muted">
          Existing subscriptions retain their purchase price and original dates.
        </p>
      </FormLayout>
    </Modal>
  );
}
export function PlanCards({
  db,
  trainerId,
}: {
  db: Database;
  trainerId?: string;
}) {
  const [edit, setEdit] = useState<GymMembershipPlan | null | undefined>();
  const [toggle, setToggle] = useState<GymMembershipPlan | null>(null);
  const mutate = useAction(
    (p: GymMembershipPlan) =>
      trainerId
        ? api.personalTrainingPlans.update(p.id, {
            ...p,
            trainerId,
            isActive: !p.isActive,
          })
        : api.membershipPlans.update(p.id, { ...p, isActive: !p.isActive }),
    () => setToggle(null),
  );
  const plans = trainerId
    ? db.personalTrainingPlans.filter((p) => p.trainerId === trainerId)
    : db.membershipPlans;
  return (
    <>
      <div className="section-actions">
        <button className="btn primary" onClick={() => setEdit(null)}>
          + Add {trainerId ? "PT " : ""}Plan
        </button>
      </div>
      <div className="plan-grid">
        {plans.map((p) => (
          <article className="plan-card" key={p.id}>
            <StatusBadge status={p.isActive ? "Active" : "Archived"} />
            <h2>{p.name}</h2>
            <p>{p.description}</p>
            <div className="price">
              {money(p.price)}{" "}
              <small>
                / {p.duration} {p.durationUnit.toLowerCase()}
                {p.duration > 1 ? "s" : ""}
              </small>
            </div>
            <div className="bottom">
              <span>
                {
                  (trainerId
                    ? db.trainingSubscriptions
                    : db.gymSubscriptions
                  ).filter(
                    (s) =>
                      s.planId === p.id &&
                      s.status === "ACTIVE" &&
                      calculateDaysRemaining(s.endDate) >= 0,
                  ).length
                }{" "}
                active members
              </span>
              <div className="actions">
                <button className="btn small" onClick={() => setEdit(p)}>
                  Edit
                </button>
                <button className="btn small" onClick={() => setToggle(p)}>
                  {p.isActive ? "Archive" : "Reactivate"}
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
          title={toggle.isActive ? "Archive plan?" : "Reactivate plan?"}
          description="Historical subscriptions and prices will not be changed."
          onClose={() => setToggle(null)}
          onConfirm={() => mutate.mutate(toggle)}
          pending={mutate.isPending}
          error={mutate.error}
        />
      )}
    </>
  );
}
export function PlansPage() {
  const q = useWorkspace();
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data) return <ErrorState error={q.error} />;
  return (
    <>
      <PageHeader
        title="Membership plans"
        description="Flexible plans. Consistent progress."
      />
      <PlanCards db={q.data} />
    </>
  );
}
