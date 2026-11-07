import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import type { Trainer, RoleAssignment } from "../../types/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { roles, roleLabel } from "../../lib/permissions";
import { dateLabel } from "../../lib/dates";
import { api } from "../../lib/api";
import {
  PageHeader,
  DataTable,
  StatusBadge,
  ConfirmDialog,
  Modal,
  FormLayout,
  Field,
  LoadingSkeleton,
  ErrorState,
} from "../../components/ui";
const schema = z
  .object({ email: z.email(), role: z.enum(roles), trainerId: z.string() })
  .refine((v) => v.role !== "GYM_TRAINER" || !!v.trainerId, {
    path: ["trainerId"],
    message: "Select a trainer profile",
  });
type Values = z.infer<typeof schema>;
function useAccessMutation<T>(
  fn: (value: T) => Promise<unknown>,
  done?: () => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["access-assignments"] });
      done?.();
    },
  });
}
function AccessForm({
  assignment,
  trainers,
  onClose,
}: {
  assignment?: RoleAssignment;
  trainers: Trainer[];
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState<Values | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      email: assignment?.email || "",
      role: assignment?.role || "GYM_RECEPTIONIST",
      trainerId: assignment?.trainerId || "",
    },
  });
  const selectedRole = useWatch({ control, name: "role" });
  const save = useAccessMutation((values: Values) => {
    const v = {
      ...values,
      trainerId: values.role === "GYM_TRAINER" ? values.trainerId : "",
    };
    return assignment
      ? api.accessAssignments.update(assignment.id, v)
      : api.accessAssignments.create(v);
  }, onClose);
  return (
    <Modal
      title={assignment ? "Change authorized access" : "Authorize an email"}
      onClose={onClose}
    >
      <FormLayout
        onSubmit={handleSubmit((v) => setConfirmation(v))}
        pending={save.isPending}
        error={save.error}
        onClose={onClose}
      >
        <Field label="Google email address" error={errors.email?.message}>
          <input type="email" readOnly={!!assignment} {...register("email")} />
        </Field>
        <Field label="Role">
          <select {...register("role")}>
            {roles
              .filter((r) => r !== "SUPER_ADMIN")
              .map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
          </select>
        </Field>
        {selectedRole === "GYM_TRAINER" && (
          <Field
            label="Linked trainer profile"
            error={errors.trainerId?.message}
          >
            <select {...register("trainerId")}>
              <option value="">Select trainer</option>
              {trainers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="text-muted">
          Authorization takes effect on the backend. The user may not have
          signed in yet.
        </p>
      </FormLayout>
      {confirmation && (
        <div className="modal-body notice">
          <p>
            Confirm granting <strong>{roleLabel(confirmation.role)}</strong>{" "}
            access to {confirmation.email}?
          </p>
          <button
            className="btn primary"
            disabled={save.isPending}
            onClick={() => save.mutate(confirmation)}
          >
            Confirm privileged change
          </button>
          <button className="btn" onClick={() => setConfirmation(null)}>
            Go back
          </button>
        </div>
      )}
    </Modal>
  );
}
export function AccessPage() {
  const q = useQuery({
    queryKey: ["access-assignments"],
    queryFn: api.accessAssignments.list,
  });
  const trainers = useQuery({
    queryKey: ["access-trainer-options"],
    queryFn: api.accessAssignments.trainerOptions,
  });
  const [edit, setEdit] = useState<RoleAssignment | null | undefined>();
  const [deleting, setDeleting] = useState<RoleAssignment | null>(null);
  const remove = useAccessMutation(
    (a: RoleAssignment) => api.accessAssignments.delete(a.id),
    () => setDeleting(null),
  );
  if (q.isPending) return <LoadingSkeleton />;
  if (!q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  return (
    <>
      <PageHeader
        title="Access management"
        description="The right access, for the right people."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          + Add Authorized Email
        </button>
      </PageHeader>
      {trainers.error && (
        <ErrorState
          error={trainers.error}
          retry={() => void trainers.refetch()}
        />
      )}
      <div className="notice">
        Only authorized Google accounts can enter this workspace. The permanent
        Super Admin cannot be changed. Deleting a grant removes that role, not
        the user account. Audit history is retained. Frontend guards do not
        replace backend authorization.
      </div>
      <DataTable
        rows={q.data}
        columns={[
          {
            label: "Email / Full name",
            render: (a) => (
              <>
                {a.email}
                <small>{a.name || "Not signed in yet"}</small>
              </>
            ),
          },
          { label: "Role", render: (a) => roleLabel(a.role) },
          {
            label: "Status",
            render: (a) => (
              <>
                <StatusBadge status={a.status} />
                {a.accountActive === false && <small>Account disabled</small>}
              </>
            ),
          },
          { label: "Granted on", render: (a) => dateLabel(a.grantedAt) },
          { label: "Granted by", render: (a) => a.grantedBy },
          {
            label: "Actions",
            render: (a) =>
              a.isPermanent ? (
                <span className="text-muted">Permanent · protected</span>
              ) : (
                <div className="row-actions">
                  <button onClick={() => setEdit(a)}>
                    Change role / Link trainer
                  </button>
                  <button onClick={() => setDeleting(a)}>Delete</button>
                </div>
              ),
          },
        ]}
      />
      {edit !== undefined && (
        <AccessForm
          assignment={edit || undefined}
          trainers={trainers.data || []}
          onClose={() => setEdit(undefined)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete access assignment?"
          description={`Delete the ${roleLabel(deleting.role)} grant for ${deleting.email}? This cannot be undone. Other role grants remain. The user account, financial records and audit trail will be kept.`}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting)}
          pending={remove.isPending}
          error={remove.error}
          confirmLabel="Delete access"
          danger
        />
      )}
    </>
  );
}
