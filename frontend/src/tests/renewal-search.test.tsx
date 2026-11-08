import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionDialog } from "../features/payments/SubscriptionDialog";
import { api } from "../lib/api";
import type { MemberDirectoryEntry } from "../types/domain";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("../lib/financial", () => ({
  useFinancialCommand: () => ({ mutate, isPending: false, error: null }),
}));
vi.mock("../lib/api", () => ({
  api: { members: { list: vi.fn(), options: vi.fn() } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  const base: MemberDirectoryEntry = {
    id: "member-1",
    memberNumber: "WZ001",
    fullName: "Asha Patil",
    phone: "9876543210",
    email: "asha@example.com",
    joiningDate: "2024-01-01",
    status: "ACTIVE",
    gym: null,
    pt: null,
    membershipStatus: "Expired",
    outstandingAmount: 0,
  };
  vi.mocked(api.members.list).mockResolvedValue({
    members: [
      base,
      {
        ...base,
        id: "member-2",
        memberNumber: "WZ002",
        fullName: "Ravi Kumar",
        phone: "9123456780",
        email: "ravi@example.com",
      },
      {
        ...base,
        id: "archived",
        fullName: "Archived Asha",
        status: "ARCHIVED",
      },
    ],
    summary: {
      activeMembers: 0,
      expiringSoon: 0,
      expiredMemberships: 2,
      outstandingAmount: 0,
    },
  });
  vi.mocked(api.members.options).mockResolvedValue({
    membershipPlans: [
      {
        id: "plan-1",
        name: "Gym 30 days",
        price: 100,
        duration: 30,
        durationUnit: "DAY",
        description: "",
        isActive: true,
      },
    ],
    personalTrainingPlans: [
      {
        id: "pt-1",
        name: "PT 30 days",
        price: 500,
        duration: 30,
        durationUnit: "DAY",
        description: "",
        isActive: true,
      },
      {
        id: "pt-inactive",
        name: "Inactive PT",
        price: 500,
        duration: 30,
        durationUnit: "DAY",
        description: "",
        isActive: false,
      },
    ],
    trainers: [
      {
        id: "trainer-1",
        name: "Coach One",
        email: "",
        phone: "",
        isActive: true,
      },
      {
        id: "trainer-inactive",
        name: "Inactive Coach",
        email: "",
        phone: "",
        isActive: false,
      },
    ],
  });
});
afterEach(cleanup);

async function mount(memberId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SubscriptionDialog memberId={memberId} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return screen.findByLabelText("Search members for renewal");
}

it("filters renewal members by case-insensitive name, number, UUID, phone and email", async () => {
  const search = await mount();
  for (const value of [
    " ASHA ",
    "wz001",
    "member-1",
    "987654",
    "asha@example.com",
  ]) {
    fireEvent.change(search, { target: { value } });
    const member = screen.getByLabelText("Member");
    expect(
      within(member).getByRole("option", { name: "Asha Patil · WZ001" }),
    ).toBeInTheDocument();
    expect(
      within(member).queryByRole("option", { name: /Ravi/ }),
    ).not.toBeInTheDocument();
    expect(
      within(member).queryByRole("option", { name: /Archived/ }),
    ).not.toBeInTheDocument();
  }
  fireEvent.change(search, { target: { value: "" } });
  expect(
    within(screen.getByLabelText("Member")).getAllByRole("option"),
  ).toHaveLength(3);
});

it("shows an empty result without allowing an archived profile to be renewed", async () => {
  const search = await mount();
  fireEvent.change(search, { target: { value: "Archived" } });
  expect(screen.getByRole("status")).toHaveTextContent(
    "No eligible members match your search",
  );
  expect(
    within(screen.getByLabelText("Member")).getAllByRole("option"),
  ).toHaveLength(1);
  expect(mutate).not.toHaveBeenCalled();
});

it("clears the prior selection when searching and submits only the newly chosen member", async () => {
  const search = await mount("member-1");
  expect(screen.getByLabelText("Member")).toHaveValue("member-1");
  fireEvent.change(search, { target: { value: "Ravi" } });
  expect(screen.getByLabelText("Member")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Member"), {
    target: { value: "member-2" },
  });
  fireEvent.change(screen.getByLabelText("Plan"), {
    target: { value: "plan-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create subscription" }));
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "/financial-subscriptions",
      fields: expect.objectContaining({
        memberId: "member-2",
        planId: "plan-1",
      }),
    }),
  );
});

it("exposes trainer and shared trainer-plan selection for personal-training renewal", async () => {
  await mount("member-1");
  fireEvent.click(screen.getByRole("button", { name: "Personal training" }));
  expect(
    screen.getByRole("button", { name: "Personal training" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Trainer plan")).toBeInTheDocument();
  expect(screen.getByLabelText("Trainer")).toBeRequired();
  expect(
    screen.queryByRole("option", { name: /Inactive/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Trainer plan"), {
    target: { value: "pt-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create subscription" }));
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Trainer"), {
    target: { value: "trainer-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create subscription" }));
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      fields: expect.objectContaining({
        memberId: "member-1",
        kind: "PT",
        planId: "pt-1",
        trainerId: "trainer-1",
      }),
    }),
  );
});

it("clears stale plan and trainer choices when changing renewal type", async () => {
  await mount("member-1");
  fireEvent.click(screen.getByRole("button", { name: "Personal training" }));
  fireEvent.change(screen.getByLabelText("Trainer plan"), {
    target: { value: "pt-1" },
  });
  fireEvent.change(screen.getByLabelText("Trainer"), {
    target: { value: "trainer-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Gym membership" }));
  expect(screen.getByLabelText("Plan")).toHaveValue("");
  expect(screen.queryByLabelText("Trainer")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Plan"), {
    target: { value: "plan-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create subscription" }));
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      fields: expect.objectContaining({
        kind: "GYM",
        planId: "plan-1",
        trainerId: null,
      }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Personal training" }));
  expect(screen.getByLabelText("Trainer plan")).toHaveValue("");
  expect(screen.getByLabelText("Trainer")).toHaveValue("");
});

it("explains when trainer profiles or trainer plans are unavailable", async () => {
  const data = await vi.mocked(api.members.options)();
  vi.mocked(api.members.options).mockResolvedValue({
    ...data,
    personalTrainingPlans: [],
    trainers: [],
  });
  await mount("member-1");
  fireEvent.click(screen.getByRole("button", { name: "Personal training" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "No active trainer plans are available",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "No active trainers are available",
  );
});
