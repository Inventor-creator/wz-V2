import type { Role } from "../types/domain";
export const roles: Role[] = [
  "SUPER_ADMIN",
  "GYM_OWNER",
  "GYM_RECEPTIONIST",
  "GYM_TRAINER",
];
export const roleLabel = (role: Role) =>
  role
    .replace("GYM_", "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
export const navigation = [
  {
    path: "/trainer",
    label: "Trainer Dashboard",
    icon: "dashboard",
    roles: ["SUPER_ADMIN", "GYM_OWNER", "GYM_TRAINER"],
  },
  {
    path: "/members",
    label: "Members",
    icon: "members",
    roles: ["SUPER_ADMIN", "GYM_OWNER", "GYM_RECEPTIONIST"],
  },
  {
    path: "/membership-plans",
    label: "Membership Plans",
    icon: "plans",
    roles: ["SUPER_ADMIN", "GYM_OWNER", "GYM_RECEPTIONIST"],
  },
  {
    path: "/trainers",
    label: "Trainers & PT Plans",
    icon: "trainers",
    roles: ["SUPER_ADMIN", "GYM_OWNER", "GYM_RECEPTIONIST"],
  },
  {
    path: "/fees-due",
    label: "Fees Due",
    icon: "fees",
    roles: ["SUPER_ADMIN", "GYM_OWNER", "GYM_RECEPTIONIST"],
  },
  {
    path: "/finances",
    label: "Finances",
    icon: "finances",
    roles: ["SUPER_ADMIN", "GYM_OWNER"],
  },
  {
    path: "/access-management",
    label: "Access Management",
    icon: "access",
    roles: ["SUPER_ADMIN"],
  },
];
export const canAccess = (role: Role, path: string) =>
  navigation
    .find((n) => path === n.path || path.startsWith(n.path + "/"))
    ?.roles.includes(role) ?? false;
export const landing = (role: Role) =>
  role === "GYM_TRAINER"
    ? "/trainer"
    : role === "GYM_RECEPTIONIST"
      ? "/members"
      : "/finances";
