import type { DurationUnit } from "../types/domain";
export const GYM_TIMEZONE = "Asia/Kolkata";
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: GYM_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
const parse = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const iso = (date: Date) => date.toISOString().slice(0, 10);
// Final day is inclusive: a one-day subscription ends on its start day.
export function calculateEndDate(
  start: string,
  duration: number,
  unit: DurationUnit,
): string {
  const d = parse(start);
  if (!Number.isFinite(d.getTime()) || duration < 1) return "";
  if (unit === "DAY") d.setUTCDate(d.getUTCDate() + duration);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + duration * (unit === "YEAR" ? 12 : 1));
    const last = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}
export function calculateDaysRemaining(end: string, current = today()) {
  return Math.round(
    (parse(end).getTime() - parse(current).getTime()) / 86400000,
  );
}
export const isMembershipExpired = (end: string) =>
  calculateDaysRemaining(end) < 0;
export const isMembershipExpiringSoon = (end: string) =>
  calculateDaysRemaining(end) >= 0 && calculateDaysRemaining(end) <= 7;
export const getMembershipStatus = (end: string) =>
  isMembershipExpired(end)
    ? "Expired"
    : isMembershipExpiringSoon(end)
      ? "Expiring Soon"
      : "Active";
export const dateLabel = (date: string) => {
  if (!date) return "—";
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (calendarDate ? parse(date) : new Date(date)).toLocaleDateString(
    "en-IN",
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: calendarDate ? "UTC" : GYM_TIMEZONE,
    },
  );
};
export const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
