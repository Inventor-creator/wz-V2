/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { webcrypto } from "node:crypto";
import { FeesPage, InvoiceDialog } from "../features/payments/FeesPage";
import { FinancesPage } from "../features/finances/FinancesPage";
import {
  FinancialNotice,
  MoneyCommandDialog,
} from "../features/payments/financialShared";
import { ExpenseDialog } from "../features/finances/ExpenseDialog";
import { financialApi } from "../lib/financialApi";
import { amountError, inr, paise } from "../lib/financial";
import type {
  FeesData,
  FinanceData,
  Obligation,
  Receipt,
  Expense,
} from "../types/financial";

const auth = vi.hoisted(() => ({ role: "GYM_OWNER" }));
vi.mock("../features/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "actor-1", role: auth.role } }),
}));
vi.mock("../lib/financialApi", () => ({
  financialApi: {
    fees: vi.fn(),
    invoice: vi.fn(),
    finances: vi.fn(),
    command: vi.fn(),
    requestStatus: vi.fn(),
    export: vi.fn(),
  },
}));

let bill: Obligation,
  receipt: Receipt,
  expense: Expense,
  fees: FeesData,
  finances: FinanceData;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  sessionStorage.clear();
  auth.role = "GYM_OWNER";
  bill = {
    id: "invoice-1",
    memberId: "member-1",
    memberName: "Archived Member",
    memberNumber: "WZ001",
    archived: true,
    invoiceNumber: "INV001",
    invoiceDate: "2024-02-01",
    dueDate: "2024-02-29",
    status: "issued",
    paymentStatus: "PARTIAL",
    total: "100.00",
    paid: "40.00",
    balance: "60.00",
    overdue: true,
    lastPaymentDate: "2024-02-29",
    lines: [
      {
        id: "line-1",
        description: "Historical gym plan",
        amount: "100.00",
        subscriptionId: "sub-1",
        kind: "GYM",
        startDate: "2024-02-01",
        endDate: "2024-02-29",
      },
    ],
  };
  receipt = {
    id: "receipt-1",
    invoiceId: bill.id,
    amount: "40.00",
    date: "2024-02-29",
    method: "cash",
    status: "completed",
    reference: "REF123",
    notes: "Original payment",
    createdBy: "Owner",
    createdAt: "2024-02-29T00:00:00Z",
    refundable: "40.00",
    refunds: [],
  };
  expense = {
    id: "expense-1",
    incurredOn: "2024-02-29",
    date: null,
    category: "Rent",
    description: "Gym room rent",
    amount: "10.00",
    method: null,
    status: "recorded",
    reference: "RENT",
    createdBy: "Owner",
    version: 1,
    reversedDate: null,
  };
  fees = {
    rows: [bill],
    total: 21,
    page: 1,
    pageSize: 20,
    summary: {
      outstanding: "60.00",
      overdue: "60.00",
      members: 1,
      collectedThisMonth: "40.00",
      upcoming: 0,
      partial: 1,
      paid: 0,
    },
  };
  finances = {
    rows: [
      {
        id: receipt.id,
        invoiceId: bill.id,
        date: receipt.date,
        type: "payment",
        amount: receipt.amount,
        entity: bill.memberName,
        method: "cash",
        status: "completed",
        reference: "REF123",
        notes: receipt.notes,
        createdBy: "Owner",
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
    summary: {
      grossCollections: "40.00",
      refunds: "0.00",
      collections: "40.00",
      expenses: "0.00",
      trainerPayouts: "0.00",
      netCashFlow: "40.00",
      outstanding: "60.00",
      currentMonthCollections: "40.00",
      currentMonthExpenses: "0.00",
    },
    trends: [
      {
        month: "2024-02",
        collections: "40.00",
        expenses: "0.00",
        trainerPayouts: "0.00",
      },
    ],
    methods: { cash: "40.00" },
    plans: { "Historical gym plan": "40.00" },
    categories: {},
    expenses: [expense],
    events: [],
    warnings: [],
  };
  vi.mocked(financialApi.fees).mockImplementation(async () =>
    structuredClone(fees),
  );
  vi.mocked(financialApi.invoice).mockImplementation(async () => ({
    invoice: structuredClone(bill),
    payments: [structuredClone(receipt)],
  }));
  vi.mocked(financialApi.finances).mockImplementation(async () =>
    structuredClone(finances),
  );
  vi.mocked(financialApi.command).mockResolvedValue({
    id: "created-1",
    action: "payment",
  });
  vi.mocked(financialApi.export).mockResolvedValue(undefined);
  vi.mocked(financialApi.requestStatus).mockResolvedValue({
    id: "previous",
    action: "payment",
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(element: React.ReactNode, route = "/fees-due") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={client}>{element}</QueryClientProvider>
    </MemoryRouter>,
  );
  return { client, invalidate };
}

describe("financial amounts", () => {
  it("uses exact integer paise and rejects invalid precision or overpayment", () => {
    expect(paise("9999999999.99")).toBe(999999999999n);
    expect(paise("0.10") + paise("0.20")).toBe(30n);
    for (const value of ["0", "-1", "0.001", "NaN", "1e2", "10000000000"])
      expect(amountError(value)).not.toBe("");
    expect(amountError("0.31", "0.30")).toContain("exceeds");
    expect(amountError("0.30", "0.30")).toBe("");
    expect(inr("9007199254740991.01")).toBe("₹9,00,71,99,25,47,40,991.01");
    expect(inr("-0.01")).toBe("-₹0.01");
  });
});

describe("Fees Due dedicated query", () => {
  it("renders real balances including archived history, and links member-filter navigation", async () => {
    mount(<FeesPage />, "/fees-due?memberId=member-1");
    expect(await screen.findByText("Archived Member")).toBeInTheDocument();
    expect(screen.getByText("Historical gym plan")).toBeInTheDocument();
    expect(financialApi.fees).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member-1" }),
    );
    expect(screen.queryByText("DEVELOPMENT RECEIPT")).not.toBeInTheDocument();
  });
  it("forwards search/status/sort and pagination rather than hiding paid invoices", async () => {
    mount(<FeesPage />);
    await screen.findByText("Archived Member");
    fireEvent.change(screen.getByLabelText("Search fees"), {
      target: { value: "Name" },
    });
    fireEvent.change(screen.getByLabelText("Payment status"), {
      target: { value: "PAID" },
    });
    fireEvent.change(screen.getByLabelText("Sort by"), {
      target: { value: "balance" },
    });
    await waitFor(() =>
      expect(financialApi.fees).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: "Name",
          status: "PAID",
          sort: "balance",
          page: 1,
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(financialApi.fees).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      ),
    );
  });
  it("shows loading, error and empty states without fake success", async () => {
    vi.mocked(financialApi.fees).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const { client } = mount(<FeesPage />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    vi.mocked(financialApi.fees).mockRejectedValueOnce(
      new Error("Migration 009 pending"),
    );
    await client.cancelQueries();
    await client.refetchQueries();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Migration 009 pending",
    );
    fees.rows = [];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No records to show")).toBeInTheDocument();
  });
  it("shows receipts, actor, reference and explicit reversal confirmation", async () => {
    mount(<InvoiceDialog id={bill.id} onClose={vi.fn()} />);
    await screen.findByText(/Transaction receipt-1/);
    expect(screen.getByText(/REF123/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Reverse remaining receipt" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Reverse payment" });
    expect(financialApi.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Erroneous receipt" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm reverse payment" }),
    );
    await waitFor(() =>
      expect(financialApi.command).toHaveBeenCalledWith(
        "/financial-payments/receipt-1/refunds",
        expect.objectContaining({
          amount: "40.00",
          reason: "Erroneous receipt",
          reversal: true,
          requestKey: expect.any(String),
        }),
        "POST",
      ),
    );
  });
  it("hides owner-only fee adjustments from receptionist", async () => {
    auth.role = "GYM_RECEPTIONIST";
    mount(<InvoiceDialog id={bill.id} onClose={vi.fn()} />);
    await screen.findByText(/Transaction receipt-1/);
    expect(
      screen.queryByRole("button", { name: "Adjust unpaid fees" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Record payment" }),
    ).toBeInTheDocument();
  });
  it("restores archived members through an explicit reasoned command", async () => {
    fees.archivedMembers = [
      { id: "member-1", name: "Archived Member", memberNumber: "WZ001" },
    ];
    mount(<FeesPage />);
    await screen.findByText("Archived Member");
    fireEvent.click(screen.getByRole("button", { name: "Archived members" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Archived members" }),
      ).getByRole("button", { name: "Restore member" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Restore member" });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Member returned" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore member" }),
    );
    await waitFor(() =>
      expect(financialApi.command).toHaveBeenCalledWith(
        "/financial-members/member-1/restore",
        expect.objectContaining({ reason: "Member returned" }),
        "POST",
      ),
    );
  });
  it("requires owner review before issuing a historical charge", async () => {
    fees.unbilled = [
      {
        id: "legacy-sub",
        kind: "GYM",
        memberName: "Archived Member",
        planName: "Old gym purchase",
        amount: "100.00",
        startDate: "2024-02-01",
        endDate: "2024-02-29",
        status: "expired",
      },
    ];
    mount(<FeesPage />);
    await screen.findByText("Archived Member");
    fireEvent.click(
      screen.getByRole("button", { name: "Review unbilled purchases" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review and issue charge" }),
    );
    expect(financialApi.command).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", {
      name: "Issue historical charge",
    });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "External records reviewed" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Issue historical charge" }),
    );
    await waitFor(() =>
      expect(financialApi.command).toHaveBeenCalledWith(
        "/financial-subscriptions/legacy-sub/bill",
        expect.objectContaining({
          kind: "GYM",
          reason: "External records reviewed",
        }),
        "POST",
      ),
    );
  });
});

describe("payment safe submission", () => {
  it("announces success only after a confirmed backend result", async () => {
    mount(
      <>
        <FinancialNotice />
        <MoneyCommandDialog
          title="Record payment"
          url="/fees-due/i/payments"
          maximum="60.00"
          onClose={vi.fn()}
        />
      </>,
    );
    expect(screen.queryByText(/payment confirmed/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "payment confirmed · created-1",
    );
  });
  it("blocks invalid amounts, records partial exact amounts and invalidates related caches", async () => {
    const done = vi.fn();
    const { invalidate } = mount(
      <MoneyCommandDialog
        title="Record payment"
        url="/fees-due/i/payments"
        maximum="60.00"
        onClose={done}
      />,
    );
    fireEvent.change(screen.getByLabelText("Amount (INR)"), {
      target: { value: "60.001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("two decimal");
    expect(financialApi.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: /^Amount \(INR\)/ }), {
      target: { value: "10.10" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(financialApi.command).toHaveBeenCalledWith(
      "/fees-due/i/payments",
      expect.objectContaining({ amount: "10.10", method: "cash" }),
      "POST",
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["member-details"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["finances"] });
  });
  it("retains the request key after timeout and prevents repeated pending clicks", async () => {
    let reject: (reason: Error) => void = () => {};
    vi.mocked(financialApi.command).mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    mount(
      <MoneyCommandDialog
        title="Record payment"
        url="/fees-due/i/payments"
        maximum="60.00"
        onClose={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Confirm record payment",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(financialApi.command).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    reject(new Error("Timeout after commit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Timeout after commit",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    await waitFor(() => expect(financialApi.command).toHaveBeenCalledTimes(2));
    expect(vi.mocked(financialApi.command).mock.calls[0][1].requestKey).toBe(
      vi.mocked(financialApi.command).mock.calls[1][1].requestKey,
    );
  });
  it("checks the prior committed outcome before accepting changed fields after a timeout", async () => {
    vi.mocked(financialApi.command).mockRejectedValueOnce(
      new Error("Ambiguous timeout"),
    );
    mount(
      <MoneyCommandDialog
        title="Record payment"
        url="/fees-due/i/payments"
        maximum="60.00"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Amount (INR)"), {
      target: { value: "10.00" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "previous submission succeeded",
      ),
    );
    expect(financialApi.requestStatus).toHaveBeenCalled();
    expect(financialApi.command).toHaveBeenCalledTimes(1);
  });
  it("restores the same retry key after closing and reopening a payment dialog", async () => {
    vi.mocked(financialApi.command).mockRejectedValueOnce(
      new Error("Ambiguous timeout"),
    );
    mount(
      <MoneyCommandDialog
        title="Record payment"
        url="/fees-due/i/payments"
        maximum="60.00"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    await screen.findByRole("alert");
    const key = vi.mocked(financialApi.command).mock.calls[0][1].requestKey;
    cleanup();
    mount(
      <MoneyCommandDialog
        title="Record payment"
        url="/fees-due/i/payments"
        maximum="60.00"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm record payment" }),
    );
    await waitFor(() => expect(financialApi.command).toHaveBeenCalledTimes(2));
    expect(vi.mocked(financialApi.command).mock.calls[1][1].requestKey).toBe(
      key,
    );
  });
});

it("does not treat an absent request result as permission to send edited duplicate cash", async () => {
  vi.mocked(financialApi.command).mockRejectedValueOnce(
    new Error("Ambiguous timeout"),
  );
  vi.mocked(financialApi.requestStatus).mockResolvedValue(null);
  mount(
    <MoneyCommandDialog
      title="Record payment"
      url="/fees-due/i/payments"
      maximum="60.00"
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm record payment" }),
  );
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Amount (INR)"), {
    target: { value: "10.00" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm record payment" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "original outcome is still unconfirmed",
    ),
  );
  expect(financialApi.command).toHaveBeenCalledTimes(1);
});

describe("Finances", () => {
  it("renders cash-flow KPIs and accurate report sections rather than profit estimates", async () => {
    mount(<FinancesPage />);
    expect(await screen.findByText("Net cash flow")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Reports" }));
    expect(screen.getByText("Monthly cash-flow summary")).toBeInTheDocument();
    expect(
      screen.getByText("Collections by purchased plan / charge"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Estimated Profit")).not.toBeInTheDocument();
  });
  it("forwards dates/type/method/search and exports using active filters", async () => {
    mount(<FinancesPage />);
    await screen.findByText("Net cash flow");
    fireEvent.change(screen.getByLabelText("Report start"), {
      target: { value: "2024-02-01" },
    });
    fireEvent.change(screen.getByLabelText("Transaction type"), {
      target: { value: "refund" },
    });
    fireEvent.change(screen.getByLabelText("Transaction method"), {
      target: { value: "cash" },
    });
    fireEvent.change(screen.getByLabelText("Search transactions"), {
      target: { value: "REF123" },
    });
    await waitFor(() =>
      expect(financialApi.finances).toHaveBeenLastCalledWith(
        expect.objectContaining({
          start: "2024-02-01",
          type: "refund",
          method: "cash",
          search: "REF123",
        }),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export transactions CSV" }),
    );
    await waitFor(() =>
      expect(financialApi.export).toHaveBeenCalledWith(
        expect.objectContaining({ type: "refund", search: "REF123" }),
      ),
    );
  });
  it("expense lifecycle requires confirmation and preserves version in reversal", async () => {
    expense.status = "paid";
    expense.date = "2024-02-29";
    mount(<FinancesPage />);
    await screen.findByText("Net cash flow");
    fireEvent.click(screen.getByRole("tab", { name: "Expenses" }));
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    expect(financialApi.command).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Reverse expense" });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Vendor returned payment" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reverse expense" }),
    );
    await waitFor(() =>
      expect(financialApi.command).toHaveBeenCalledWith(
        "/financial-expenses/expense-1/reverse",
        expect.objectContaining({
          reason: "Vendor returned payment",
          version: 1,
        }),
        "POST",
      ),
    );
  });
  it("expense form validates decimal input and creates only a draft", async () => {
    const done = vi.fn();
    mount(<ExpenseDialog onClose={done} />);
    fireEvent.change(screen.getByLabelText("Amount (INR)"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Room rent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft expense" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "positive amount",
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^Amount \(INR\)/ }), {
      target: { value: "10.01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft expense" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(financialApi.command).toHaveBeenCalledWith(
      "/financial-expenses",
      expect.objectContaining({ amount: "10.01", description: "Room rent" }),
      "POST",
    );
  });
  it("shows backend failures and reconciliation warnings without invented totals", async () => {
    vi.mocked(financialApi.finances).mockRejectedValueOnce(
      new Error("Service unavailable"),
    );
    mount(<FinancesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Service unavailable",
    );
    finances.warnings = ["Legacy expenses require reconciliation"];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Legacy expenses require reconciliation",
      ),
    );
  });
});
