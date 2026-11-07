import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "../../lib/api";
import {
  useWorkspace,
  useAction,
  PageHeader,
  Modal,
  Field,
  FormLayout,
  StatusBadge,
  Person,
  DataTable,
  LoadingSkeleton,
  ErrorState,
  EmptyState,
  ConfirmDialog,
} from "../../components/ui";
import type { Trainer } from "../../types/domain";
import { PlanCards } from "../plans/PlansPage";
import { PermissionGate } from "../auth/AuthProvider";
const trainerSchema = z.object({
  name: z.string().trim().min(2),
  email: z.email(),
  phone: z.string().regex(/^(\+91[ -]?)?[6-9]\d{9}$/),
  isActive: z.boolean(),
  userId: z.string().optional(),
});
export function TrainerForm({
  trainer,
  onClose,
}: {
  trainer?: Trainer;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Omit<Trainer, "id">>({
    resolver: zodResolver(trainerSchema),
    defaultValues: trainer || {
      name: "",
      email: "",
      phone: "",
      isActive: true,
      userId: "",
    },
  });
  const save = useAction(
    (v: Omit<Trainer, "id">) =>
      trainer ? api.trainers.update(trainer.id, v) : api.trainers.create(v),
    onClose,
  );
  return (
    <Modal title={trainer ? "Edit trainer" : "Add trainer"} onClose={onClose}>
      <FormLayout
        onSubmit={handleSubmit((v) => save.mutate(v))}
        pending={save.isPending}
        error={save.error}
        onClose={onClose}
      >
        <Field label="Name" error={errors.name?.message}>
          <input {...register("name")} />
        </Field>
        <Field label="Email" error={errors.email?.message}>
          <input type="email" {...register("email")} />
        </Field>
        <Field label="Phone" error={errors.phone?.message}>
          <input {...register("phone")} />
        </Field>
        <Field label="Google user ID (optional)">
          <input {...register("userId")} />
        </Field>
        <Field label="Active">
          <input type="checkbox" {...register("isActive")} />
        </Field>
      </FormLayout>
    </Modal>
  );
}
export function TrainersPage() {
  const q = useWorkspace();
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Trainer | null | undefined>();
  const [toggle, setToggle] = useState<Trainer | null>(null);
  const update = useAction(
    (t: Trainer) => api.trainers.update(t.id, { ...t, isActive: !t.isActive }),
    () => setToggle(null),
  );
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data) return <ErrorState error={q.error} />;
  const db = q.data;
  return (
    <>
      <PageHeader
        title="Trainers & PT plans"
        description="The people behind every personal best."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          + Add Trainer
        </button>
      </PageHeader>
      <div className="toolbar">
        <input
          aria-label="Search trainers"
          placeholder="Search trainers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="plan-grid">
        {db.trainers
          .filter((t) =>
            (t.name + " " + t.email)
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((t) => (
            <article className="plan-card trainer-card" key={t.id}>
              <Person name={t.name} />
              <h2>{t.name}</h2>
              <StatusBadge status={t.isActive ? "Active" : "Inactive"} />
              <p>
                {t.email}
                <br />
                {t.phone}
              </p>
              <div className="info">
                {
                  db.trainingSubscriptions.filter((s) => s.trainerId === t.id)
                    .length
                }{" "}
                assigned members
                <br />
                {
                  db.personalTrainingPlans.filter(
                    (p) => p.trainerId === t.id && p.isActive,
                  ).length
                }{" "}
                active PT plans
              </div>
              <Link className="btn" to={"/trainers/" + t.id}>
                View trainer & plans →
              </Link>
              <div className="actions">
                <button className="btn small" onClick={() => setEdit(t)}>
                  Edit
                </button>
                <button className="btn small" onClick={() => setToggle(t)}>
                  {t.isActive ? "Deactivate" : "Activate"}
                </button>
              </div>
            </article>
          ))}
      </div>
      {edit !== undefined && (
        <TrainerForm
          trainer={edit || undefined}
          onClose={() => setEdit(undefined)}
        />
      )}
      {toggle && (
        <ConfirmDialog
          title="Change trainer status?"
          description="Existing assignments and historical subscriptions will be retained."
          onClose={() => setToggle(null)}
          onConfirm={() => update.mutate(toggle)}
          pending={update.isPending}
          error={update.error}
        />
      )}
    </>
  );
}
export function TrainerDetails() {
  const { trainerId } = useParams();
  const q = useWorkspace();
  const [commission, setCommission] = useState("40");
  const save = useAction((rate: number) =>
    api.payouts.update(trainerId!, rate),
  );
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data) return <ErrorState error={q.error} />;
  const db = q.data;
  const trainer = db.trainers.find((t) => t.id === trainerId);
  if (!trainer) return <EmptyState text="Trainer not found." />;
  const config = db.payoutConfigurations.find((p) => p.trainerId === trainerId);
  return (
    <>
      <PageHeader
        title={trainer.name}
        description={`${trainer.email} · ${trainer.phone}`}
      >
        <Link className="btn" to="/trainers">
          Back to trainers
        </Link>
      </PageHeader>
      <PermissionGate roles={["SUPER_ADMIN", "GYM_OWNER"]}>
        <section className="notice">
          <strong>Payout configuration: </strong>
          {config
            ? config.payoutType === "COMMISSION"
              ? `${config.commissionRate}% commission`
              : "Fixed amount"
            : "Not Configured"}
          <form
            className="actions"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(Number(commission));
            }}
          >
            <label>
              Commission %{" "}
              <input
                aria-label="Commission percentage"
                type="number"
                min="0"
                max="100"
                required
                value={commission}
                onChange={(e) => setCommission(e.target.value)}
              />
            </label>
            <button className="btn small" disabled={save.isPending}>
              Save commission
            </button>
            {save.isSuccess && <span role="status">Saved</span>}
          </form>
          {save.error && <ErrorState error={save.error} />}
        </section>
      </PermissionGate>
      <h2 className="section-title">Assigned members</h2>
      <DataTable
        rows={db.members.filter((m) =>
          db.trainingSubscriptions.some(
            (s) => s.memberId === m.id && s.trainerId === trainerId,
          ),
        )}
        columns={[
          {
            label: "Member",
            render: (m) => (
              <Link to={"/members/" + m.id}>
                <Person name={m.fullName} email={m.email} />
              </Link>
            ),
          },
          { label: "Phone", render: (m) => m.phone },
        ]}
      />
      <h2 className="section-title">Personal training plans</h2>
      <PlanCards db={db} trainerId={trainer.id} />
    </>
  );
}
