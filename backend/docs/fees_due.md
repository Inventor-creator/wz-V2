# Fees Due

The renewal dialog provides visible **Gym membership** and **Personal training**
choices. Personal training exposes separate **Trainer plan** and **Trainer**
selectors, requires both, and lists active options only. Member search supports
name, member number/UUID, phone and email. Gym and PT renewals remain separate
atomic purchases; switching renewal type clears stale plan/trainer selections.

Dedicated implementation: `frontend/src/features/payments/FeesPage.tsx`,
`financialShared.tsx`, `SubscriptionDialog.tsx`, `src/lib/financialApi.ts`,
`src/lib/financial.ts`, and backend `Routes/financialRoutes.py`.

Staff can search/filter/sort/page all issued obligations, including paid ones,
select an invoice/member, inspect payment and refund history, record exact partial
or full payments, and explicitly refund/reverse receipts. Owners can authorize
unpaid-fee adjustments and reviewed historical charges. Archived profiles can be
restored without altering history. New/renewed gym/PT purchases issue their own
snapshot charges; cancellation preserves debts. Existing Members details link to
fees and expose new-purchase/cancellation controls, including free memberships.

KPIs: all outstanding/overdue issued balances, distinct owing members, current
calendar-month net collections, partial/paid/upcoming obligation counts. Membership
expiry/status is not payment status. Summary cards are independent of list filters.

Dependency: **009 CREATED — NOT APPLIED — AWAITING MANUAL REVIEW**.
All real-database integration/E2E checks remain **BLOCKED — PENDING MANUAL MIGRATION**.
See [fees_finances.md](fees_finances.md) for complete API, accounting, security,
legacy-data and deployment policies; [financial_testing.md](financial_testing.md)
for verification.
