import { useQueryClient } from "@tanstack/react-query";

export function useMemberRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [
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
        "fees-due",
        "financial-invoice",
        "finances",
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
}
