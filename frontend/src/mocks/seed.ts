import type { Database } from "../types/domain";
import { today, iso } from "../lib/dates";
const relative = (days: number) => {
  const d = new Date(today() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
export function seed(): Database {
  const names = [
    "Aarav Sharma",
    "Priya Patel",
    "Rohan Mehta",
    "Ananya Iyer",
    "Vikram Singh",
    "Sneha Kulkarni",
    "Arjun Nair",
    "Ishita Desai",
    "Aditya Joshi",
    "Neha Verma",
    "Karan Malhotra",
    "Diya Shah",
    "Rahul Rao",
    "Meera Reddy",
    "Kabir Gupta",
    "Saanvi Kapoor",
  ];
  const membershipPlans = [
    {
      id: "g1",
      name: "30-day Essential",
      price: 2500,
      duration: 30,
      durationUnit: "DAY" as const,
      description: "Full gym access, group classes and locker facilities.",
      isActive: true,
    },
    {
      id: "g2",
      name: "90-day Performance",
      price: 6500,
      duration: 90,
      durationUnit: "DAY" as const,
      description: "Build consistency with 90 days of unrestricted training.",
      isActive: true,
    },
    {
      id: "g3",
      name: "365-day Commitment",
      price: 22000,
      duration: 365,
      durationUnit: "DAY" as const,
      description: "365 days of movement. Our best value membership.",
      isActive: true,
    },
  ];
  const trainers = ["Rohan Deshmukh", "Aisha Khan", "Dev Patel"].map(
    (name, i) => ({
      id: "t" + (i + 1),
      userId: "u" + (i + 2),
      name,
      email: name.toLowerCase().replace(" ", ".") + "@example.com",
      phone: "98765432" + (10 + i),
      isActive: true,
    }),
  );
  const personalTrainingPlans = trainers.flatMap((_, i) =>
    [1, 2].map((n) => ({
      id: `pt${i}${n}`,
      name:
        (n === 1 ? "Strength Foundations" : "Performance Plus") + ` ${i + 1}`,
      price: n === 1 ? 6000 : 10000,
      duration: 30,
      durationUnit: "DAY" as const,
      description:
        n === 1
          ? "One-to-one strength training over 30 days."
          : "30 days of personalised training and progress reviews.",
      isActive: true,
    })),
  );
  const members = names.map((fullName, i) => ({
    id: "m" + (i + 1),
    fullName,
    email: fullName.toLowerCase().replace(" ", ".") + "@example.com",
    phone: "98765000" + String(i + 10),
    joiningDate: relative(-160 + i * 6),
    status: "ACTIVE" as const,
    notes: "",
  }));
  const gymSubscriptions = members.map((m, i) => ({
    id: "gs" + i,
    memberId: m.id,
    planId: membershipPlans[i % 3].id,
    startDate: relative(-35 - i),
    endDate: relative([-12, -4, 0, 3, 6, 18, 45, 82][i % 8]),
    priceAtPurchase: membershipPlans[i % 3].price,
    status: "ACTIVE" as const,
  }));
  const trainingSubscriptions = members
    .filter((_, i) => i % 3 !== 2)
    .map((m, i) => ({
      id: "ts" + i,
      memberId: m.id,
      trainerId: trainers[i % 3].id,
      planId: personalTrainingPlans[(i % 3) * 2].id,
      startDate: relative(-28),
      endDate: relative([-8, 4, 12, 24][i % 4]),
      priceAtPurchase: 6000,
      status: "ACTIVE" as const,
    }));
  const invoices = members.slice(0, 10).map((m, i) => {
    const total = i % 2 ? 6000 : 2500;
    return {
      id: "INV-" + (1041 + i),
      memberId: m.id,
      invoiceDate: relative(-25 + i * 2),
      dueDate: relative(-18 + i * 2),
      totalAmount: total,
      outstandingAmount: i < 3 ? 0 : i === 3 ? 3000 : total,
      status:
        i < 3
          ? ("PAID" as const)
          : i === 3
            ? ("PARTIAL" as const)
            : ("UNPAID" as const),
      lineItems: [
        {
          id: "li" + i,
          invoiceId: "INV-" + (1041 + i),
          subscriptionId: "historical-" + i,
          feeType: i % 2 ? ("PT" as const) : ("GYM" as const),
          description: i % 2 ? "Strength Foundations" : "Monthly Essential",
          amount: total,
        },
      ],
    };
  });
  const payments = invoices
    .filter((i) => i.outstandingAmount < i.totalAmount)
    .map((v, i) => ({
      id: "PAY-" + (501 + i),
      invoiceId: v.id,
      memberId: v.memberId,
      amount: v.totalAmount - v.outstandingAmount,
      method: "UPI" as const,
      paymentDate: v.invoiceDate,
      transactionReference: "UPI-2026" + i,
      notes: "Membership collection",
    }));
  return {
    members,
    membershipPlans,
    trainers,
    personalTrainingPlans,
    gymSubscriptions,
    trainingSubscriptions,
    invoices,
    payments,
    accessAssignments: [
      {
        id: "a1",
        email: "admin@form.example",
        name: "Arya Patil",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        grantedBy: "System",
        grantedAt: relative(-100),
      },
      {
        id: "a2",
        email: "owner@form.example",
        name: "Nikhil Shah",
        role: "GYM_OWNER",
        status: "ACTIVE",
        grantedBy: "Arya Patil",
        grantedAt: relative(-80),
      },
      {
        id: "a3",
        email: "desk@form.example",
        name: "Priya Rao",
        role: "GYM_RECEPTIONIST",
        status: "ACTIVE",
        grantedBy: "Arya Patil",
        grantedAt: relative(-60),
      },
      {
        id: "a4",
        email: "rohan@form.example",
        name: "Rohan Deshmukh",
        role: "GYM_TRAINER",
        trainerId: "t1",
        status: "ACTIVE",
        grantedBy: "Arya Patil",
        grantedAt: relative(-40),
      },
    ],
    payoutConfigurations: [
      { trainerId: "t1", payoutType: "COMMISSION", commissionRate: 40 },
      { trainerId: "t2", payoutType: "COMMISSION", commissionRate: 45 },
    ],
  };
}
