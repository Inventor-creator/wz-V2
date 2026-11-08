# Finances

Owner/permanent-Super-Admin only; trainers and receptionists are denied by both
backend session guards and checked SQL RPCs. Frontend uses the existing protected
`/finances` route/sidebar and dedicated queries, never a production mock snapshot.

- Cash dashboard: gross/net collections, refunds, net paid expenses, actual trainer
  payouts, net cash flow, current receivables and current-calendar-month metrics.
- Transaction ledger: search, date/type/method/status filters, stable sorting,
  pagination, details, actor/references/notes and invoice-linked reversal workflows.
- Expenses: editable versioned drafts, categories, confirmed payment dates/methods,
  reference/description, void/reverse confirmations and retained audit history.
- Reports: monthly collections/expenses/payouts, collections by purchased-plan
  snapshot and method, expense categories, current outstanding-fee summary, CSV
  export of every matching transaction (not just the visible page).

No outstanding dues are counted as collections. No fixed trainer salary is guessed
per reporting period. Net cash flow is not accounting profit. Refund/reversal cash
and original receipts are independently dated; a reversed expense retains both
its original outflow and compensating returned cash. Table filters do not change
date-range report KPIs; expense draft/history listing is independent of cash dates.

Dependency: **009 CREATED — NOT APPLIED — AWAITING MANUAL REVIEW**.
All real-database integration/E2E checks remain **BLOCKED — PENDING MANUAL MIGRATION**.
See [fees_finances.md](fees_finances.md) for contracts, formulas, privileges,
deployment risks and limitations; [financial_testing.md](financial_testing.md)
for runnable and blocked checks.
