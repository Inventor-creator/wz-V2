import { beforeEach, afterEach, expect, it } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import { api, auth, resetMock } from "../lib/api";
import { BillingPreviewDialog } from "../features/billing/BillingPreviewDialog";
beforeEach(() => resetMock());
afterEach(cleanup);
it("redirects a logged out user to Google-only login", async () => {
  render(
    <MemoryRouter initialEntries={["/members"]}>
      <App />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("button", { name: /Continue with Google/ }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
});
it("blocks receptionist finance route", async () => {
  await auth.demoLogin("desk@form.example");
  render(
    <MemoryRouter initialEntries={["/finances"]}>
      <App />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("heading", { name: "Access not authorized" }),
  ).toBeInTheDocument();
});
it("shows only trainer navigation and assigned members", async () => {
  await auth.demoLogin("rohan@form.example");
  render(
    <MemoryRouter initialEntries={["/trainer"]}>
      <App />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("heading", { name: "Trainer dashboard" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Finances" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Access Management" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /^Members$/ }),
  ).not.toBeInTheDocument();
});
it("requires confirmation before generating unpaid billing and disables repeat submit", async () => {
  await auth.demoLogin("admin@form.example");
  const before = (await api.snapshot()).invoices.length;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BillingPreviewDialog onClose={() => {}} />
    </QueryClientProvider>,
  );
  const confirm = await screen.findByRole("button", {
    name: "Confirm billing",
  });
  await waitFor(() => expect(confirm).not.toBeDisabled());
  expect((await api.snapshot()).invoices.length).toBe(before);
  fireEvent.click(confirm);
  expect(
    await screen.findByText(/Created \d+ unpaid invoices/),
  ).toBeInTheDocument();
  expect(confirm).toBeDisabled();
});
it("displays unauthorized Google failure state", async () => {
  render(
    <MemoryRouter initialEntries={["/login/error?error=userNotFound"]}>
      <App />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("heading", { name: "Unable to sign in" }),
  ).toBeInTheDocument();
});
