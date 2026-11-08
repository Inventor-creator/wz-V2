import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TrainerPlansPage } from "../features/plans/PlansPage";
import { api } from "../lib/api";
import { canAccess } from "../lib/permissions";
import type { PersonalTrainingPlan } from "../types/domain";

vi.mock("../lib/api", () => ({
  api: {
    personalTrainingPlans: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));
let plans: PersonalTrainingPlan[];
beforeEach(() => {
  vi.resetAllMocks();
  plans = [
    {
      id: "pt",
      name: "PT Essential",
      price: 6000,
      duration: 30,
      durationUnit: "DAY",
      description: "Strength coaching",
      isActive: true,
      activeMembersCount: 4,
      hasHistory: true,
    },
  ];
  vi.mocked(api.personalTrainingPlans.list).mockImplementation(async () => [
    ...plans,
  ]);
  vi.mocked(api.personalTrainingPlans.create).mockImplementation(
    async (value) => {
      const plan = { id: "new", ...value };
      plans.push(plan);
      return plan;
    },
  );
  vi.mocked(api.personalTrainingPlans.update).mockImplementation(
    async (id, value) => {
      const plan = { id, ...value };
      plans = plans.map((p) => (p.id === id ? plan : p));
      return plan;
    },
  );
  vi.mocked(api.personalTrainingPlans.delete).mockImplementation(async (id) => {
    const old = plans.find((p) => p.id === id)!;
    plans = plans.filter((p) => p.id !== id);
    return { id, mode: old.hasHistory ? "REMOVED_FROM_CATALOG" : "DELETED" };
  });
});
afterEach(cleanup);
function page() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TrainerPlansPage />
    </QueryClientProvider>,
  );
  return client;
}

it("loads a shared catalogue without workspace or trainer ownership", async () => {
  page();
  expect(
    await screen.findByRole("heading", { name: "PT Essential" }),
  ).toBeInTheDocument();
  expect(screen.getByText("4 active members")).toBeInTheDocument();
  expect(
    screen.getByText(/Choose a trainer when assigning/),
  ).toBeInTheDocument();
});

it("creates a free fixed-day plan and refreshes the catalogue", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "+ Add PT Plan" }));
  expect(screen.queryByLabelText("Duration unit")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Trainer")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Plan name"), {
    target: { value: "Free coaching trial" },
  });
  fireEvent.change(screen.getByLabelText("Price (INR)"), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText("Duration (days)"), {
    target: { value: "7" },
  });
  expect(
    screen.getByRole("spinbutton", { name: "Duration (days)" }),
  ).toHaveAccessibleDescription(
    "Fixed calendar days. Months and years are not approximated.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByRole("heading", { name: "Free coaching trial" }),
  ).toBeInTheDocument();
  expect(api.personalTrainingPlans.create).toHaveBeenCalledWith({
    name: "Free coaching trial",
    price: 0,
    duration: 7,
    durationUnit: "DAY",
    description: "",
    isActive: true,
  });
});

it("edits and deactivates without sending trainer IDs or computed fields", async () => {
  const client = page();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Price (INR)"), {
    target: { value: "7000.50" },
  });
  fireEvent.click(screen.getByLabelText("Active"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.personalTrainingPlans.update).toHaveBeenCalledWith("pt", {
      name: "PT Essential",
      price: 7000.5,
      duration: 30,
      durationUnit: "DAY",
      description: "Strength coaching",
      isActive: false,
    }),
  );
  expect(
    await screen.findByText("Inactive", { selector: ".badge" }),
  ).toBeInTheDocument();
  expect(client.getQueryData(["trainer-plans"])).toEqual(plans);
});

it("filters by name/status and explains an empty result", async () => {
  plans.push({
    ...plans[0],
    id: "inactive",
    name: "Advanced coaching",
    isActive: false,
  });
  page();
  await screen.findByRole("heading", { name: "PT Essential" });
  fireEvent.change(screen.getByLabelText("Plan status"), {
    target: { value: "inactive" },
  });
  expect(
    screen.queryByRole("heading", { name: "PT Essential" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Advanced coaching" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search trainer plans"), {
    target: { value: "No match" },
  });
  expect(
    screen.getByText("No plans match. Add a plan or change your filters."),
  ).toBeInTheDocument();
});

it("cancels deletion, then confirms removal with historical payout notice", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(
    screen.getByText(/Trainer assignments and payouts are retained/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.personalTrainingPlans.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
  expect(
    await screen.findByText(/Plan removed from the catalogue/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "PT Essential" }),
  ).not.toBeInTheDocument();
});

it("reports physical deletion for an unused plan", async () => {
  plans[0].hasHistory = false;
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
  expect(await screen.findByText("Plan deleted.")).toBeInTheDocument();
});

it("keeps edit and delete dialogs open when the server rejects a mutation", async () => {
  vi.mocked(api.personalTrainingPlans.update).mockRejectedValue(
    new Error("A plan with this name already exists"),
  );
  vi.mocked(api.personalTrainingPlans.delete).mockRejectedValue(
    new Error("Plan database unavailable"),
  );
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  expect(screen.getByRole("dialog", { name: "Edit plan" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "database unavailable",
  );
  expect(
    screen.getByRole("heading", { name: "PT Essential" }),
  ).toBeInTheDocument();
});

it("shows a retryable load error and excludes trainers from the management route", async () => {
  vi.mocked(api.personalTrainingPlans.list).mockRejectedValue(
    new Error("Apply migration 006"),
  );
  page();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Apply migration 006",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  for (const role of ["SUPER_ADMIN", "GYM_OWNER", "GYM_RECEPTIONIST"] as const)
    expect(canAccess(role, "/personal-training-plans")).toBe(true);
  expect(canAccess("GYM_TRAINER", "/personal-training-plans")).toBe(false);
});
