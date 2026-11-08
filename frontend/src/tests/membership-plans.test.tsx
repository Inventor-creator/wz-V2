import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlansPage } from "../features/plans/PlansPage";
import { api } from "../lib/api";
import type { GymMembershipPlan } from "../types/domain";
vi.mock("../lib/api", () => ({
  api: {
    membershipPlans: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));
let plans: GymMembershipPlan[];
beforeEach(() => {
  vi.clearAllMocks();
  plans = [
    {
      id: "plan",
      name: "30-day Essential",
      price: 1000,
      duration: 30,
      durationUnit: "DAY",
      description: "Gym access",
      isActive: true,
      activeMembersCount: 3,
      hasHistory: true,
    },
  ];
  vi.mocked(api.membershipPlans.list).mockImplementation(async () => plans.map(p=>({...p,activeMembersCount:p.activeMembersCount??0,hasHistory:p.hasHistory??false})));
  vi.mocked(api.membershipPlans.create).mockImplementation(async (value) => {
    const p = { id: "new-plan", ...value };
    plans.push(p);
    return p;
  });
  vi.mocked(api.membershipPlans.update).mockImplementation(
    async (id, value) => {
      const p = { ...plans.find((p) => p.id === id)!, ...value };
      plans = plans.map((old) => (old.id === id ? p : old));
      return p;
    },
  );
  vi.mocked(api.membershipPlans.delete).mockImplementation(async (id) => {
    const p = plans.find((p) => p.id === id)!;
    plans = plans.filter((p) => p.id !== id);
    return { id, mode: p.hasHistory ? "REMOVED_FROM_CATALOG" : "DELETED" };
  });
});
afterEach(cleanup);
function page() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PlansPage />
    </QueryClientProvider>,
  );
}
it("loads plan cards directly without a workspace endpoint", async () => {
  page();
  expect(
    await screen.findByRole("heading", { name: "30-day Essential" }),
  ).toBeInTheDocument();
  expect(screen.getByText("3 active members")).toBeInTheDocument();
});
it("creates a free fixed-day plan with validated fields", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: /Add Plan/ }));
  expect(
    screen.queryByRole("option", { name: "Months" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Plan name"), {
    target: { value: "Free trial" },
  });
  fireEvent.change(screen.getByLabelText("Price (INR)"), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText("Duration (days)"), {
    target: { value: "7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.membershipPlans.create).toHaveBeenCalledWith({
      name: "Free trial",
      price: 0,
      duration: 7,
      durationUnit: "DAY",
      description: "",
      isActive: true,
    }),
  );
  expect(
    await screen.findByRole("heading", { name: "Free trial" }),
  ).toBeInTheDocument();
});
it("edits catalog prices and duration without sending readonly member counts", async () => {
  page();
  const title = await screen.findByRole("heading", {
    name: "30-day Essential",
  });
  fireEvent.click(
    within(title.closest("article")!).getByRole("button", { name: "Edit" }),
  );
  fireEvent.change(screen.getByLabelText("Price (INR)"), {
    target: { value: "1500.55" },
  });
  fireEvent.change(screen.getByLabelText("Duration (days)"), {
    target: { value: "60" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.membershipPlans.update).toHaveBeenCalledWith("plan", {
      name: "30-day Essential",
      price: 1500.55,
      duration: 60,
      durationUnit: "DAY",
      description: "Gym access",
      isActive: true,
    }),
  );
});
it("deletes only after confirmation and explains retained history", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(api.membershipPlans.delete).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      /Existing subscription dates, prices and invoices are not changed/,
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
  await waitFor(() =>
    expect(api.membershipPlans.delete).toHaveBeenCalledWith("plan"),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "30-day Essential" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByText(/Plan removed from the catalogue/),
  ).toBeInTheDocument();
});
it("keeps the form open on a duplicate name error", async () => {
  vi.mocked(api.membershipPlans.create).mockRejectedValue(
    new Error("A plan with this name already exists"),
  );
  page();
  fireEvent.click(await screen.findByRole("button", { name: /Add Plan/ }));
  fireEvent.change(screen.getByLabelText("Plan name"), {
    target: { value: "30-day Essential" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  expect(
    screen.getByRole("dialog", { name: "Add membership plan" }),
  ).toBeInTheDocument();
});
