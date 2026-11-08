import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { memberSchema, memberProfileSchema } from "../../lib/validation";
import { api } from "../../lib/api";
import { today, calculateEndDate, dateLabel, money } from "../../lib/dates";
import type {
  Member,
  MemberInput,
  MemberProfileInput,
} from "../../types/domain";
import {
  Field,
  FormLayout,
  Modal,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
import { useMemberRefresh } from "./useMemberRefresh";

type Props = { member?: Member; onClose: () => void; onSaved?: () => void };
export function MemberForm(props: Props) {
  return props.member ? (
    <EditMemberForm {...props} member={props.member} />
  ) : (
    <CreateMemberForm {...props} />
  );
}

function EditMemberForm({
  member,
  onClose,
  onSaved,
}: Props & { member: Member }) {
  const refresh = useMemberRefresh();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<MemberProfileInput>({
    resolver: zodResolver(memberProfileSchema),
    defaultValues: {
      fullName: member.fullName,
      email: member.email,
      phone: member.phone,
      joiningDate: member.joiningDate,
      notes: member.notes ?? "",
    },
  });
  const save = useMutation({
    mutationFn: (value: MemberProfileInput) =>
      api.members.update(member.id, value),
    onSuccess: async () => {
      await refresh();
      onSaved?.();
      onClose();
    },
  });
  return (
    <Modal title="Edit member" onClose={onClose} className="member-modal">
      <FormLayout
        onSubmit={handleSubmit((v) => save.mutate(v))}
        pending={save.isPending}
        error={save.error}
        onClose={onClose}
      >
        <Field label="Full name" error={errors.fullName?.message} wide>
          <input maxLength={160} {...register("fullName")} />
        </Field>
        <Field label="Email address (optional)" error={errors.email?.message}>
          <input type="email" maxLength={254} {...register("email")} />
        </Field>
        <Field label="Phone number (optional)" error={errors.phone?.message}>
          <input type="tel" maxLength={32} {...register("phone")} />
        </Field>
        <Field label="Joining date" error={errors.joiningDate?.message} wide>
          <input type="date" {...register("joiningDate")} />
        </Field>
        <Field label="Notes" error={errors.notes?.message} wide>
          <textarea maxLength={2000} {...register("notes")} />
        </Field>
        <p className="text-muted plan-form-note">
          This edits profile details only. Existing subscriptions, trainer
          assignments, purchase prices, dates and invoices stay unchanged.
          Joining date cannot move after an existing subscription start.
        </p>
      </FormLayout>
    </Modal>
  );
}

function CreateMemberForm({ onClose, onSaved }: Props) {
  const refresh = useMemberRefresh();
  const [requestKey] = useState(() => crypto.randomUUID());
  const options = useQuery({
    queryKey: ["member-options"],
    queryFn: api.members.options,
  });
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<MemberInput>({
    resolver: zodResolver(memberSchema),
    defaultValues: {
      fullName: "",
      email: "",
      phone: "",
      joiningDate: today(),
      notes: "",
      planId: "",
      startDate: today(),
      trainerId: "",
      ptPlanId: "",
      ptStartDate: today(),
    },
  });
  const values = useWatch({ control }) as MemberInput;
  const save = useMutation({
    mutationFn: (value: MemberInput) => api.members.create(value, requestKey),
    onSuccess: async () => {
      await refresh();
      onSaved?.();
      onClose();
    },
  });
  const plan = options.data?.membershipPlans.find(
    (p) => p.id === values.planId,
  );
  const pt = options.data?.personalTrainingPlans.find(
    (p) => p.id === values.ptPlanId,
  );
  return (
    <Modal title="Add a member" onClose={onClose} className="member-modal">
      {options.isPending ? (
        <div className="modal-body">
          <LoadingSkeleton />
        </div>
      ) : !options.data ? (
        <div className="modal-body">
          <ErrorState
            error={options.error}
            retry={() => void options.refetch()}
          />
        </div>
      ) : (
        <FormLayout
          onSubmit={handleSubmit((v) => save.mutate(v))}
          pending={save.isPending}
          error={save.error}
          onClose={onClose}
        >
          {options.error && (
            <div className="wide">
              <ErrorState
                error={options.error}
                retry={() => void options.refetch()}
              />
            </div>
          )}
          <Field label="Full name" error={errors.fullName?.message} wide>
            <input maxLength={160} {...register("fullName")} />
          </Field>
          <Field label="Email address (optional)" error={errors.email?.message}>
            <input type="email" maxLength={254} {...register("email")} />
          </Field>
          <Field label="Phone number (optional)" error={errors.phone?.message}>
            <input type="tel" maxLength={32} {...register("phone")} />
          </Field>
          <Field label="Joining date" error={errors.joiningDate?.message} wide>
            <input type="date" {...register("joiningDate")} />
          </Field>
          <Field label="Gym membership plan" error={errors.planId?.message}>
            <select {...register("planId")}>
              <option value="">Select a plan</option>
              {options.data.membershipPlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {money(p.price)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Gym membership start date"
            error={errors.startDate?.message}
          >
            <input
              type="date"
              aria-label="Gym membership start date"
              {...register("startDate")}
            />
            {plan && values.startDate && (
              <small>
                Ends{" "}
                {dateLabel(
                  calculateEndDate(values.startDate, plan.duration, "DAY"),
                )}{" "}
                (inclusive)
              </small>
            )}
          </Field>
          {!options.data.membershipPlans.length && (
            <p className="text-muted plan-form-note">
              No active gym plans. Create or activate a membership plan before
              adding a member.
            </p>
          )}
          <Field
            label="Trainer (optional)"
            error={errors.trainerId?.message}
            wide={!values.trainerId}
          >
            <select
              {...register("trainerId", {
                onChange: () => setValue("ptPlanId", ""),
              })}
            >
              <option value="">No personal training</option>
              {options.data.trainers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          {values.trainerId && (
            <>
              <Field
                label="Personal training plan"
                error={errors.ptPlanId?.message}
              >
                <select {...register("ptPlanId")}>
                  <option value="">Select a PT plan</option>
                  {options.data.personalTrainingPlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {money(p.price)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Personal training start date"
                error={errors.ptStartDate?.message}
                wide
              >
                <input
                  type="date"
                  aria-label="Personal training start date"
                  {...register("ptStartDate")}
                />
                {pt && values.ptStartDate && (
                  <small>
                    Ends{" "}
                    {dateLabel(
                      calculateEndDate(values.ptStartDate, pt.duration, "DAY"),
                    )}{" "}
                    (inclusive)
                  </small>
                )}
              </Field>
            </>
          )}
          <Field label="Notes" error={errors.notes?.message} wide>
            <textarea maxLength={2000} {...register("notes")} />
          </Field>
          <p className="text-muted plan-form-note">
            Creates a profile and subscriptions together. Prices and fixed-day
            durations are verified by the server. Billing and payment collection
            are separate; no payment is recorded here.
          </p>
        </FormLayout>
      )}
    </Modal>
  );
}
