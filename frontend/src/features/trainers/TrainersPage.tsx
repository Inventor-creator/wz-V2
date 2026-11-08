import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "../../lib/api";
import { trainerProfileSchema } from "../../lib/validation";
import { today, calculateEndDate, dateLabel, money } from "../../lib/dates";
import {
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
  StatCard,
} from "../../components/ui";
import type { Trainer, TrainerInput } from "../../types/domain";

function useTrainerRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [
        "trainers",
        "trainer-details",
        "trainer-dashboard",
        "trainer-options",
        "access-trainer-options",
        "member-options",
        "workspace",
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
}

export function TrainerForm({
  trainer,
  onClose,
  onSaved,
}: {
  trainer?: Trainer;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const refresh = useTrainerRefresh();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<TrainerInput>({
    resolver: zodResolver(trainerProfileSchema),
    defaultValues: {
      name: trainer?.name ?? "",
      email: trainer?.email ?? "",
      phone: trainer?.phone ?? "",
      isActive: trainer?.isActive ?? true,
    },
  });
  const save = useMutation({
    mutationFn: (value: TrainerInput) =>
      trainer
        ? api.trainers.update(trainer.id, value)
        : api.trainers.create(value),
    onSuccess: async () => {
      await refresh();
      onSaved?.();
      onClose();
    },
  });
  return (
    <Modal title={trainer ? "Edit trainer" : "Add trainer"} onClose={onClose}>
      <FormLayout
        onSubmit={handleSubmit((value) => save.mutate(value))}
        pending={save.isPending}
        error={save.error}
        onClose={onClose}
      >
        <Field label="Name" error={errors.name?.message} wide>
          <input maxLength={160} autoComplete="name" {...register("name")} />
        </Field>
        <Field label="Contact email (optional)" error={errors.email?.message}>
          <input
            type="email"
            maxLength={254}
            autoComplete="email"
            {...register("email")}
          />
        </Field>
        <Field label="Phone (optional)" error={errors.phone?.message}>
          <input
            type="tel"
            maxLength={32}
            autoComplete="tel"
            {...register("phone")}
          />
        </Field>
        <label className="plan-availability">
          <input type="checkbox" {...register("isActive")} />
          <span>Active trainer</span>
        </label>
        <p className="text-muted plan-form-note">
          Contact details are not login credentials. Create or revoke login
          access separately in Access Management. Deactivation stops new
          assignments; existing assignments and payouts remain intact.
        </p>
      </FormLayout>
    </Modal>
  );
}

export function TrainersPage() {
  const q = useQuery({ queryKey: ["trainers"], queryFn: api.trainers.list });
  const refresh = useTrainerRefresh();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [edit, setEdit] = useState<Trainer | null | undefined>();
  const [toggle, setToggle] = useState<Trainer | null>(null);
  const [notice, setNotice] = useState("");
  const update = useMutation({
    mutationFn: (trainer: Trainer) =>
      api.trainers.update(trainer.id, { isActive: !trainer.isActive }),
    onSuccess: async () => {
      await refresh();
      setToggle(null);
      setNotice(
        "Trainer status updated. Login grants and historical records are unchanged.",
      );
    },
  });
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const filtered = q.data.filter(
    (t) =>
      `${t.name} ${t.email} ${t.phone}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()) &&
      (!status || t.isActive === (status === "active")),
  );
  return (
    <>
      <PageHeader
        title="Trainers"
        description="Trainer profiles, member assignments and access status."
      >
        <Link className="btn" to="/personal-training-plans">
          Manage PT plans
        </Link>
        <button className="btn primary" onClick={() => setEdit(null)}>
          + Add Trainer
        </button>
      </PageHeader>
      {q.error && <ErrorState error={q.error} retry={() => void q.refetch()} />}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <div className="toolbar panel membership-toolbar">
        <input
          aria-label="Search trainers"
          placeholder="Search name, email or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Trainer status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
      {!filtered.length && (
        <EmptyState text="No trainers match. Add a trainer or change your filters." />
      )}
      <div className="plan-grid">
        {filtered.map((t) => (
          <article className="plan-card trainer-directory-card" key={t.id}>
            <StatusBadge status={t.isActive ? "Active" : "Inactive"} />
            <h2>{t.name}</h2>
            <p className="trainer-contact">
              {t.email || "No contact email"}
              <br />
              {t.phone || "No phone number"}
            </p>
            <dl className="trainer-facts">
              <div>
                <dt>Active members</dt>
                <dd>{t.activeMembersCount}</dd>
              </div>
              <div>
                <dt>Members with history</dt>
                <dd>{t.assignedMembersCount}</dd>
              </div>
              <div>
                <dt>Login access</dt>
                <dd>{t.hasLoginAccess ? "Linked" : "Not linked"}</dd>
              </div>
            </dl>
            <div className="trainer-card-footer">
              <Link className="btn" to={"/trainers/" + t.id}>
                View trainer
              </Link>
              <div className="actions">
                <button className="btn small" onClick={() => setEdit(t)}>
                  Edit
                </button>
                <button className="btn small" onClick={() => setToggle(t)}>
                  {t.isActive ? "Deactivate" : "Activate"}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {edit !== undefined && (
        <TrainerForm
          trainer={edit || undefined}
          onClose={() => setEdit(undefined)}
          onSaved={() =>
            setNotice(
              "Trainer profile saved. Login access is managed separately.",
            )
          }
        />
      )}
      {toggle && (
        <ConfirmDialog
          title={toggle.isActive ? "Deactivate trainer?" : "Activate trainer?"}
          description="This controls new PT assignments only. Existing assignments, invoices, payout history and login grants are unchanged. Manage login access separately in Access Management."
          onClose={() => setToggle(null)}
          onConfirm={() => update.mutate(toggle)}
          pending={update.isPending}
          error={update.error}
        />
      )}
    </>
  );
}

const commissionSchema = z
  .object({
    commissionRate: z.number().min(0).max(100).multipleOf(0.01),
    effectiveFrom: z.iso
      .date()
      .refine(
        (value) => value > today(),
        "Choose a date after today (Asia/Kolkata)",
      ),
    effectiveUntil: z.union([z.iso.date(), z.literal("")]),
  })
  .refine(
    (value) =>
      !value.effectiveUntil || value.effectiveUntil >= value.effectiveFrom,
    {
      path: ["effectiveUntil"],
      message: "End date cannot be before start date",
    },
  );

export function CommissionForm({
  trainerId,
  onClose,
  onSaved,
}: {
  trainerId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const client = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof commissionSchema>>({
    resolver: zodResolver(commissionSchema),
    defaultValues: {
      commissionRate: 40,
      effectiveFrom: calculateEndDate(today(), 2, "DAY"),
      effectiveUntil: "",
    },
  });
  const save = useMutation({
    mutationFn: (value: z.infer<typeof commissionSchema>) =>
      api.trainers.scheduleCommission(trainerId, {
        ...value,
        effectiveUntil: value.effectiveUntil || null,
      }),
    onSuccess: async () => {
      await Promise.all(
        ["trainer-details", "trainer-dashboard", "workspace"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      onSaved?.();
      onClose();
    },
  });
  return (
    <Modal title="Schedule commission" onClose={onClose}>
      <FormLayout
        onSubmit={handleSubmit((value) => save.mutate(value))}
        pending={save.isPending}
        error={save.error}
        onClose={onClose}
      >
        <Field
          label="Commission (%)"
          error={errors.commissionRate?.message}
          wide
        >
          <input
            type="number"
            min="0"
            max="100"
            step="0.01"
            {...register("commissionRate", { valueAsNumber: true })}
          />
        </Field>
        <Field label="Effective from" error={errors.effectiveFrom?.message}>
          <input
            type="date"
            min={calculateEndDate(today(), 2, "DAY")}
            {...register("effectiveFrom")}
          />
        </Field>
        <Field
          label="Effective until (optional)"
          error={errors.effectiveUntil?.message}
        >
          <input type="date" {...register("effectiveUntil")} />
        </Field>
        <p className="text-muted plan-form-note">
          Applies to collected PT allocations from the selected future date. A
          preceding rule ends the day before. Conflicting future schedules
          require review. Historical collections and payout items are not
          recalculated.
        </p>
      </FormLayout>
    </Modal>
  );
}

export function TrainerDetails() {
  const { trainerId = "" } = useParams();
  const q = useQuery({
    queryKey: ["trainer-details", trainerId],
    queryFn: () => api.trainers.get(trainerId),
    enabled: !!trainerId,
  });
  const [editing, setEditing] = useState(false);
  const [commission, setCommission] = useState(false);
  const [notice, setNotice] = useState("");
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const { trainer, assignments, payoutRules } = q.data;
  return (
    <>
      <PageHeader
        title={trainer.name}
        description={
          [trainer.email, trainer.phone].filter(Boolean).join(" · ") ||
          "No contact details recorded."
        }
      >
        <Link className="btn" to="/trainers">
          Back to trainers
        </Link>
        <button className="btn primary" onClick={() => setEditing(true)}>
          Edit trainer
        </button>
      </PageHeader>
      {q.error && <ErrorState error={q.error} retry={() => void q.refetch()} />}
      {notice && (
        <div role="status" className="notice">
          {notice}
        </div>
      )}
      <div className="metrics trainer-detail-metrics">
        <StatCard
          label="Active members"
          value={trainer.activeMembersCount}
          note="Assignments covering today, inclusively"
        />
        <StatCard
          label="Members with history"
          value={trainer.assignedMembersCount}
          note="Distinct members across all assignments"
        />
        <StatCard
          label="Profile status"
          value={trainer.isActive ? "Active" : "Inactive"}
          note={
            trainer.hasLoginAccess
              ? "Login linked separately"
              : "No active login grant"
          }
        />
      </div>
      <p className="notice">
        Profile contact details do not change Google login identity.
        Deactivation blocks new assignments, not existing history or login
        grants. Manage login access in Access Management.
      </p>
      <h2 className="section-title">Assignment history</h2>
      <DataTable
        rows={assignments}
        columns={[
          {
            label: "Member",
            render: (s) => (
              <Link to={"/members/" + s.memberId}>
                <Person name={s.memberName} email={s.memberEmail} />
              </Link>
            ),
          },
          { label: "PT plan", render: (s) => s.planName },
          { label: "Starts", render: (s) => dateLabel(s.startDate) },
          { label: "Ends", render: (s) => dateLabel(s.endDate) },
          { label: "Purchased at", render: (s) => money(s.priceAtPurchase) },
          { label: "Status", render: (s) => <StatusBadge status={s.status} /> },
        ]}
      />
      {payoutRules != null && (
        <section className="trainer-commission-section">
          <div className="trainer-section-head">
            <h2>Commission rules</h2>
            <button className="btn" onClick={() => setCommission(true)}>
              Schedule commission
            </button>
          </div>
          <p className="text-muted">
            Rates apply to collected PT allocations, not catalogue prices. Fixed
            or overlapping legacy rules require review; no fixed payout unit is
            assumed.
          </p>
          <DataTable
            rows={payoutRules}
            columns={[
              {
                label: "Rule",
                render: (r) =>
                  r.kind === "percent"
                    ? `${r.value}% of PT collections`
                    : `${money(r.value)} fixed — policy review required`,
              },
              {
                label: "Effective from",
                render: (r) => dateLabel(r.effectiveFrom),
              },
              {
                label: "Effective until",
                render: (r) =>
                  r.effectiveUntil ? dateLabel(r.effectiveUntil) : "Open-ended",
              },
            ]}
          />
        </section>
      )}
      <h2 className="section-title">Personal training plans</h2>
      <p className="text-muted">
        Plans are shared across trainers. Choose the trainer separately when
        assigning a plan to a member.
      </p>
      <Link className="btn" to="/personal-training-plans">
        Manage PT plans
      </Link>
      {editing && (
        <TrainerForm trainer={trainer} onClose={() => setEditing(false)} />
      )}
      {commission && (
        <CommissionForm
          trainerId={trainer.id}
          onClose={() => setCommission(false)}
          onSaved={() =>
            setNotice(
              "Commission rule scheduled. Past collections and payouts are unchanged.",
            )
          }
        />
      )}
    </>
  );
}
