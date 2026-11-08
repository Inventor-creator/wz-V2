import { z } from "zod";
export const memberProfileSchema = z.object({
  fullName: z.string().trim().min(2, "Enter a full name").max(160),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.union([z.email().max(254), z.literal("")])),
  phone: z
    .string()
    .trim()
    .max(32)
    .refine(
      (value) =>
        !value || /^\+?[1-9]\d{7,14}$/.test(value.replace(/[ -]/g, "")),
      "Enter a valid phone number",
    ),
  joiningDate: z.iso.date(),
  notes: z.string().trim().max(2000),
});
export const memberSchema = memberProfileSchema
  .extend({
    planId: z.string().min(1, "Select a gym plan"),
    startDate: z.iso.date(),
    trainerId: z.string(),
    ptPlanId: z.string(),
    ptStartDate: z.string(),
  })
  .superRefine((v, c) => {
    if (v.startDate < v.joiningDate)
      c.addIssue({
        code: "custom",
        path: ["startDate"],
        message: "Start cannot be before joining date",
      });
    if (v.trainerId && v.ptStartDate < v.joiningDate)
      c.addIssue({
        code: "custom",
        path: ["ptStartDate"],
        message: "Start cannot be before joining date",
      });
    if (
      v.trainerId &&
      (!v.ptPlanId || !z.iso.date().safeParse(v.ptStartDate).success)
    )
      c.addIssue({
        code: "custom",
        path: ["ptPlanId"],
        message: "Select a trainer plan and start date",
      });
    if (!v.trainerId && v.ptPlanId)
      c.addIssue({
        code: "custom",
        path: ["ptPlanId"],
        message: "Select a trainer first",
      });
  });
export const planSchema = z.object({
  name: z.string().trim().min(2).max(120),
  price: z.number().nonnegative().max(9999999999.99).multipleOf(0.01),
  duration: z.number().int().min(1).max(36500),
  durationUnit: z.enum(["DAY", "MONTH", "YEAR"]),
  description: z.string().trim().max(2000),
  isActive: z.boolean(),
});
export const trainerProfileSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.union([z.email().max(254), z.literal("")])),
  phone: z
    .string()
    .trim()
    .max(32)
    .refine(
      (value) =>
        !value || /^\+?[1-9]\d{7,14}$/.test(value.replace(/[ -]/g, "")),
      "Enter a valid phone number",
    ),
  isActive: z.boolean(),
});
export const paymentSchema = (balance: number) =>
  z.object({
    amount: z
      .number()
      .positive()
      .max(balance, "Amount exceeds outstanding balance"),
    paymentDate: z.iso.date(),
    method: z.enum(["Cash", "UPI", "Card", "Bank Transfer"]),
    transactionReference: z.string(),
    notes: z.string(),
  });
