import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { financialApi } from "./financialApi";
import { useAuth } from "../features/auth/AuthProvider";

export const methodOptions = ["cash", "upi", "card", "bank", "other"];
export const expenseCategories = [
  "Rent",
  "Electricity",
  "Equipment",
  "Maintenance",
  "Salaries",
  "Cleaning",
  "Marketing",
  "Miscellaneous",
];
export function paise(value: string): bigint {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(value))
    throw new Error("Enter an INR amount with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function amountError(value: string, maximum?: string) {
  try {
    const amount = paise(value);
    if (amount <= 0n || amount > 999999999999n)
      return "Enter a positive amount within supported limits.";
    if (maximum && amount > paise(maximum))
      return "Amount exceeds the current available balance.";
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}
export function inr(value: string) {
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid monetary response");
  const [, sign, whole, decimal = ""] = match;
  const grouped = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(BigInt(whole));
  return `${sign}₹${grouped}.${decimal.padEnd(2, "0")}`;
}
export function useFinancialCommand(done?: () => void) {
  const client = useQueryClient();
  const { user } = useAuth();
  const busy = useRef(false);
  const mutation = useMutation({
    mutationFn: async ({
      url,
      fields,
      method = "POST",
    }: {
      url: string;
      fields: Record<string, unknown>;
      method?: "POST" | "PATCH";
    }) => {
      const hash = async (value: unknown) =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify(value)),
            ),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
      const digest = await hash(fields);
      const storageKey =
        "wz-financial-request-" + (await hash([user?.id, method, url]));
      let stored: { key: string; digest: string } | null;
      try {
        stored = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      } catch {
        throw new Error(
          "Safe retry storage is unavailable. Enable session storage before recording financial entries.",
        );
      }
      if (stored && stored.digest !== digest) {
        // Resolve ambiguous earlier submissions before accepting edited fields.
        // The checked SQL lookup waits for the original financial transaction.
        const previous = await financialApi.requestStatus(stored.key);
        if (previous) {
          sessionStorage.removeItem(storageKey);
          await Promise.all(
            [
              "fees-due",
              "financial-invoice",
              "finances",
              "members",
              "member-details",
            ].map((key) => client.invalidateQueries({ queryKey: [key] })),
          );
          throw new Error(
            "The previous submission succeeded. Balances were refreshed. Review them before submitting another entry.",
          );
        }
        throw new Error(
          "The original outcome is still unconfirmed. Retry the original unchanged values before editing; an absent result does not prove a delayed request cannot arrive.",
        );
      }
      const key = stored?.key || crypto.randomUUID();
      try {
        // Only a digest and UUID are persisted, never form data or credentials.
        sessionStorage.setItem(storageKey, JSON.stringify({ key, digest }));
      } catch {
        throw new Error(
          "Safe retry storage is unavailable. Enable session storage before recording financial entries.",
        );
      }
      try {
        const result = await financialApi.command(
          url,
          { ...fields, requestKey: key },
          method,
        );
        sessionStorage.removeItem(storageKey);
        return result;
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response
          ?.status;
        // A definite 4xx response means this operation was rejected. Network/5xx
        // outcomes must retain their key until an unchanged retry resolves them.
        if (status && status >= 400 && status < 500)
          sessionStorage.removeItem(storageKey);
        throw error;
      }
    },
    onSuccess: async (result) => {
      await Promise.all(
        [
          "fees-due",
          "financial-invoice",
          "finances",
          "members",
          "member-details",
          "member-options",
          "membership-plans",
          "trainer-plans",
          "trainers",
          "trainer-details",
          "trainer-dashboard",
          "trainer-member",
          "workspace",
        ].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
      window.dispatchEvent(
        new CustomEvent("financial-command-completed", { detail: result }),
      );
      done?.();
    },
    onSettled: () => {
      busy.current = false;
    },
  });
  return {
    ...mutation,
    mutate: (...args: Parameters<typeof mutation.mutate>) => {
      // Acquire synchronously, before React's next render or async hashing.
      if (busy.current) return;
      busy.current = true;
      mutation.mutate(...args);
    },
  };
}
