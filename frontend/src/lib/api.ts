import http from "../api";
import type {
  Database,
  User,
  MemberInput,
  Member,
  MemberProfileInput,
  MemberDirectoryData,
  MemberDirectoryEntry,
  MemberDetailsData,
  MemberOptions,
  MemberSubscription,
  MemberDeletion,
  Payment,
  BillingCharge,
  RoleAssignment,
  GymMembershipPlan,
  MembershipPlanDeletion,
  Trainer,
  TrainerInput,
  TrainerDirectoryEntry,
  TrainerDetailsData,
  CommissionRule,
  CommissionSchedule,
  PersonalTrainingPlan,
  AccessGrantInput,
  TrainerDashboardData,
  TrainerDashboardFilters,
  TrainerMemberData,
  TrainingDashboardRow,
} from "../types/domain";
import { groupBy } from "./groupBy";
import { seed } from "../mocks/seed";
import {
  calculateEndDate,
  isMembershipExpired,
  today,
  calculateDaysRemaining,
  getMembershipStatus,
} from "./dates";
import { canAccess, roles } from "./permissions";
import {
  memberSchema,
  memberProfileSchema,
  paymentSchema,
  planSchema,
  trainerProfileSchema,
} from "./validation";
export const MOCK_MODE =
  import.meta.env.DEV && import.meta.env.VITE_MOCK_API === "true";
let db = seed();
const deletedMembershipPlans = new Set<string>();
const deletedTrainerPlans = new Set<string>();
const deletedMembers = new Set<string>();
const memberRequests = new Map<
  string,
  { actor: string; fields: string; result: Member }
>();
let session: User | null = null;
const uid = () => crypto.randomUUID();
const clone = <T>(v: T): T => structuredClone(v);
function initialCommissionRules() {
  return new Map(
    db.payoutConfigurations.map((config) => [
      config.trainerId,
      [
        {
          id: "demo-rule-" + config.trainerId,
          kind:
            config.payoutType === "COMMISSION"
              ? ("percent" as const)
              : ("fixed" as const),
          value:
            config.payoutType === "COMMISSION"
              ? config.commissionRate
              : config.fixedAmount,
          effectiveFrom: "2020-01-01",
          effectiveUntil: null,
        },
      ] as CommissionRule[],
    ]),
  );
}
let mockCommissionRules = initialCommissionRules();
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
    personalTrainingPlans: db.personalTrainingPlans.filter((p) =>
      trainingSubscriptions.some((s) => s.planId === p.id),
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
      window.location.href = http.defaults.baseURL + "/auth/logout";
  },
};
export const api = {
  trainerDashboard: {
    options: () =>
      MOCK_MODE
        ? action(
            "/trainer",
            "GET",
            "/trainer/options",
            undefined,
            () => scoped().trainers,
          )
        : request<Trainer[]>("GET", "/trainer/options"),
    get: (filters: TrainerDashboardFilters = {}) => {
      if (MOCK_MODE)
        return action("/trainer", "GET", "/trainer/dashboard", undefined, () =>
          mockTrainerDashboard(filters),
        );
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== "") params.set(key, String(value));
      });
      return request<TrainerDashboardData>(
        "GET",
        "/trainer/dashboard?" + params.toString(),
      );
    },
    member: (id: string, trainerId?: string) => {
      if (!MOCK_MODE)
        return request<TrainerMemberData>(
          "GET",
          `/trainer/members/${encodeURIComponent(id)}` +
            (trainerId ? "?trainerId=" + encodeURIComponent(trainerId) : ""),
        );
      return action(
        "/trainer",
        "GET",
        "/trainer/members/" + id,
        undefined,
        () => {
          const dashboard = mockTrainerDashboard({
            trainerId,
            pageSize: 100000,
          });
          const history = dashboard.rows.filter((r) => r.memberId === id);
          const member = scoped().members.find((m) => m.id === id);
          if (!history.length || !member)
            throw new Error("Assigned member not found");
          return {
            member: {
              id: member.id,
              fullName: member.fullName,
              email: member.email,
              phone: member.phone,
              joiningDate: member.joiningDate,
            },
            trainingHistory: history,
          };
        },
      );
    },
  },
  snapshot: () =>
    MOCK_MODE
      ? Promise.resolve(clone(scoped()))
      : request<Database>("GET", "/gym/workspace"),
  members: {
    list: () =>
      action<MemberDirectoryData>(
        "/members",
        "GET",
        "/members",
        undefined,
        () => {
          const members = db.members
            .filter((m) => !deletedMembers.has(m.id))
            .map(mockMemberDirectoryEntry);
          return {
            members,
            summary: {
              activeMembers: members.filter((m) =>
                ["Active", "Expiring Soon"].includes(m.membershipStatus),
              ).length,
              expiringSoon: members.filter(
                (m) => m.membershipStatus === "Expiring Soon",
              ).length,
              expiredMemberships: members.filter(
                (m) => m.membershipStatus === "Expired",
              ).length,
              outstandingAmount: db.invoices.reduce(
                (sum, i) => sum + i.outstandingAmount,
                0,
              ),
            },
          };
        },
      ),
    options: () =>
      action<MemberOptions>(
        "/members",
        "GET",
        "/members/options",
        undefined,
        () => ({
          membershipPlans: db.membershipPlans.filter(
            (p) => p.isActive && !deletedMembershipPlans.has(p.id),
          ),
          personalTrainingPlans: db.personalTrainingPlans.filter(
            (p) => p.isActive && !deletedTrainerPlans.has(p.id),
          ),
          trainers: db.trainers.filter((t) => t.isActive),
        }),
      ),
    get: (id: string) =>
      action<MemberDetailsData>(
        "/members",
        "GET",
        "/members/" + id,
        undefined,
        () => {
          const member = db.members.find(
            (m) => m.id === id && !deletedMembers.has(id),
          );
          if (!member) throw new Error("Member not found");
          return {
            member,
            subscriptions: mockMemberSubscriptions(id),
            invoices: db.invoices
              .filter((i) => i.memberId === id)
              .map((i) => ({
                id: i.id,
                invoiceNumber: i.id,
                invoiceDate: i.invoiceDate,
                dueDate: i.dueDate,
                status: "issued" as const,
                totalAmount: i.totalAmount,
                allocatedAmount: i.totalAmount - i.outstandingAmount,
                outstandingAmount: i.outstandingAmount,
                paymentStatus: i.status,
              })),
            payments: db.payments
              .filter((p) => p.memberId === id)
              .map((p) => ({
                id: p.id,
                invoiceId: p.invoiceId,
                amount: p.amount,
                method: p.method,
                status: "completed" as const,
                receivedAt: p.paymentDate,
                reference: p.transactionReference,
              })),
          };
        },
      ),
    create: (input: MemberInput, requestKey: string = uid()) =>
      action<Member>(
        "/members",
        "POST",
        "/members",
        { ...input, requestKey },
        () => {
          const v = memberSchema.parse(input);
          const fields = JSON.stringify({
            ...v,
            ptStartDate: v.trainerId ? v.ptStartDate : "",
          });
          const previous = memberRequests.get(requestKey);
          if (previous) {
            if (previous.actor !== session!.id || previous.fields !== fields)
              throw new Error(
                "Request key already used for different member details",
              );
            return previous.result;
          }
          const plan = db.membershipPlans.find(
            (p) =>
              p.id === v.planId &&
              p.isActive &&
              !deletedMembershipPlans.has(p.id),
          );
          if (!plan) throw new Error("Gym plan unavailable");
          const pt = db.personalTrainingPlans.find(
            (p) =>
              p.id === v.ptPlanId &&
              p.isActive &&
              !deletedTrainerPlans.has(p.id),
          );
          if (
            v.trainerId &&
            (!pt ||
              !db.trainers.some((t) => t.id === v.trainerId && t.isActive))
          )
            throw new Error("Choose an active trainer and available PT plan");
          const id = uid();
          const member: Member = {
            id,
            memberNumber: "WZ-" + id.replaceAll("-", "").toUpperCase(),
            fullName: v.fullName,
            email: v.email,
            phone: normalizeContactPhone(v.phone),
            joiningDate: v.joiningDate,
            notes: v.notes,
            status: "ACTIVE",
          };
          db.members.push(member);
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
              trainerId: v.trainerId,
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
          memberRequests.set(requestKey, {
            actor: session!.id,
            fields,
            result: clone(member),
          });
          return member;
        },
      ).then((member) => member.id),
    update: (id: string, input: Partial<MemberProfileInput>) =>
      action("/members", "PATCH", "/members/" + id, input, () => {
        const m = db.members.find((m) => m.id === id);
        if (!m || deletedMembers.has(id)) throw new Error("Member not found");
        const parsed = memberProfileSchema.parse({
          ...m,
          notes: m.notes ?? "",
          ...input,
        });
        const first = mockMemberSubscriptions(id)
          .map((s) => s.startDate)
          .sort()[0];
        if (
          input.joiningDate &&
          input.joiningDate !== m.joiningDate &&
          first &&
          input.joiningDate > first
        )
          throw new Error(
            "Joining date cannot be after an existing subscription start",
          );
        Object.assign(m, parsed, {
          phone: normalizeContactPhone(parsed.phone),
        });
        return m;
      }),
    delete: (id: string) =>
      action<MemberDeletion>(
        "/members",
        "DELETE",
        `/members/${id}`,
        undefined,
        () => {
          const m = db.members.find((m) => m.id === id);
          if (!m || deletedMembers.has(id)) throw new Error("Member not found");
          const history =
            db.gymSubscriptions.some((s) => s.memberId === id) ||
            db.trainingSubscriptions.some((s) => s.memberId === id) ||
            db.invoices.some((i) => i.memberId === id);
          if (history) {
            m.status = "ARCHIVED";
            deletedMembers.add(id);
          } else db.members = db.members.filter((m) => m.id !== id);
          return { id, mode: history ? "REMOVED_FROM_DIRECTORY" : "DELETED" };
        },
      ),
  },
  membershipPlans: {
    list: () =>
      action("/membership-plans", "GET", "/membership-plans", undefined, () =>
        db.membershipPlans
          .filter((p) => !deletedMembershipPlans.has(p.id))
          .map((p) => ({
            ...p,
            activeMembersCount: new Set(
              db.gymSubscriptions
                .filter(
                  (s) =>
                    s.planId === p.id &&
                    s.status === "ACTIVE" &&
                    s.startDate <= today() &&
                    s.endDate >= today() &&
                    db.members.some(
                      (m) => m.id === s.memberId && m.status === "ACTIVE",
                    ),
                )
                .map((s) => s.memberId),
            ).size,
            hasHistory: db.gymSubscriptions.some((s) => s.planId === p.id),
          })),
      ),
    delete: (id: string) =>
      action(
        "/membership-plans",
        "DELETE",
        "/membership-plans/" + id,
        undefined,
        () => {
          const p = db.membershipPlans.find(
            (p) => p.id === id && !deletedMembershipPlans.has(id),
          );
          if (!p) throw new Error("Plan not found");
          const history = db.gymSubscriptions.some((s) => s.planId === id);
          if (history) {
            p.isActive = false;
            deletedMembershipPlans.add(id);
          } else
            db.membershipPlans = db.membershipPlans.filter((p) => p.id !== id);
          const result: MembershipPlanDeletion = {
            id,
            mode: history ? "REMOVED_FROM_CATALOG" : "DELETED",
          };
          return result;
        },
      ),
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
          if (!p || deletedMembershipPlans.has(id))
            throw new Error("Plan not found");
          p.isActive = false;
          return p;
        },
      ),
  },
  trainers: {
    list: () =>
      action<TrainerDirectoryEntry[]>(
        "/trainers",
        "GET",
        "/trainers",
        undefined,
        () => db.trainers.map(trainerDirectoryEntry),
      ),
    get: (id: string) =>
      action<TrainerDetailsData>(
        "/trainers",
        "GET",
        "/trainers/" + id,
        undefined,
        () => {
          const trainer = db.trainers.find((t) => t.id === id);
          if (!trainer) throw new Error("Trainer not found");
          return {
            trainer: trainerDirectoryEntry(trainer),
            assignments: db.trainingSubscriptions
              .filter((s) => s.trainerId === id)
              .map((s) => {
                const member = db.members.find((m) => m.id === s.memberId)!;
                return {
                  id: s.id,
                  memberId: member.id,
                  memberName: member.fullName,
                  memberEmail: member.email,
                  memberPhone: member.phone,
                  planId: s.planId,
                  planName:
                    db.personalTrainingPlans.find((p) => p.id === s.planId)
                      ?.name ?? "PT plan",
                  startDate: s.startDate,
                  endDate: s.endDate,
                  priceAtPurchase: s.priceAtPurchase,
                  status:
                    s.status === "CANCELLED"
                      ? ("Cancelled" as const)
                      : s.startDate > today()
                        ? ("Upcoming" as const)
                        : s.endDate < today()
                          ? ("Expired" as const)
                          : ("Active" as const),
                };
              })
              .sort((a, b) => b.startDate.localeCompare(a.startDate)),
            ...(session?.role === "GYM_RECEPTIONIST"
              ? {}
              : { payoutRules: mockCommissionRules.get(id) ?? [] }),
          };
        },
      ),
    create: (v: TrainerInput) => saveTrainer(v),
    update: (id: string, v: Partial<TrainerInput>) => saveTrainer(v, id),
    scheduleCommission: (id: string, v: CommissionSchedule) =>
      action<CommissionRule>(
        "/finances",
        "POST",
        "/trainers/" + id + "/commission-rules",
        v,
        () => {
          if (!db.trainers.some((t) => t.id === id))
            throw new Error("Trainer not found");
          if (
            !Number.isFinite(v.commissionRate) ||
            v.commissionRate < 0 ||
            v.commissionRate > 100 ||
            Math.abs(
              v.commissionRate * 100 - Math.round(v.commissionRate * 100),
            ) > 1e-8 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(v.effectiveFrom) ||
            calculateEndDate(v.effectiveFrom, 1, "DAY") !== v.effectiveFrom ||
            v.effectiveFrom <= today() ||
            (v.effectiveUntil &&
              (!/^\d{4}-\d{2}-\d{2}$/.test(v.effectiveUntil) ||
                calculateEndDate(v.effectiveUntil, 1, "DAY") !==
                  v.effectiveUntil ||
                v.effectiveUntil < v.effectiveFrom))
          )
            throw new Error("Choose a valid future commission period and rate");
          const rules = mockCommissionRules.get(id) ?? [];
          const overlapping = rules.filter(
            (r) =>
              r.effectiveFrom <= (v.effectiveUntil || "9999-12-31") &&
              (!r.effectiveUntil || r.effectiveUntil >= v.effectiveFrom),
          );
          if (
            overlapping.length > 1 ||
            overlapping.some((r) => r.effectiveFrom > today())
          )
            throw new Error(
              "Overlapping or already scheduled rules require review",
            );
          const previousEnd = calculateEndDate(v.effectiveFrom, 1, "DAY");
          // Subtract one calendar day, rather than approximate date arithmetic.
          const dayBefore = new Date(previousEnd + "T00:00:00Z");
          dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
          for (const rule of overlapping)
            rule.effectiveUntil = dayBefore.toISOString().slice(0, 10);
          const rule: CommissionRule = {
            id: uid(),
            kind: "percent",
            value: v.commissionRate,
            effectiveFrom: v.effectiveFrom,
            effectiveUntil: v.effectiveUntil || null,
          };
          mockCommissionRules.set(id, [...rules, rule]);
          return rule;
        },
      ),
  },
  personalTrainingPlans: {
    list: () =>
      action<PersonalTrainingPlan[]>(
        "/personal-training-plans",
        "GET",
        "/personal-training-plans",
        undefined,
        () =>
          db.personalTrainingPlans
            .filter((p) => !deletedTrainerPlans.has(p.id))
            .map((p) => ({
              ...p,
              activeMembersCount: new Set(
                db.trainingSubscriptions
                  .filter(
                    (s) =>
                      s.planId === p.id &&
                      s.status !== "CANCELLED" &&
                      s.startDate <= today() &&
                      s.endDate >= today() &&
                      db.members.some(
                        (m) => m.id === s.memberId && m.status === "ACTIVE",
                      ),
                  )
                  .map((s) => s.memberId),
              ).size,
              hasHistory: db.trainingSubscriptions.some(
                (s) => s.planId === p.id,
              ),
            })),
      ),
    create: (v: Omit<PersonalTrainingPlan, "id">) =>
      savePlan(v, undefined, true),
    update: (id: string, v: Omit<PersonalTrainingPlan, "id">) =>
      savePlan(v, id, true),
    delete: (id: string) =>
      action(
        "/personal-training-plans",
        "DELETE",
        "/personal-training-plans/" + id,
        undefined,
        () => {
          const p = db.personalTrainingPlans.find(
            (p) => p.id === id && !deletedTrainerPlans.has(id),
          );
          if (!p) throw new Error("Plan not found");
          const history = db.trainingSubscriptions.some((s) => s.planId === id);
          if (history) {
            p.isActive = false;
            deletedTrainerPlans.add(id);
          } else
            db.personalTrainingPlans = db.personalTrainingPlans.filter(
              (p) => p.id !== id,
            );
          const result: MembershipPlanDeletion = {
            id,
            mode: history ? "REMOVED_FROM_CATALOG" : "DELETED",
          };
          return result;
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
    create: (v: AccessGrantInput) => saveAccess(v),
    update: (
      id: string,
      v: Partial<RoleAssignment> & {
        newTrainer?: AccessGrantInput["newTrainer"];
      },
    ) => saveAccess(v, id),
    revoke: (id: string) => saveAccess({ status: "REVOKED" }, id),
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
        s.priceAtPurchase > 0 &&
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
  training = false,
) {
  return action(
    training ? "/personal-training-plans" : "/membership-plans",
    id ? "PATCH" : "POST",
    `/${training ? "personal-training-plans" : "membership-plans"}${id ? "/" + id : ""}`,
    v,
    () => {
      const parsed = planSchema.parse(v);
      const list = training ? db.personalTrainingPlans : db.membershipPlans;
      const deleted = training ? deletedTrainerPlans : deletedMembershipPlans;
      if (v.durationUnit !== "DAY")
        throw new Error("Plans use fixed calendar days");
      if (id && deleted.has(id)) throw new Error("Plan not found");
      if (list.some((p) => p.id !== id && p.name === v.name.trim()))
        throw new Error(
          "A plan with this name already exists, including retained history",
        );
      if (id && !list.some((p) => p.id === id))
        throw new Error("Plan not found");
      const item = {
        ...parsed,
        id: id || uid(),
      };
      const existing = list.find((p) => p.id === id);
      if (existing) Object.assign(existing, item);
      else if (training) db.personalTrainingPlans.push(item);
      else db.membershipPlans.push(item);
      return item;
    },
  );
}
function normalizeContactPhone(value: string) {
  const phone = value.replace(/[ -]/g, "");
  return phone.length === 10 && !phone.startsWith("+") ? "+91" + phone : phone;
}
function mockMemberSubscriptions(id: string): MemberSubscription[] {
  return [
    ...db.gymSubscriptions
      .filter((s) => s.memberId === id)
      .map((s) => ({
        ...s,
        type: "GYM" as const,
        trainerId: null as string | null,
      })),
    ...db.trainingSubscriptions
      .filter((s) => s.memberId === id)
      .map((s) => ({ ...s, type: "PT" as const })),
  ].map((s) => ({
    id: s.id,
    type: s.type,
    planId: s.planId,
    planName:
      (s.type === "GYM" ? db.membershipPlans : db.personalTrainingPlans).find(
        (p) => p.id === s.planId,
      )?.name ?? "Plan",
    trainerId: s.trainerId,
    trainerName: db.trainers.find((t) => t.id === s.trainerId)?.name ?? null,
    startDate: s.startDate,
    endDate: s.endDate,
    priceAtPurchase: s.priceAtPurchase,
    daysRemaining: calculateDaysRemaining(s.endDate),
    status:
      s.status === "CANCELLED"
        ? "Cancelled"
        : s.startDate > today()
          ? "Upcoming"
          : getMembershipStatus(s.endDate),
  }));
}
function mockMemberDirectoryEntry(member: Member): MemberDirectoryEntry {
  const subs = mockMemberSubscriptions(member.id).filter(
    (s) => s.status !== "Cancelled",
  );
  const rank = (s: MemberSubscription) =>
    s.startDate > today() ? 1 : s.endDate < today() ? 2 : 0;
  const choose = (type: "GYM" | "PT") =>
    subs
      .filter((s) => s.type === type)
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (rank(a) === 1 ? a.startDate.localeCompare(b.startDate) : 0) ||
          b.endDate.localeCompare(a.endDate) ||
          b.id.localeCompare(a.id),
      )[0] ?? null;
  const gym = choose("GYM");
  return {
    ...member,
    gym,
    pt: choose("PT"),
    membershipStatus:
      member.status === "ARCHIVED" ? "Archived" : (gym?.status ?? "No plan"),
    outstandingAmount: db.invoices
      .filter((i) => i.memberId === member.id)
      .reduce((sum, i) => sum + i.outstandingAmount, 0),
  };
}
function trainerDirectoryEntry(trainer: Trainer): TrainerDirectoryEntry {
  const history = db.trainingSubscriptions.filter(
    (s) => s.trainerId === trainer.id,
  );
  return {
    ...trainer,
    assignedMembersCount: new Set(history.map((s) => s.memberId)).size,
    activeMembersCount: new Set(
      history
        .filter(
          (s) =>
            s.status !== "CANCELLED" &&
            s.startDate <= today() &&
            s.endDate >= today() &&
            db.members.some(
              (m) => m.id === s.memberId && m.status === "ACTIVE",
            ),
        )
        .map((s) => s.memberId),
    ).size,
    hasLoginAccess: db.accessAssignments.some(
      (a) =>
        a.role === "GYM_TRAINER" &&
        a.trainerId === trainer.id &&
        a.status === "ACTIVE" &&
        a.accountActive !== false,
    ),
  };
}
function saveTrainer(v: Partial<TrainerInput>, id?: string) {
  return action(
    "/trainers",
    id ? "PATCH" : "POST",
    "/trainers" + (id ? "/" + id : ""),
    v,
    () => {
      const t = db.trainers.find((t) => t.id === id);
      if (id && !t) throw new Error("Trainer not found");
      const parsed = trainerProfileSchema.parse(t ? { ...t, ...v } : v);
      let phone = parsed.phone.replace(/[ -]/g, "");
      if (phone.length === 10 && !phone.startsWith("+")) phone = "+91" + phone;
      const item = { ...parsed, phone, id: id || uid() };
      if (t) Object.assign(t, item);
      else db.trainers.push(item);
      return trainerDirectoryEntry(item);
    },
  );
}
function saveAccess(
  input: Partial<RoleAssignment> & {
    newTrainer?: AccessGrantInput["newTrainer"];
  },
  id?: string,
) {
  return action(
    "/access-management",
    id ? "PATCH" : "POST",
    "/access-assignments" + (id ? "/" + id : ""),
    input,
    () => {
      const { newTrainer, ...v } = input;
      if (v.email) v.email = v.email.trim().toLowerCase();
      let profile: Trainer | undefined;
      if (newTrainer) {
        if (v.role !== "GYM_TRAINER" || v.trainerId)
          throw new Error("Choose one existing or new trainer profile");
        if (newTrainer.name.trim().length < 2)
          throw new Error("Enter a trainer name");
        profile = {
          id: uid(),
          name: newTrainer.name.trim(),
          email:
            v.email ||
            db.accessAssignments.find((a) => a.id === id)?.email ||
            "",
          phone: newTrainer.phone || "",
          isActive: true,
        };
        v.trainerId = profile.id;
      }
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
      if (profile) db.trainers.push(profile);
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
function mockTrainerDashboard(
  filters: TrainerDashboardFilters,
): TrainerDashboardData {
  const data = scoped();
  if (
    session?.role === "GYM_TRAINER" &&
    filters.trainerId &&
    filters.trainerId !== session.trainerId
  )
    throw new Error("Other trainer forbidden");
  const trainer =
    data.trainers.find(
      (t) => t.id === (filters.trainerId || session?.trainerId),
    ) ||
    (!filters.trainerId ? data.trainers[0] : undefined) ||
    null;
  if (filters.trainerId && !trainer) throw new Error("Trainer not found");
  const rows: TrainingDashboardRow[] = data.trainingSubscriptions
    .filter((s) => s.trainerId === trainer?.id && s.status === "ACTIVE")
    .flatMap<TrainingDashboardRow>((s) => {
      const m = data.members.find(
        (m) => m.id === s.memberId && m.status === "ACTIVE",
      );
      if (!m) return [];
      return [
        {
          id: s.id,
          memberId: m.id,
          fullName: m.fullName,
          email: m.email,
          phone: m.phone,
          planId: s.planId,
          planName:
            data.personalTrainingPlans.find((p) => p.id === s.planId)?.name ||
            "Training plan",
          startDate: s.startDate,
          endDate: s.endDate,
          daysRemaining: calculateDaysRemaining(s.endDate),
          priceAtPurchase: s.priceAtPurchase,
          status:
            calculateDaysRemaining(s.startDate) > 0
              ? "Upcoming"
              : getMembershipStatus(s.endDate),
        },
      ];
    })
    .sort(
      (a, b) =>
        a.daysRemaining - b.daysRemaining ||
        a.fullName.localeCompare(b.fullName),
    );
  const filtered = rows.filter(
    (r) =>
      r.fullName.toLowerCase().includes((filters.search || "").toLowerCase()) &&
      (!filters.planId || r.planId === filters.planId) &&
      (!filters.status || r.status === filters.status),
  );
  const pageSize = filters.pageSize || 8;
  const page = Math.min(
    filters.page || 1,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const configured = data.payoutConfigurations.some(
    (p) => p.trainerId === trainer?.id,
  );
  return {
    trainer,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    plans: Array.from(
      new Map(
        rows.map((r) => [r.planId, { id: r.planId, name: r.planName }]),
      ).values(),
    ),
    total: filtered.length,
    page,
    pageSize,
    summary: {
      totalAssignedMembers: new Set(rows.map((r) => r.memberId)).size,
      activeTrainingMembers: new Set(
        rows
          .filter((r) => r.status === "Active" || r.status === "Expiring Soon")
          .map((r) => r.memberId),
      ).size,
      planValue: rows.reduce((s, r) => s + r.priceAtPurchase, 0),
      estimatedPayout: null,
      payoutStatus: configured ? "REVIEW_REQUIRED" : "NOT_CONFIGURED",
      payoutNote: configured
        ? "Development fixtures have no line-level payment allocations; no payout is assumed."
        : "No configured payout rule.",
      periodStart: today().slice(0, 7) + "-01",
      periodEnd: today(),
    },
  };
}
export function resetMock() {
  db = seed();
  mockCommissionRules = initialCommissionRules();
  deletedMembershipPlans.clear();
  deletedTrainerPlans.clear();
  deletedMembers.clear();
  memberRequests.clear();
  session = null;
  billingKeys.clear();
}
