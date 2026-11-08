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
  userId?: string;
  name: string;
  email: string;
  phone: string;
  isActive: boolean;
}
export interface PersonalTrainingPlan extends GymMembershipPlan {
  trainerId: string;
}
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
export interface BillingCharge {
  subscriptionId: string;
  memberId: string;
  feeType: "GYM" | "PT";
  description: string;
  amount: number;
}
