// New financial APIs deliberately use decimal strings, never JS arithmetic.
export type PaymentMethod = "cash" | "upi" | "card" | "bank" | "other";
export interface ObligationLine {
  id: string;
  description: string;
  amount: string;
  originalAmount?: string | null;
  subscriptionId: string | null;
  kind: "GYM" | "PT";
  startDate: string | null;
  endDate: string | null;
  membershipStatus?: string;
}
export interface Obligation {
  id: string;
  memberId: string;
  memberName: string;
  memberNumber: string;
  archived: boolean;
  reconciliationRequired?: boolean;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: string;
  paymentStatus?: string;
  total: string;
  paid: string;
  balance: string;
  lastPaymentDate: string | null;
  overdue?: boolean;
  upcoming?: boolean;
  lines: ObligationLine[];
  adjustments?: {
    id: string;
    operationId: string;
    amount: string;
    reason: string;
    createdAt: string;
    createdBy: string | null;
  }[];
}
export interface Refund {
  id: string;
  paymentId: string;
  amount: string;
  date: string;
  kind: string;
  reason: string;
  createdBy: string | null;
  createdAt?: string;
}
export interface Receipt {
  id: string;
  invoiceId: string;
  amount: string;
  date: string | null;
  method: PaymentMethod;
  status: string;
  reference: string;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  refundable: string;
  refunds: Refund[];
}
export interface Expense {
  id: string;
  incurredOn: string;
  date: string | null;
  category: string;
  description: string;
  amount: string;
  method: PaymentMethod | null;
  status: "recorded" | "paid" | "void";
  reference: string;
  createdBy: string | null;
  version: number;
  reversedDate: string | null;
}
export interface Transaction {
  id: string;
  invoiceId?: string;
  paymentId?: string;
  date: string | null;
  type: string;
  amount: string;
  entity: string;
  method: string | null;
  status: string;
  reference: string;
  notes: string;
  createdBy: string | null;
}
export interface FinancialEvent {
  id: string;
  action: string;
  target_id: string;
  actor_id: string;
  created_at: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown>;
}
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface FeesData extends Paged<Obligation> {
  archivedMembers?: { id: string; name: string; memberNumber: string }[];
  unbilled?: {
    id: string;
    kind: "GYM" | "PT";
    memberName: string;
    planName: string;
    amount: string;
    startDate: string;
    endDate: string;
    status: string;
  }[];
  summary: {
    outstanding: string;
    overdue: string;
    members: number;
    collectedThisMonth: string;
    upcoming: number;
    partial: number;
    paid: number;
  };
}
export interface FinanceData extends Paged<Transaction> {
  summary: Record<
    | "grossCollections"
    | "refunds"
    | "collections"
    | "expenses"
    | "trainerPayouts"
    | "netCashFlow"
    | "outstanding"
    | "currentMonthCollections"
    | "currentMonthExpenses",
    string
  >;
  trends: {
    month: string;
    collections: string;
    expenses: string;
    trainerPayouts: string;
  }[];
  methods: Record<string, string>;
  categories: Record<string, string>;
  plans: Record<string, string>;
  expenses: Expense[];
  events: FinancialEvent[];
  warnings: string[];
}
export type FinancialFilters = Record<string, string | number>;
