export type Role =
  "SUPER_ADMIN" | "GYM_OWNER" | "GYM_RECEPTIONIST" | "GYM_TRAINER";
export type DurationUnit = "DAY" | "MONTH" | "YEAR";
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "ACTIVE" | "REVOKED";
  trainerId?: string;
}
export interface Member {
  id: string;
  memberNumber?: string;
  fullName: string;
  email: string;
  phone: string;
  joiningDate: string;
  status: "ACTIVE" | "ARCHIVED";
  notes?: string;
}
export interface GymMembershipPlan {
  activeMembersCount?: number;
  hasHistory?: boolean;
  id: string;
  name: string;
  price: number;
  duration: number;
  durationUnit: DurationUnit;
  description: string;
  isActive: boolean;
}
export interface MembershipPlanDeletion {
  id: string;
  mode: "DELETED" | "REMOVED_FROM_CATALOG";
}
export interface Trainer {
  id: string;
  name: string;
  email: string;
  phone: string;
  isActive: boolean;
}
export type TrainerInput = Pick<
  Trainer,
  "name" | "email" | "phone" | "isActive"
>;
export interface TrainerDirectoryEntry extends Trainer {
  assignedMembersCount: number;
  activeMembersCount: number;
  hasLoginAccess: boolean;
}
export interface TrainerAssignment {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  memberPhone: string;
  planId: string;
  planName: string;
  startDate: string;
  endDate: string;
  priceAtPurchase: number;
  status: "Active" | "Expired" | "Upcoming" | "Cancelled";
}
export interface CommissionRule {
  id: string;
  kind: "percent" | "fixed";
  value: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
}
export interface CommissionSchedule {
  commissionRate: number;
  effectiveFrom: string;
  effectiveUntil?: string | null;
}
export interface TrainerDetailsData {
  trainer: TrainerDirectoryEntry;
  assignments: TrainerAssignment[];
  payoutRules?: CommissionRule[] | null;
}
export type PersonalTrainingPlan = GymMembershipPlan;
export interface MemberGymSubscription {
  id: string;
  memberId: string;
  planId: string;
  startDate: string;
  endDate: string;
  priceAtPurchase: number;
  status: "ACTIVE" | "CANCELLED";
}
export interface MemberTrainingSubscription extends MemberGymSubscription {
  trainerId: string;
}
export interface InvoiceLineItem {
  id: string;
  invoiceId: string;
  subscriptionId: string;
  feeType: "GYM" | "PT";
  description: string;
  amount: number;
}
export interface Invoice {
  id: string;
  memberId: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: number;
  outstandingAmount: number;
  status: "UNPAID" | "PARTIAL" | "PAID";
  lineItems: InvoiceLineItem[];
}
export interface Payment {
  id: string;
  invoiceId: string;
  memberId: string;
  amount: number;
  method: "Cash" | "UPI" | "Card" | "Bank Transfer";
  paymentDate: string;
  transactionReference: string;
  notes: string;
}
export interface RoleAssignment {
  userId?: string;
  isPermanent?: boolean;
  accountActive?: boolean;
  id: string;
  email: string;
  name?: string | null;
  role: Role;
  status: "ACTIVE" | "REVOKED";
  grantedBy: string;
  grantedAt: string;
  trainerId?: string | null;
}
export interface AccessGrantInput {
  email: string;
  role: Role;
  trainerId?: string | null;
  newTrainer?: { name: string; phone?: string };
}
export interface TrainingDashboardRow {
  id: string;
  memberId: string;
  fullName: string;
  email: string;
  phone: string;
  planId: string;
  planName: string;
  startDate: string;
  endDate: string;
  daysRemaining: number;
  priceAtPurchase: number;
  status: "Active" | "Expired" | "Expiring Soon" | "Upcoming";
}
export interface TrainerDashboardData {
  trainer: Trainer | null;
  summary: {
    totalAssignedMembers: number;
    activeTrainingMembers: number;
    planValue: number;
    estimatedPayout: number | null;
    payoutStatus: "CONFIGURED" | "NOT_CONFIGURED" | "REVIEW_REQUIRED";
    payoutNote: string;
    periodStart: string;
    periodEnd: string;
  };
  rows: TrainingDashboardRow[];
  plans: { id: string; name: string }[];
  total: number;
  page: number;
  pageSize: number;
}
export interface TrainerDashboardFilters {
  trainerId?: string;
  search?: string;
  planId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}
export interface TrainerMemberData {
  member: Pick<Member, "id" | "fullName" | "email" | "phone" | "joiningDate">;
  trainingHistory: TrainingDashboardRow[];
}
export type TrainerPayoutConfiguration = { trainerId: string } & (
  | { payoutType: "COMMISSION"; commissionRate: number }
  | { payoutType: "FIXED"; fixedAmount: number }
);
export interface Database {
  members: Member[];
  membershipPlans: GymMembershipPlan[];
  trainers: Trainer[];
  personalTrainingPlans: PersonalTrainingPlan[];
  gymSubscriptions: MemberGymSubscription[];
  trainingSubscriptions: MemberTrainingSubscription[];
  invoices: Invoice[];
  payments: Payment[];
  accessAssignments: RoleAssignment[];
  payoutConfigurations: TrainerPayoutConfiguration[];
}
export interface MemberInput {
  fullName: string;
  email: string;
  phone: string;
  joiningDate: string;
  planId: string;
  startDate: string;
  trainerId: string;
  ptPlanId: string;
  ptStartDate: string;
  notes: string;
}
export type MemberProfileInput = Pick<
  MemberInput,
  "fullName" | "email" | "phone" | "joiningDate" | "notes"
>;
export interface MemberSubscription {
  id: string;
  type: "GYM" | "PT";
  planId: string;
  planName: string;
  trainerId: string | null;
  trainerName: string | null;
  startDate: string;
  endDate: string;
  priceAtPurchase: number;
  daysRemaining: number;
  status: "Active" | "Expiring Soon" | "Expired" | "Upcoming" | "Cancelled";
}
export interface MemberDirectoryEntry extends Member {
  gym: MemberSubscription | null;
  pt: MemberSubscription | null;
  membershipStatus: MemberSubscription["status"] | "No plan" | "Archived";
  outstandingAmount: number;
}
export interface MemberDirectoryData {
  members: MemberDirectoryEntry[];
  summary: {
    activeMembers: number;
    expiringSoon: number;
    expiredMemberships: number;
    outstandingAmount: number;
  };
}
export interface MemberOptions {
  membershipPlans: GymMembershipPlan[];
  personalTrainingPlans: PersonalTrainingPlan[];
  trainers: Trainer[];
}
export interface MemberDetailsData {
  member: Member;
  subscriptions: MemberSubscription[];
  invoices: {
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string;
    status: "draft" | "issued" | "void";
    totalAmount: number;
    allocatedAmount: number;
    outstandingAmount: number;
    paymentStatus: "UNPAID" | "PARTIAL" | "PAID" | "NOT_ISSUED";
  }[];
  payments: {
    id: string;
    invoiceId: string;
    amount: number;
    method: string;
    status: "pending" | "completed" | "failed";
    receivedAt: string | null;
    reference: string;
  }[];
}
export interface MemberDeletion {
  id: string;
  mode: "DELETED" | "REMOVED_FROM_DIRECTORY";
}
export interface BillingCharge {
  subscriptionId: string;
  memberId: string;
  feeType: "GYM" | "PT";
  description: string;
  amount: number;
}
