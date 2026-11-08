import { beforeEach, describe, expect, it } from "vitest";
import { calculateEndDate, calculateDaysRemaining, today } from "../lib/dates";
import { canAccess, landing, navigation } from "../lib/permissions";
import { memberSchema, paymentSchema } from "../lib/validation";
import { api, auth, resetMock } from "../lib/api";
describe("calendar day expiry (inclusive final day, Asia/Kolkata)", () => {
  it("handles a one day plan", () =>
    expect(calculateEndDate("2026-04-01", 1, "DAY")).toBe("2026-04-01"));
  it("clamps month-end rather than using 30 days", () =>
    expect(calculateEndDate("2026-01-31", 1, "MONTH")).toBe("2026-02-27"));
  it("handles leap years", () =>
    expect(calculateEndDate("2024-02-29", 1, "YEAR")).toBe("2025-02-27"));
  it("uses calendar days across midnight", () => {
    expect(calculateDaysRemaining("2026-04-01", "2026-04-01")).toBe(0);
    expect(calculateDaysRemaining("2026-03-31", "2026-04-01")).toBe(-1);
  });
  it("sorts expired subscriptions first numerically", () =>
    expect(
      ["2026-04-04", "2026-03-30", "2026-04-01"].sort(
        (a, b) =>
          calculateDaysRemaining(a, "2026-04-01") -
          calculateDaysRemaining(b, "2026-04-01"),
      )[0],
    ).toBe("2026-03-30"));
  it("uses gym timezone", () =>
    expect(today(new Date("2026-03-31T20:00:00Z"))).toBe("2026-04-01"));
});
describe("permissions", () => {
  it("restricts finances and access management", () => {
    expect(canAccess("GYM_RECEPTIONIST", "/finances")).toBe(false);
    expect(canAccess("GYM_OWNER", "/access-management")).toBe(false);
    expect(canAccess("SUPER_ADMIN", "/access-management")).toBe(true);
  });
  it("only shows trainer navigation for trainer", () =>
    expect(
      navigation
        .filter((n) => n.roles.includes("GYM_TRAINER"))
        .map((n) => n.path),
    ).toEqual(["/trainer"]));
  it("selects correct landing", () => {
    expect(landing("GYM_RECEPTIONIST")).toBe("/members");
    expect(landing("GYM_TRAINER")).toBe("/trainer");
  });
});
describe("validation", () => {
  const member = {
    fullName: "Test Member",
    email: "member@example.com",
    phone: "9876543210",
    joiningDate: today(),
    planId: "g1",
    startDate: today(),
    trainerId: "",
    ptPlanId: "",
    ptStartDate: today(),
    notes: "",
  };
  it("validates member contact fields", () => {
    expect(memberSchema.safeParse(member).success).toBe(true);
    expect(memberSchema.safeParse({ ...member, phone: "123" }).success).toBe(
      false,
    );
  });
  it("requires dependent PT fields", () => {
    expect(memberSchema.safeParse({ ...member, trainerId: "t1" }).success).toBe(
      false,
    );
    expect(
      memberSchema.safeParse({ ...member, ptPlanId: "pt01" }).success,
    ).toBe(false);
  });
  it("allows partial but not excess or nonpositive payments", () => {
    const p = {
      amount: 50,
      paymentDate: today(),
      method: "Cash",
      transactionReference: "",
      notes: "",
    };
    expect(paymentSchema(100).safeParse(p).success).toBe(true);
    for (const amount of [0, -1, 101])
      expect(paymentSchema(100).safeParse({ ...p, amount }).success).toBe(
        false,
      );
  });
});
describe("development adapter contracts — not backend security tests", () => {
  beforeEach(async () => {
    resetMock();
    await auth.demoLogin("admin@form.example");
  });
  it("scopes trainer data and hides invoices", async () => {
    await auth.demoLogin("rohan@form.example");
    const db = await api.snapshot();
    expect(db.trainingSubscriptions.every((s) => s.trainerId === "t1")).toBe(
      true,
    );
    expect(
      db.members.every((m) =>
        db.trainingSubscriptions.some((s) => s.memberId === m.id),
      ),
    ).toBe(true);
    expect(db.invoices).toHaveLength(0);
    expect(db.gymSubscriptions).toHaveLength(0);
    await expect(api.accessAssignments.list()).rejects.toThrow("permission");
  });
  it("allows a shared PT plan with a separately chosen active trainer", async () => {
    const member = await api.members.create({
      fullName: "Test Member",
      email: "test@example.com",
      phone: "9876543210",
      joiningDate: today(),
      planId: "g1",
      startDate: today(),
      trainerId: "t2",
      ptPlanId: "pt01",
      ptStartDate: today(),
      notes: "",
    });
    const assignment = (await api.snapshot()).trainingSubscriptions.find(
      (s) => s.memberId === member,
    );
    expect(assignment?.trainerId).toBe("t2");
    expect(assignment?.planId).toBe("pt01");
  });
  it("previews without creating invoices and runs idempotently", async () => {
    const before = await api.snapshot();
    const preview = await api.billing.preview();
    expect(preview.length).toBeGreaterThan(0);
    expect((await api.snapshot()).invoices.length).toBe(before.invoices.length);
    const count = await api.billing.run("same-key");
    expect(count).toBeGreaterThan(0);
    expect(await api.billing.run("same-key")).toBe(0);
    expect(await api.billing.run("other-key")).toBe(0);
    expect(await api.billing.preview()).toHaveLength(0);
    const after = await api.snapshot();
    expect(after.payments).toEqual(before.payments);
    expect(after.gymSubscriptions).toEqual(before.gymSubscriptions);
    expect(
      after.invoices
        .slice(before.invoices.length)
        .every((i) => i.status === "UNPAID"),
    ).toBe(true);
  });
  it("PT catalogue edits and removal retain all historical and financial mock records", async () => {
    const before = await api.snapshot();
    const plan = before.personalTrainingPlans.find((p) =>
      before.trainingSubscriptions.some((s) => s.planId === p.id),
    )!;
    await api.personalTrainingPlans.update(plan.id, {
      ...plan,
      price: 8000,
      duration: 60,
    });
    expect(await api.personalTrainingPlans.delete(plan.id)).toEqual({
      id: plan.id,
      mode: "REMOVED_FROM_CATALOG",
    });
    expect(
      (await api.personalTrainingPlans.list()).some((p) => p.id === plan.id),
    ).toBe(false);
    const after = await api.snapshot();
    expect(after.trainingSubscriptions).toEqual(before.trainingSubscriptions);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.payments).toEqual(before.payments);
    expect(after.payoutConfigurations).toEqual(before.payoutConfigurations);
    await expect(
      api.personalTrainingPlans.update(plan.id, plan),
    ).rejects.toThrow("not found");
    await expect(api.personalTrainingPlans.create({ ...plan })).rejects.toThrow(
      "already exists",
    );
  });
  it("PT catalogue supports free plans, rejects month approximations and permanently deletes unused plans", async () => {
    const values = {
      name: "Free PT trial",
      price: 0,
      duration: 7,
      durationUnit: "DAY" as const,
      description: "",
      isActive: true,
    };
    const plan = await api.personalTrainingPlans.create(values);
    expect(plan.price).toBe(0);
    await expect(
      api.personalTrainingPlans.create({ ...values, durationUnit: "MONTH" }),
    ).rejects.toThrow("fixed calendar days");
    expect(await api.personalTrainingPlans.delete(plan.id)).toEqual({
      id: plan.id,
      mode: "DELETED",
    });
    expect(
      (await api.snapshot()).personalTrainingPlans.some(
        (p) => p.id === plan.id,
      ),
    ).toBe(false);
    await expect(api.personalTrainingPlans.delete(plan.id)).rejects.toThrow(
      "not found",
    );
  });
  it("trainer sessions cannot manage the PT catalogue", async () => {
    const plan = (await api.personalTrainingPlans.list())[0];
    await auth.demoLogin("rohan@form.example");
    await expect(api.personalTrainingPlans.list()).rejects.toThrow(
      "permission",
    );
    await expect(api.personalTrainingPlans.delete(plan.id)).rejects.toThrow(
      "permission",
    );
  });
  it("member onboarding retries create exactly one member and preserve server-selected terms", async () => {
    const input = {
      fullName: "New Member",
      email: "",
      phone: "",
      joiningDate: today(),
      planId: "g1",
      startDate: today(),
      trainerId: "",
      ptPlanId: "",
      ptStartDate: today(),
      notes: "",
    };
    const key = crypto.randomUUID();
    const id = await api.members.create(input, key);
    expect(await api.members.create(input, key)).toBe(id);
    expect(
      (await api.snapshot()).gymSubscriptions.filter((s) => s.memberId === id),
    ).toHaveLength(1);
    await expect(
      api.members.create({ ...input, fullName: "Different" }, key),
    ).rejects.toThrow("different member details");
  });
  it("member contact edits and deletion retain all purchased and financial history", async () => {
    const before = await api.snapshot();
    const member = before.members[0];
    await api.members.update(member.id, { notes: "Corrected note" });
    expect((await api.members.get(member.id)).member.notes).toBe(
      "Corrected note",
    );
    expect(await api.members.delete(member.id)).toEqual({
      id: member.id,
      mode: "REMOVED_FROM_DIRECTORY",
    });
    expect(
      (await api.members.list()).members.some((m) => m.id === member.id),
    ).toBe(false);
    const after = await api.snapshot();
    expect(after.gymSubscriptions).toEqual(before.gymSubscriptions);
    expect(after.trainingSubscriptions).toEqual(before.trainingSubscriptions);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.payments).toEqual(before.payments);
    expect(after.accessAssignments).toEqual(before.accessAssignments);
    await expect(api.members.get(member.id)).rejects.toThrow("not found");
  });
  it("member options expose active shared plans while trainer sessions cannot use staff member CRUD", async () => {
    expect(
      (await api.members.options()).membershipPlans.length,
    ).toBeGreaterThan(0);
    await auth.demoLogin("rohan@form.example");
    await expect(api.members.list()).rejects.toThrow("permission");
    await expect(api.members.delete("m1")).rejects.toThrow("permission");
  });
  it("trainer profile creation/contact edits never fabricate login access or rewrite history", async () => {
    const before = await api.snapshot();
    const trainer = await api.trainers.create({
      name: "New Coach",
      email: "",
      phone: "",
      isActive: true,
    });
    expect(trainer.hasLoginAccess).toBe(false);
    expect(trainer.assignedMembersCount).toBe(0);
    await api.trainers.update("t1", { email: "contact-only@example.com" });
    const after = await api.snapshot();
    expect(after.accessAssignments).toEqual(before.accessAssignments);
    expect(after.trainingSubscriptions).toEqual(before.trainingSubscriptions);
    expect(after.invoices).toEqual(before.invoices);
    expect((await api.trainers.get("t1")).trainer.email).toBe(
      "contact-only@example.com",
    );
    await expect(
      api.trainers.update("missing", { name: "Absent" }),
    ).rejects.toThrow("not found");
  });
  it("trainer deactivation prevents new PT assignment but keeps login grants and historical purchases", async () => {
    const before = await api.snapshot();
    await api.trainers.update("t1", { isActive: false });
    expect((await api.snapshot()).accessAssignments).toEqual(
      before.accessAssignments,
    );
    expect((await api.trainers.get("t1")).assignments.length).toBeGreaterThan(
      0,
    );
    await expect(
      api.members.create({
        fullName: "Test Member",
        email: "test@example.com",
        phone: "9876543210",
        joiningDate: today(),
        planId: "g1",
        startDate: today(),
        trainerId: "t1",
        ptPlanId: "pt01",
        ptStartDate: today(),
        notes: "",
      }),
    ).rejects.toThrow("active trainer");
  });
  it("future trainer commissions preserve historical configuration and reject retroactive/conflicting schedules", async () => {
    const before = await api.snapshot();
    const effectiveFrom = calculateEndDate(today(), 2, "DAY");
    const rule = await api.trainers.scheduleCommission("t1", {
      commissionRate: 55.25,
      effectiveFrom,
    });
    expect(rule.value).toBe(55.25);
    expect((await api.trainers.get("t1")).payoutRules).toContainEqual(rule);
    await expect(
      api.trainers.scheduleCommission("t1", {
        commissionRate: 50,
        effectiveFrom: today(),
      }),
    ).rejects.toThrow("future");
    await expect(
      api.trainers.scheduleCommission("t1", {
        commissionRate: 50,
        effectiveFrom,
      }),
    ).rejects.toThrow("require review");
    expect((await api.snapshot()).payoutConfigurations).toEqual(
      before.payoutConfigurations,
    );
    await auth.demoLogin("desk@form.example");
    expect((await api.trainers.get("t1")).payoutRules).toBeUndefined();
    await expect(
      api.trainers.scheduleCommission("t1", {
        commissionRate: 40,
        effectiveFrom,
      }),
    ).rejects.toThrow("permission");
    await auth.demoLogin("rohan@form.example");
    await expect(api.trainers.list()).rejects.toThrow("permission");
  });
  it("revalidates remaining balance and records partial payment", async () => {
    const invoice = (await api.snapshot()).invoices.find(
      (i) => i.status === "UNPAID",
    )!;
    const payment = {
      invoiceId: invoice.id,
      amount: 500,
      method: "Cash" as const,
      paymentDate: today(),
      transactionReference: "",
      notes: "",
    };
    await api.payments.create(payment);
    const next = (await api.snapshot()).invoices.find(
      (i) => i.id === invoice.id,
    )!;
    expect(next.status).toBe("PARTIAL");
    expect(next.outstandingAmount).toBe(invoice.outstandingAmount - 500);
    await expect(
      api.payments.create({ ...payment, amount: invoice.outstandingAmount }),
    ).rejects.toThrow();
  });
  it("prevents removing last admin", async () => {
    await expect(api.accessAssignments.revoke("a1")).rejects.toThrow(
      "last active",
    );
  });
  it("rejects unauthorized emails", async () => {
    await expect(auth.demoLogin("unknown@example.com")).rejects.toThrow(
      "not authorized",
    );
  });
  it("denies receptionist reports and access mutations", async () => {
    await auth.demoLogin("desk@form.example");
    await expect(api.finances.summary()).rejects.toThrow("permission");
    await expect(api.accessAssignments.revoke("a1")).rejects.toThrow(
      "permission",
    );
  });
});
