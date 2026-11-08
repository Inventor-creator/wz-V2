import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccessPage } from "../features/access/AccessPage";
import { api } from "../lib/api";
import { dateLabel } from "../lib/dates";

vi.mock("../lib/api", () => ({
  api: {
    accessAssignments: {
      list: vi.fn(),
      trainerOptions: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.accessAssignments.list).mockResolvedValue([
    {
      id: "permanent-user",
      email: "aryapat1234@gmail.com",
      name: "Arya",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      grantedBy: "Permanent configuration",
      grantedAt: "2026-11-01",
      isPermanent: true,
    },
  ]);
  vi.mocked(api.accessAssignments.trainerOptions).mockResolvedValue([]);
  vi.mocked(api.accessAssignments.create).mockResolvedValue({
    id: "new-grant",
    email: "staff@example.com",
    role: "GYM_RECEPTIONIST",
    status: "ACTIVE",
    grantedBy: "Arya",
    grantedAt: "2026-11-01",
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
      <AccessPage />
    </QueryClientProvider>,
  );
}

it("formats database grant timestamps in the gym timezone", () => {
  expect(dateLabel("2026-11-01T20:00:00Z")).toBe("02 Nov 2026");
});

it("loads access routes without requiring the workspace endpoint and protects the permanent row", async () => {
  page();
  expect(await screen.findByText("aryapat1234@gmail.com")).toBeInTheDocument();
  expect(screen.getByText("Permanent · protected")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Revoke" }),
  ).not.toBeInTheDocument();
  expect(api.accessAssignments.list).toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Delete" }),
  ).not.toBeInTheDocument();
});

it("uses Delete instead of revoke and removes the row only after confirmation", async () => {
  const staff = {
    id: "staff-grant",
    email: "staff@example.com",
    role: "GYM_RECEPTIONIST" as const,
    status: "ACTIVE" as const,
    grantedBy: "Arya",
    grantedAt: "2026-11-01",
  };
  vi.mocked(api.accessAssignments.list).mockResolvedValue([staff]);
  vi.mocked(api.accessAssignments.delete).mockImplementation(async () => {
    vi.mocked(api.accessAssignments.list).mockResolvedValue([]);
  });
  page();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(
    screen.queryByRole("button", { name: "Revoke" }),
  ).not.toBeInTheDocument();
  expect(api.accessAssignments.delete).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      /user account, financial records and audit trail will be kept/,
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete access" }));
  await waitFor(() =>
    expect(api.accessAssignments.delete).toHaveBeenCalledWith("staff-grant"),
  );
  await waitFor(() =>
    expect(screen.queryByText("staff@example.com")).not.toBeInTheDocument(),
  );
});

it("requires privileged confirmation and does not offer a database SUPER_ADMIN grant", async () => {
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: /Add Authorized Email/ }),
  );
  expect(
    screen.queryByRole("option", { name: "Super Admin" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Google email address"), {
    target: { value: "staff@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const confirm = await screen.findByRole("button", {
    name: "Confirm privileged change",
  });
  expect(api.accessAssignments.create).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(api.accessAssignments.create).toHaveBeenCalledWith({
      email: "staff@example.com",
      role: "GYM_RECEPTIONIST",
      trainerId: "",
    }),
  );
});

it("creates and links a trainer while granting access without a pre-existing profile", async () => {
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: /Add Authorized Email/ }),
  );
  fireEvent.change(screen.getByLabelText("Google email address"), {
    target: { value: "newcoach@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Role"), {
    target: { value: "GYM_TRAINER" },
  });
  expect(screen.getByLabelText("Trainer profile")).toHaveValue("new");
  fireEvent.change(screen.getByLabelText("Trainer full name"), {
    target: { value: "New Coach" },
  });
  fireEvent.change(screen.getByLabelText("Trainer phone (optional)"), {
    target: { value: "9876543210" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm privileged change" }),
  );
  await waitFor(() =>
    expect(api.accessAssignments.create).toHaveBeenCalledWith({
      email: "newcoach@example.com",
      role: "GYM_TRAINER",
      newTrainer: { name: "New Coach", phone: "9876543210" },
    }),
  );
});
