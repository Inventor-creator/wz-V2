import http from "../api";
import type {
  Database,
  User,
  MemberInput,
  Payment,
  BillingCharge,
  RoleAssignment,
  GymMembershipPlan,
  Trainer,
  PersonalTrainingPlan,
} from "../types/domain";
import { groupBy } from "./groupBy";
import { seed } from "../mocks/seed";
import { calculateEndDate, isMembershipExpired, today } from "./dates";
import { canAccess, roles } from "./permissions";
import { memberSchema, paymentSchema, planSchema } from "./validation";
export const MOCK_MODE =
  import.meta.env.DEV && import.meta.env.VITE_MOCK_API === "true";
let db = seed();
let session: User | null = null;
const uid = () => crypto.randomUUID();
const clone = <T>(v: T): T => structuredClone(v);
function permit(path: string) {
  if (!session || session.status !== "ACTIVE")
    throw new Error("Session expired. Please sign in again.");
  if (!canAccess(session.role, path))
    throw new Error("You do not have permission for this action.");
}
function scoped(): Database {
  if (!session) throw new Error("Session expired");
  if (session.role !== "GYM_TRAINER")
    return {
      ...db,
      accessAssignments:
        session.role === "SUPER_ADMIN" ? db.accessAssignments : [],
      payoutConfigurations:
        session.role === "GYM_RECEPTIONIST" ? [] : db.payoutConfigurations,
    };
  const trainingSubscriptions = db.trainingSubscriptions.filter(
    (s) => s.trainerId === session?.trainerId,
  );
  const ids = new Set(trainingSubscriptions.map((s) => s.memberId));
  return {
    ...db,
    members: db.members.filter((m) => ids.has(m.id)),
    trainers: db.trainers.filter((t) => t.id === session?.trainerId),
    trainingSubscriptions,
    personalTrainingPlans: db.personalTrainingPlans.filter(
      (p) => p.trainerId === session?.trainerId,
    ),
    gymSubscriptions: [],
    membershipPlans: [],
    invoices: [],
    payments: [],
    accessAssignments: [],
    payoutConfigurations: db.payoutConfigurations.filter(
      (p) => p.trainerId === session?.trainerId,
    ),
  };
}
async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  data?: unknown,
): Promise<T> {
  try {
    return (await http.request<T>({ method, url, data })).data;
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "response" in e &&
      (e.response as { status?: number })?.status === 401
    )
      window.dispatchEvent(new Event("session-expired"));
    throw e;
  }
}
async function action<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  data: unknown,
  fn: () => T,
): Promise<T> {
  if (!MOCK_MODE) return request(method, url, data);
  permit(path);
  return clone(fn());
}
export const auth = {
  async getCurrentUser(): Promise<User | null> {
    if (MOCK_MODE) return clone(session);
    const raw = await request<User>("GET", "/auth/me");
    if (!roles.includes(raw.role) || raw.status !== "ACTIVE")
      throw new Error(
        "Your backend session has no authorized role. Contact the administrator.",
      );
    return raw;
  },
  async demoLogin(email: string) {
    if (!MOCK_MODE) throw new Error("Demo is development-only");
    const a = db.accessAssignments.find(
      (a) => a.email === email && a.status === "ACTIVE",
    );
    if (!a) throw new Error("Email is not authorized");
    session = {
      id: a.id,
      name: a.name || a.email,
      email: a.email,
      role: a.role,
      status: a.status,
      trainerId: a.trainerId || undefined,
    };
    return clone(session);
  },
  async logout() {
    session = null;
    if (!MOCK_MODE)
      window.location.assign(http.defaults.baseURL + "/auth/logout");
  },
};
export const api = {
  snapshot: () =>
    MOCK_MODE
      ? Promise.resolve(clone(scoped()))
      : request<Database>("GET", "/gym/workspace"),
  members: {
    list: () =>
      MOCK_MODE
        ? Promise.resolve(clone(scoped().members))
        : request<Database["members"]>("GET", "/members"),
    get: (id: string) =>
      MOCK_MODE
        ? Promise.resolve(clone(scoped().members.find((m) => m.id === id)))
        : request<Database["members"][number]>("GET", "/members/" + id),
    create: (input: MemberInput) =>
      action("/members", "POST", "/members", input, () => {
        const v = memberSchema.parse(input);
        const plan = db.membershipPlans.find(
          (p) => p.id === v.planId && p.isActive,
        );
        if (!plan) throw new Error("Gym plan unavailable");
        const pt = db.personalTrainingPlans.find(
          (p) =>
            p.id === v.ptPlanId && p.trainerId === v.trainerId && p.isActive,
        );
        if (v.trainerId && !pt)
          throw new Error("PT plan does not belong to selected trainer");
        const id = uid();
        db.members.push({
          id,
          fullName: v.fullName,
          email: v.email,
          phone: v.phone,
          joiningDate: v.joiningDate,
          notes: v.notes,
          status: "ACTIVE",
        });
        db.gymSubscriptions.push({
          id: uid(),
          memberId: id,
          planId: plan.id,
          startDate: v.startDate,
          endDate: calculateEndDate(
            v.startDate,
            plan.duration,
            plan.durationUnit,
          ),
          priceAtPurchase: plan.price,
          status: "ACTIVE",
        });
        if (pt)
          db.trainingSubscriptions.push({
            id: uid(),
            memberId: id,
            trainerId: pt.trainerId,
            planId: pt.id,
            startDate: v.ptStartDate,
            endDate: calculateEndDate(
              v.ptStartDate,
              pt.duration,
              pt.durationUnit,
            ),
            priceAtPurchase: pt.price,
            status: "ACTIVE",
          });
        return id;
      }),
    update: (
      id: string,
      input: Pick<
        MemberInput,
        "fullName" | "email" | "phone" | "joiningDate" | "notes"
      >,
    ) =>
      action("/members", "PATCH", "/members/" + id, input, () => {
        const m = db.members.find((m) => m.id === id);
        if (!m) throw new Error("Member not found");
        Object.assign(m, input);
        return m;
      }),
    archive: (id: string) =>
      action("/members", "POST", `/members/${id}/archive`, {}, () => {
        const m = db.members.find((m) => m.id === id);
        if (m) m.status = "ARCHIVED";
        return m;
      }),
  },
  membershipPlans: {
    list: () =>
      MOCK_MODE
        ? Promise.resolve(clone(scoped().membershipPlans))
        : request<Database["membershipPlans"]>("GET", "/membership-plans"),
    create: (v: Omit<GymMembershipPlan, "id">) => savePlan(v),
    update: (id: string, v: Omit<GymMembershipPlan, "id">) => savePlan(v, id),
    archive: (id: string) =>
      action(
        "/membership-plans",
        "PATCH",
        "/membership-plans/" + id,
        { isActive: false },
        () => {
          const p = db.membershipPlans.find((p) => p.id === id);
          if (!p) throw new Error("Plan not found");
          p.isActive = false;
          return p;
        },
      ),
  },
  trainers: {
    list: () =>
      MOCK_MODE
        ? Promise.resolve(clone(scoped().trainers))
        : request<Trainer[]>("GET", "/trainers"),
    get: (id: string) =>
      MOCK_MODE
        ? Promise.resolve(clone(scoped().trainers.find((t) => t.id === id)))
        : request<Trainer>("GET", "/trainers/" + id),
    create: (v: Omit<Trainer, "id">) => saveTrainer(v),
    update: (id: string, v: Omit<Trainer, "id">) => saveTrainer(v, id),
  },
  personalTrainingPlans: {
    list: () =>
      MOCK_MODE
        ? Promise.resolve(clone(scoped().personalTrainingPlans))
        : request<PersonalTrainingPlan[]>("GET", "/personal-training-plans"),
    create: (v: Omit<PersonalTrainingPlan, "id">) =>
      savePlan(v, undefined, v.trainerId),
    update: (id: string, v: Omit<PersonalTrainingPlan, "id">) =>
      savePlan(v, id, v.trainerId),
    archive: (id: string) =>
      action(
        "/trainers",
        "PATCH",
        "/personal-training-plans/" + id,
        { isActive: false },
        () => {
          const p = db.personalTrainingPlans.find((p) => p.id === id);
          if (!p) throw new Error("Plan not found");
          p.isActive = false;
          return p;
        },
      ),
  },
  billing: {
    preview: () =>
      action("/members", "POST", "/billing/preview", {}, billingPreview),
    run: (key: string) =>
      action(
        "/members",
        "POST",
        "/billing/run",
        { idempotencyKey: key },
        () => {
          if (billingKeys.has(key)) return 0;
          const charges = billingPreview();
          const grouped = groupBy(charges, (c) => c.memberId);
          for (const [memberId, items] of grouped) {
            const id = "INV-" + uid().slice(0, 8);
            const total = items.reduce((s, c) => s + c.amount, 0);
            db.invoices.push({
              id,
              memberId,
              invoiceDate: today(),
              dueDate: today(),
              totalAmount: total,
              outstandingAmount: total,
              status: "UNPAID",
              lineItems: items.map((c) => ({ ...c, id: uid(), invoiceId: id })),
            });
          }
          billingKeys.add(key);
          return grouped.size;
        },
      ),
  },
  invoices: {
    list: () =>
      action("/fees-due", "GET", "/invoices", undefined, () => db.invoices),
    get: (id: string) =>
      action("/fees-due", "GET", "/invoices/" + id, undefined, () =>
        db.invoices.find((i) => i.id === id),
      ),
  },
  payments: {
    list: () =>
      action("/fees-due", "GET", "/payments", undefined, () => db.payments),
    create: (v: Omit<Payment, "id" | "memberId">) =>
      action("/fees-due", "POST", "/payments", v, () => {
        const invoice = db.invoices.find((i) => i.id === v.invoiceId);
        if (!invoice) throw new Error("Invoice not found");
        paymentSchema(invoice.outstandingAmount).parse(v);
        if (v.paymentDate > today())
          throw new Error("Payment cannot be in the future");
        const payment = {
          ...v,
          id: "PAY-" + uid().slice(0, 8),
          memberId: invoice.memberId,
        };
        invoice.outstandingAmount =
          Math.round((invoice.outstandingAmount - v.amount) * 100) / 100;
        invoice.status = invoice.outstandingAmount === 0 ? "PAID" : "PARTIAL";
        db.payments.push(payment);
        return payment;
      }),
  },
  accessAssignments: {
    delete: (id: string) =>
      action(
        "/access-management",
        "DELETE",
        "/access-assignments/" + id,
        undefined,
        () => {
          const assignment = db.accessAssignments.find((a) => a.id === id);
          if (!assignment) throw new Error("Access assignment not found");
          if (
            assignment.isPermanent ||
            (assignment.role === "SUPER_ADMIN" &&
              db.accessAssignments.filter(
                (a) => a.role === "SUPER_ADMIN" && a.status === "ACTIVE",
              ).length <= 1)
          )
            throw new Error(
              "Cannot delete the permanent or last active Super Admin",
            );
          db.accessAssignments = db.accessAssignments.filter(
            (a) => a.id !== id,
          );
          if (id === session?.id) {
            session = null;
            window.dispatchEvent(new Event("session-expired"));
          }
        },
      ),
    trainerOptions: () =>
      action(
        "/access-management",
        "GET",
        "/access-assignments/trainers",
        undefined,
        () => db.trainers.filter((t) => t.isActive),
      ),
    list: () =>
      action(
        "/access-management",
        "GET",
        "/access-assignments",
        undefined,
        () => db.accessAssignments,
      ),
    create: (v: Pick<RoleAssignment, "email" | "role" | "trainerId">) =>
      saveAccess(v),
    update: (id: string, v: Partial<RoleAssignment>) => saveAccess(v, id),
    revoke: (id: string) => saveAccess({ status: "REVOKED" }, id),
  },
  payouts: {
    update: (trainerId: string, commissionRate: number) =>
      action(
        "/finances",
        "PATCH",
        "/trainers/" + trainerId + "/payout",
        { commissionRate },
        () => {
          if (commissionRate < 0 || commissionRate > 100)
            throw new Error("Commission must be 0–100");
          db.payoutConfigurations = db.payoutConfigurations.filter(
            (p) => p.trainerId !== trainerId,
          );
          db.payoutConfigurations.push({
            trainerId,
            payoutType: "COMMISSION",
            commissionRate,
          });
          return true;
        },
      ),
  },
  finances: {
    summary: () =>
      action("/finances", "GET", "/finances/summary", undefined, () => ({
        invoices: db.invoices,
        payments: db.payments,
      })),
    trends: () =>
      action(
        "/finances",
        "GET",
        "/finances/trends",
        undefined,
        () => db.payments,
      ),
    payouts: () =>
      action(
        "/finances",
        "GET",
        "/finances/payouts",
        undefined,
        () => db.payoutConfigurations,
      ),
  },
};
const billingKeys = new Set<string>();
function billingPreview(): BillingCharge[] {
  const billed = new Set(
    db.invoices.flatMap((i) => i.lineItems.map((l) => l.subscriptionId)),
  );
  const active = new Set(
    db.members.filter((m) => m.status === "ACTIVE").map((m) => m.id),
  );
  return [
    ...db.gymSubscriptions.map((s) => ({ ...s, feeType: "GYM" as const })),
    ...db.trainingSubscriptions.map((s) => ({ ...s, feeType: "PT" as const })),
  ]
    .filter(
      (s) =>
        s.status === "ACTIVE" &&
        active.has(s.memberId) &&
        isMembershipExpired(s.endDate) &&
        !billed.has(s.id),
    )
    .map((s) => ({
      subscriptionId: s.id,
      memberId: s.memberId,
      feeType: s.feeType,
      description:
        (s.feeType === "GYM"
          ? db.membershipPlans
          : db.personalTrainingPlans
        ).find((p) => p.id === s.planId)?.name || "Subscription",
      amount: s.priceAtPurchase,
    }));
}
function savePlan(
  v: Omit<GymMembershipPlan, "id">,
  id?: string,
  trainerId?: string,
) {
  return action(
    trainerId ? "/trainers" : "/membership-plans",
    id ? "PATCH" : "POST",
    `/${trainerId ? "personal-training-plans" : "membership-plans"}${id ? "/" + id : ""}`,
    v,
    () => {
      planSchema.parse(v);
      const list = trainerId ? db.personalTrainingPlans : db.membershipPlans;
      const item = {
        ...v,
        id: id || uid(),
        ...(trainerId ? { trainerId } : {}),
      };
      const existing = list.find((p) => p.id === id);
      if (existing) Object.assign(existing, item);
      else if (trainerId) db.personalTrainingPlans.push({ ...item, trainerId });
      else db.membershipPlans.push(item);
      return item;
    },
  );
}
function saveTrainer(v: Omit<Trainer, "id">, id?: string) {
  return action(
    "/trainers",
    id ? "PATCH" : "POST",
    "/trainers" + (id ? "/" + id : ""),
    v,
    () => {
      const item = { ...v, id: id || uid() };
      const t = db.trainers.find((t) => t.id === id);
      if (t) Object.assign(t, item);
      else db.trainers.push(item);
      return item;
    },
  );
}
function saveAccess(v: Partial<RoleAssignment>, id?: string) {
  return action(
    "/access-management",
    id ? "PATCH" : "POST",
    "/access-assignments" + (id ? "/" + id : ""),
    v,
    () => {
      const old = db.accessAssignments.find((a) => a.id === id);
      const next = { ...old, ...v };
      if (next.role === "GYM_TRAINER" && !next.trainerId)
        throw new Error("Link a trainer profile");
      if (
        old?.role === "SUPER_ADMIN" &&
        old.status === "ACTIVE" &&
        (next.role !== "SUPER_ADMIN" || next.status === "REVOKED") &&
        db.accessAssignments.filter(
          (a) => a.role === "SUPER_ADMIN" && a.status === "ACTIVE",
        ).length <= 1
      )
        throw new Error("Cannot remove the last active Super Admin");
      if (
        !id &&
        db.accessAssignments.some(
          (a) => a.email.toLowerCase() === v.email?.toLowerCase(),
        )
      )
        throw new Error("Email already authorized");
      const assignment: RoleAssignment = old || {
        id: uid(),
        email: v.email!,
        role: v.role!,
        trainerId: v.trainerId,
        status: "ACTIVE",
        grantedBy: session!.name,
        grantedAt: today(),
      };
      if (old) Object.assign(old, v);
      else db.accessAssignments.push(assignment);
      if (
        id === session?.id &&
        (v.role !== undefined ||
          v.status !== undefined ||
          v.trainerId !== undefined)
      ) {
        session = null;
        window.dispatchEvent(new Event("session-expired"));
      }
      return assignment;
    },
  );
}
export function resetMock() {
  db = seed();
  session = null;
  billingKeys.clear();
}
