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
import {
  TrainersPage,
  TrainerDetails,
} from "../features/trainers/TrainersPage";
import { api } from "../lib/api";
import { calculateEndDate, today } from "../lib/dates";
import type {
  TrainerDirectoryEntry,
  TrainerDetailsData,
} from "../types/domain";
vi.mock("../lib/api", () => ({
  api: {
    trainers: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      scheduleCommission: vi.fn(),
    },
  },
}));
let trainers: TrainerDirectoryEntry[], details: TrainerDetailsData;
beforeEach(() => {
  vi.resetAllMocks();
  trainers = [
    {
      id: "t1",
      name: "Coach One",
      email: "contact@example.com",
      phone: "",
      isActive: true,
      assignedMembersCount: 5,
      activeMembersCount: 2,
      hasLoginAccess: true,
    },
  ];
  details = {
    trainer: trainers[0],
    assignments: [
      {
        id: "a1",
        memberId: "m1",
        memberName: "Member One",
        memberEmail: "member@example.com",
        memberPhone: "",
        planId: "p1",
        planName: "Historical PT",
        startDate: "2025-01-01",
        endDate: "2025-01-30",
        priceAtPurchase: 4500,
        status: "Expired",
      },
    ],
    payoutRules: [],
  };
  vi.mocked(api.trainers.list).mockImplementation(async () => [...trainers]);
  vi.mocked(api.trainers.get).mockImplementation(async () => ({
    ...details,
    trainer: trainers[0],
  }));
  vi.mocked(api.trainers.create).mockImplementation(async (value) => {
    const result = {
      id: "new",
      ...value,
      assignedMembersCount: 0,
      activeMembersCount: 0,
      hasLoginAccess: false,
    };
    trainers.push(result);
    return result;
  });
  vi.mocked(api.trainers.update).mockImplementation(async (id, value) => {
    trainers = trainers.map((t) => (t.id === id ? { ...t, ...value } : t));
    return trainers.find((t) => t.id === id)!;
  });
  vi.mocked(api.trainers.scheduleCommission).mockImplementation(
    async (_id, value) => {
      const rule = {
        id: "rule",
        kind: "percent" as const,
        value: value.commissionRate,
        effectiveFrom: value.effectiveFrom,
        effectiveUntil: value.effectiveUntil ?? null,
      };
      details.payoutRules = [rule];
      return rule;
    },
  );
});
afterEach(cleanup);
function page(path = "/trainers") {
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
          <Route path="/trainers" element={<TrainersPage />} />
          <Route path="/trainers/:trainerId" element={<TrainerDetails />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("loads real directory counts/access status without a workspace snapshot", async () => {
  page();
  expect(
    await screen.findByRole("heading", { name: "Coach One" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Members with history")).toBeInTheDocument();
  expect(screen.getByText("Linked")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View trainer" })).toHaveAttribute(
    "href",
    "/trainers/t1",
  );
});
it("creates a profile with optional contact fields, without creating a login grant", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "+ Add Trainer" }));
  expect(
    screen.getByText(/Contact details are not login credentials/),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "New Coach" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    await screen.findByRole("heading", { name: "New Coach" }),
  ).toBeInTheDocument();
  expect(api.trainers.create).toHaveBeenCalledWith({
    name: "New Coach",
    email: "",
    phone: "",
    isActive: true,
  });
});
it("edits contact data without sending counts, user IDs or access grants", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Contact email (optional)"), {
    target: { value: "new@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.trainers.update).toHaveBeenCalledWith("t1", {
      name: "Coach One",
      email: "new@example.com",
      phone: "",
      isActive: true,
    }),
  );
});
it("cancel does not claim that a trainer was saved or change status", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "+ Add Trainer" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/Trainer profile saved/)).not.toBeInTheDocument();
  expect(api.trainers.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.trainers.update).not.toHaveBeenCalled();
});
it("confirms deactivation and sends only a status patch, preserving login grants", async () => {
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
  expect(screen.getByText(/login grants are unchanged/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.trainers.update).toHaveBeenCalledWith("t1", { isActive: false }),
  );
  expect(
    await screen.findByRole("button", { name: "Activate" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Linked")).toBeInTheDocument();
});
it("filters directory by status and contact search", async () => {
  trainers.push({
    ...trainers[0],
    id: "t2",
    name: "Other Coach",
    isActive: false,
  });
  page();
  await screen.findByRole("heading", { name: "Coach One" });
  fireEvent.change(screen.getByLabelText("Trainer status"), {
    target: { value: "inactive" },
  });
  expect(
    screen.queryByRole("heading", { name: "Coach One" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search trainers"), {
    target: { value: "missing" },
  });
  expect(screen.getByText(/No trainers match/)).toBeInTheDocument();
});
it("renders purchase-price history and owner commission rules on the dedicated detail route", async () => {
  page("/trainers/t1");
  expect(
    await screen.findByRole("heading", { name: "Coach One" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Historical PT")).toBeInTheDocument();
  expect(screen.getByText("₹4,500")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Commission rules" }),
  ).toBeInTheDocument();
  expect(api.trainers.get).toHaveBeenCalledWith("t1");
});
it("does not show commission details/actions when the server redacts them for receptionists", async () => {
  details.payoutRules = null;
  page("/trainers/t1");
  await screen.findByRole("heading", { name: "Coach One" });
  expect(
    screen.queryByRole("heading", { name: "Commission rules" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Schedule commission" }),
  ).not.toBeInTheDocument();
});
it("schedules a future commission without an undated overwrite, and refreshes detail rules", async () => {
  page("/trainers/t1");
  fireEvent.click(
    await screen.findByRole("button", { name: "Schedule commission" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Schedule commission" });
  fireEvent.change(within(dialog).getByLabelText("Commission (%)"), {
    target: { value: "55.25" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.trainers.scheduleCommission).toHaveBeenCalledWith("t1", {
      commissionRate: 55.25,
      effectiveFrom: calculateEndDate(today(), 2, "DAY"),
      effectiveUntil: null,
    }),
  );
  expect(
    await screen.findByText("55.25% of PT collections"),
  ).toBeInTheDocument();
});
it("keeps forms open on profile/commission server errors and does not display false success", async () => {
  vi.mocked(api.trainers.scheduleCommission).mockRejectedValue(
    new Error("Overlapping future rules require review"),
  );
  page("/trainers/t1");
  fireEvent.click(
    await screen.findByRole("button", { name: "Schedule commission" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("require review");
  expect(
    screen.getByRole("dialog", { name: "Schedule commission" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.queryByText(/Commission rule scheduled/),
  ).not.toBeInTheDocument();
});
it("shows retryable load errors instead of a failed workspace dependency", async () => {
  vi.mocked(api.trainers.list).mockRejectedValue(
    new Error("Apply migration 007"),
  );
  page();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Apply migration 007",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});
it("retains unsaved profile values when the server is unavailable", async () => {
  vi.mocked(api.trainers.create).mockRejectedValue(
    new Error("Trainer database unavailable"),
  );
  page();
  fireEvent.click(await screen.findByRole("button", { name: "+ Add Trainer" }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Unsaved Coach" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "database unavailable",
  );
  expect(
    screen.getByRole("dialog", { name: "Add trainer" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("Unsaved Coach");
});
it("rejects a commission start today before calling the API", async () => {
  page("/trainers/t1");
  fireEvent.click(
    await screen.findByRole("button", { name: "Schedule commission" }),
  );
  fireEvent.change(screen.getByLabelText("Effective from"), {
    target: { value: today() },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Save changes" }).closest("form")!,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("after today");
  expect(api.trainers.scheduleCommission).not.toHaveBeenCalled();
});
