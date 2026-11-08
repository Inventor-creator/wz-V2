import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { memberSchema } from "../../lib/validation";
import { api } from "../../lib/api";
import { today, calculateEndDate, dateLabel } from "../../lib/dates";
import type { Database, Member, MemberInput } from "../../types/domain";
import { Field, FormLayout, Modal, useAction } from "../../components/ui";
export function MemberForm({
  db,
  member,
  onClose,
}: {
  db: Database;
  member?: Member;
  onClose: () => void;
}) {
  const gym = db.gymSubscriptions.find((s) => s.memberId === member?.id);
  const pt = db.trainingSubscriptions.find((s) => s.memberId === member?.id);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<MemberInput>({
    resolver: zodResolver(memberSchema),
    defaultValues: {
      fullName: member?.fullName || "",
      email: member?.email || "",
      phone: member?.phone || "",
      joiningDate: member?.joiningDate || today(),
      planId: gym?.planId || "",
      startDate: gym?.startDate || today(),
      trainerId: pt?.trainerId || "",
      ptPlanId: pt?.planId || "",
      ptStartDate: pt?.startDate || today(),
      notes: member?.notes || "",
    },
  });
  const values = useWatch({ control }) as MemberInput;
  const save = useAction(
    (v: MemberInput) =>
      member
        ? api.members.update(member.id, {
            fullName: v.fullName,
            email: v.email,
            phone: v.phone,
            joiningDate: v.joiningDate,
            notes: v.notes,
          })
        : api.members.create(v),
    onClose,
  );
  const plan = db.membershipPlans.find((p) => p.id === values.planId);
  const ptPlan = db.personalTrainingPlans.find((p) => p.id === values.ptPlanId);
  return (
    <Modal title={member ? "Edit member" : "Add a member"} onClose={onClose}>
      <FormLayout
        onSubmit={handleSubmit((v) => save.mutate(v))}
        pending={save.isPending}
        error={save.error}
        onClose={onClose}
      >
        <Field label="Full name" error={errors.fullName?.message}>
          <input {...register("fullName")} />
        </Field>
        <Field label="Email address" error={errors.email?.message}>
          <input type="email" {...register("email")} />
        </Field>
        <Field label="Phone number" error={errors.phone?.message}>
          <input placeholder="9876543210" {...register("phone")} />
        </Field>
        <Field label="Joining date" error={errors.joiningDate?.message}>
          <input type="date" {...register("joiningDate")} />
        </Field>
        <Field label="Gym membership plan" error={errors.planId?.message}>
          <select disabled={!!member} {...register("planId")}>
            <option value="">Select a plan</option>
            {db.membershipPlans
              .filter((p) => p.isActive || p.id === gym?.planId)
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Gym membership start date">
          <input type="date" disabled={!!member} {...register("startDate")} />
          {plan && (
            <small>
              Ends{" "}
              {dateLabel(
                calculateEndDate(
                  values.startDate,
                  plan.duration,
                  plan.durationUnit,
                ),
              )}{" "}
              (inclusive)
            </small>
          )}
        </Field>
        <Field label="Trainer (optional)">
          <select
            disabled={!!member}
            {...register("trainerId", {
              onChange: () => setValue("ptPlanId", ""),
            })}
          >
            <option value="">No personal training</option>
            {db.trainers
              .filter((t) => t.isActive)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Personal training plan" error={errors.ptPlanId?.message}>
          <select
            disabled={!!member || !values.trainerId}
            {...register("ptPlanId")}
          >
            <option value="">Select a PT plan</option>
            {db.personalTrainingPlans
              .filter((p) => p.isActive)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>
        {values.trainerId && (
          <Field label="Personal training start date">
            <input
              disabled={!!member}
              type="date"
              {...register("ptStartDate")}
            />
            {ptPlan && (
              <small>
                Ends{" "}
                {dateLabel(
                  calculateEndDate(
                    values.ptStartDate,
                    ptPlan.duration,
                    ptPlan.durationUnit,
                  ),
                )}
              </small>
            )}
          </Field>
        )}
        <Field label="Notes" wide>
          <textarea {...register("notes")} />
        </Field>
        {member && (
          <p className="text-muted">
            Subscription records and purchase prices are preserved. This form
            updates contact information only.
          </p>
        )}
      </FormLayout>
    </Modal>
  );
}
