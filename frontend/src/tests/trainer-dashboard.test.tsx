import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TrainerDashboard } from "../features/trainers/TrainerDashboard";
import { api } from "../lib/api";
import type { TrainerDashboardData } from "../types/domain";
const state = vi.hoisted(() => ({ role: "GYM_TRAINER" }));
vi.mock("../features/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user", role: state.role } }),
}));
vi.mock("../lib/api", () => ({
  api: {
    trainerDashboard: { get: vi.fn(), options: vi.fn(), member: vi.fn() },
  },
}));
const row = {
  id: "subscription",
  memberId: "member",
  fullName: "Aarav Sharma",
  email: "aarav@example.com",
  phone: "9876543210",
  planId: "plan",
  planName: "PT Foundations",
  startDate: "2026-10-01",
  endDate: "2026-11-01",
  daysRemaining: -2,
  priceAtPurchase: 6000,
  status: "Expired" as const,
};
const data: TrainerDashboardData = {
  trainer: {
    id: "trainer",
    name: "Coach",
    email: "coach@example.com",
    phone: "",
    isActive: true,
  },
  summary: {
    totalAssignedMembers: 1,
    activeTrainingMembers: 0,
    planValue: 6000,
    estimatedPayout: null,
    payoutStatus: "NOT_CONFIGURED",
    payoutNote: "No configured commission",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-03",
  },
  rows: [row],
  plans: [{ id: "plan", name: "PT Foundations" }],
  total: 1,
  page: 1,
  pageSize: 8,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.role = "GYM_TRAINER";
  vi.mocked(api.trainerDashboard.get).mockResolvedValue(data);
  vi.mocked(api.trainerDashboard.options).mockResolvedValue([data.trainer!]);
  vi.mocked(api.trainerDashboard.member).mockResolvedValue({
    member: {
      id: "member",
      fullName: "Aarav Sharma",
      email: "aarav@example.com",
      phone: "9876543210",
      joiningDate: "2026-10-01",
    },
    trainingHistory: [row],
  });
});
afterEach(cleanup);
function page() {
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TrainerDashboard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
it("loads a dedicated scoped dashboard without a workspace and never assumes a payout", async () => {
  page();
  expect(await screen.findByText("Not Configured")).toBeInTheDocument();
  expect(screen.queryByLabelText("Choose trainer")).not.toBeInTheDocument();
  expect(api.trainerDashboard.options).not.toHaveBeenCalled();
  expect(
    vi.mocked(api.trainerDashboard.get).mock.calls[0][0]?.trainerId,
  ).toBeUndefined();
});
it("searches via the API and opens scoped member history", async () => {
  page();
  const input = await screen.findByLabelText("Search assigned members");
  fireEvent.change(input, { target: { value: "Aarav" } });
  await waitFor(() =>
    expect(api.trainerDashboard.get).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "Aarav", page: 1 }),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: /Aarav Sharma/ }));
  expect(
    await screen.findByRole("dialog", { name: "Aarav Sharma" }),
  ).toBeInTheDocument();
  expect(api.trainerDashboard.member).toHaveBeenCalledWith("member", "trainer");
});
it("lets owners select a trainer", async () => {
  state.role = "GYM_OWNER";
  page();
  expect(await screen.findByLabelText("Choose trainer")).toBeInTheDocument();
  await waitFor(() => expect(api.trainerDashboard.options).toHaveBeenCalled());
});
