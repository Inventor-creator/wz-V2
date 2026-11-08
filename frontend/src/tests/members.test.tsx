import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MembersPage, MemberDetails } from "../features/members/MembersPage";
import { api } from "../lib/api";
import { today } from "../lib/dates";
import type {
  MemberDirectoryData,
  MemberDetailsData,
  MemberOptions,
} from "../types/domain";
vi.mock("../lib/api", () => ({
  api: {
    members: {
      list: vi.fn(),
      options: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));
let directory: MemberDirectoryData,
  details: MemberDetailsData,
  options: MemberOptions;
beforeEach(() => {
  vi.resetAllMocks();
  directory = {
    members: [
      {
        id: "m1",
        memberNumber: "WZ001",
        fullName: "Member One",
        email: "one@example.com",
        phone: "",
        joiningDate: "2025-01-01",
        status: "ACTIVE",
        notes: "Existing notes",
        gym: null,
        pt: null,
        membershipStatus: "No plan",
        outstandingAmount: 500,
      },
    ],
    summary: {
      activeMembers: 0,
      expiringSoon: 0,
      expiredMemberships: 0,
      outstandingAmount: 500,
    },
  };
  details = {
    member: directory.members[0],
    subscriptions: [
      {
        id: "s1",
        type: "GYM",
        planId: "old",
        planName: "Deleted historical plan",
        trainerId: null,
        trainerName: null,
        startDate: "2025-01-01",
        endDate: "2025-01-30",
        priceAtPurchase: 1200,
        daysRemaining: -10,
        status: "Expired",
      },
    ],
    invoices: [],
    payments: [],
  };
  options = {
    membershipPlans: [
      {
        id: "g1",
        name: "30-day Gym",
        price: 2500,
        duration: 30,
        durationUnit: "DAY",
        description: "",
        isActive: true,
      },
    ],
    personalTrainingPlans: [
      {
        id: "p1",
        name: "PT 7-day",
        price: 6000,
        duration: 7,
        durationUnit: "DAY",
        description: "",
        isActive: true,
      },
    ],
    trainers: [
      { id: "t1", name: "Coach", email: "", phone: "", isActive: true },
    ],
  };
  vi.mocked(api.members.list).mockImplementation(async () =>
    structuredClone(directory),
  );
  vi.mocked(api.members.options).mockImplementation(async () =>
    structuredClone(options),
  );
  vi.mocked(api.members.get).mockImplementation(async () =>
    structuredClone(details),
  );
  vi.mocked(api.members.create).mockImplementation(async (value) => {
    directory.members.push({
      id: "new",
      ...value,
      status: "ACTIVE",
      gym: null,
      pt: null,
      membershipStatus: "No plan",
      outstandingAmount: 0,
    });
    return "new";
  });
  vi.mocked(api.members.update).mockImplementation(async (id, value) => {
    directory.members = directory.members.map((m) =>
      m.id === id ? { ...m, ...value } : m,
    );
    return directory.members.find((m) => m.id === id)!;
  });
  vi.mocked(api.members.delete).mockImplementation(async (id) => {
    directory.members = directory.members.filter((m) => m.id !== id);
    return { id, mode: "REMOVED_FROM_DIRECTORY" };
  });
});
afterEach(cleanup);
function page(path = "/members") {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/members" element={<MembersPage />} />
          <Route path="/members/:memberId" element={<MemberDetails />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("loads the dedicated directory and actual balances, not a workspace snapshot", async () => {
  page();
  expect(await screen.findByText("Member One")).toBeInTheDocument();
  expect(screen.getAllByText("₹500").length).toBeGreaterThan(0);
  expect(
    screen.queryByRole("button", { name: /Run Billing/ }),
  ).not.toBeInTheDocument();
});
it("adds a member with optional contacts and selected gym plan using a stable request key", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Add Member" }));
  await screen.findByLabelText("Gym membership plan");
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "New Member" },
  });
  fireEvent.change(screen.getByLabelText("Gym membership plan"), {
    target: { value: "g1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("New Member")).toBeInTheDocument();
  expect(api.members.create).toHaveBeenCalledWith(
    {
      fullName: "New Member",
      email: "",
      phone: "",
      joiningDate: today(),
      notes: "",
      planId: "g1",
      startDate: today(),
      trainerId: "",
      ptPlanId: "",
      ptStartDate: today(),
    },
    expect.any(String),
  );
});
it("selects a shared PT plan/trainer independently and shows inclusive end-date help", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Add Member" }));
  await screen.findByLabelText("Trainer (optional)");
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "PT Member" },
  });
  fireEvent.change(screen.getByLabelText("Gym membership plan"), {
    target: { value: "g1" },
  });
  fireEvent.change(screen.getByLabelText("Trainer (optional)"), {
    target: { value: "t1" },
  });
  fireEvent.change(screen.getByLabelText("Personal training plan"), {
    target: { value: "p1" },
  });
  expect(screen.getAllByText(/Ends .*inclusive/).length).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.members.create).toHaveBeenCalledWith(
      expect.objectContaining({ trainerId: "t1", ptPlanId: "p1" }),
      expect.any(String),
    ),
  );
});
it("edits contact details without loading plans or requiring old disabled subscription fields", async () => {
  vi.mocked(api.members.options).mockRejectedValue(
    new Error("Unavailable catalogue"),
  );
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(
    screen.queryByLabelText("Gym membership plan"),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "Corrected Member" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Corrected Member")).toBeInTheDocument();
  expect(api.members.options).not.toHaveBeenCalled();
  expect(api.members.update).toHaveBeenCalledWith("m1", {
    fullName: "Corrected Member",
    email: "one@example.com",
    phone: "",
    joiningDate: "2025-01-01",
    notes: "Existing notes",
  });
});
it("confirms safe deletion and refreshes the directory while explaining history retention", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(api.members.delete).not.toHaveBeenCalled();
  expect(
    screen.getByText(/trainer payouts are not deleted/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete member" }));
  expect(
    await screen.findByText(/Member removed from the directory/),
  ).toBeInTheDocument();
  expect(screen.queryByText("Member One")).not.toBeInTheDocument();
});
it("cancel does not delete or claim a save succeeded", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.members.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/Member saved/)).not.toBeInTheDocument();
});
it("filters by contact/member status and displays empty results", async () => {
  page();
  await screen.findByText("Member One");
  fireEvent.change(screen.getByLabelText("Membership status"), {
    target: { value: "Expired" },
  });
  expect(screen.queryByText("Member One")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Membership status"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("Search members"), {
    target: { value: "WZ001" },
  });
  expect(screen.getByText("Member One")).toBeInTheDocument();
});
it("retries an uncertain create error with the same request key instead of duplicating the purchase", async () => {
  vi.mocked(api.members.create).mockRejectedValueOnce(
    new Error("Database connection interrupted"),
  );
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Add Member" }));
  await screen.findByLabelText("Gym membership plan");
  fireEvent.change(screen.getByLabelText("Full name"), {
    target: { value: "Retry Member" },
  });
  fireEvent.change(screen.getByLabelText("Gym membership plan"), {
    target: { value: "g1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("interrupted");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Retry Member");
  const calls = vi.mocked(api.members.create).mock.calls;
  expect(calls[0][1]).toBe(calls[1][1]);
});
it("shows deleted-plan history and purchase prices in dedicated member details", async () => {
  page("/members/m1");
  expect(
    await screen.findByRole("heading", { name: "Member One" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Deleted historical plan")).toBeInTheDocument();
  expect(screen.getByText("₹1,200")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Edit member" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Delete member" }),
  ).toBeInTheDocument();
});
it("returns to the directory with accurate feedback after deleting from details", async () => {
  page("/members/m1");
  fireEvent.click(await screen.findByRole("button", { name: "Delete member" }));
  const dialog = screen.getByRole("dialog", { name: "Delete member?" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Delete member" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Members" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Member removed from the directory/),
  ).toBeInTheDocument();
});
it("keeps delete confirmation open when the server rejects deletion", async () => {
  vi.mocked(api.members.delete).mockRejectedValue(
    new Error("History changed; refresh"),
  );
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete member" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("History changed");
  expect(
    screen.getByRole("dialog", { name: "Delete member?" }),
  ).toBeInTheDocument();
});
it("reports physical deletion distinctly from retained history", async () => {
  vi.mocked(api.members.delete).mockImplementation(async (id) => {
    directory.members = directory.members.filter((m) => m.id !== id);
    return { id, mode: "DELETED" };
  });
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete member" }));
  expect(await screen.findByText("Member deleted.")).toBeInTheDocument();
});
it("does not style pending/failed payments as successfully collected", async () => {
  details.payments = [
    {
      id: "p1",
      invoiceId: "i1",
      amount: 500,
      method: "upi",
      status: "pending",
      receivedAt: null,
      reference: "",
    },
    {
      id: "p2",
      invoiceId: "i1",
      amount: 500,
      method: "upi",
      status: "failed",
      receivedAt: null,
      reference: "",
    },
  ];
  page("/members/m1");
  expect(await screen.findByText("pending")).toHaveClass("amber");
  expect(screen.getByText("failed")).toHaveClass("red");
});
it("shows a retryable options error without exposing a broken create form", async () => {
  vi.mocked(api.members.options).mockRejectedValue(
    new Error("Catalogue temporarily unavailable"),
  );
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Add Member" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Catalogue temporarily unavailable",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  expect(api.members.create).not.toHaveBeenCalled();
});
