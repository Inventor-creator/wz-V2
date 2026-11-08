# Fees Due and Finances implementation plan

## Review completed

Reviewed implementation_Details.md, both READMEs, frontend/IMPLEMENTATION.md,
all six module guides, DATABASE_DESIGN.md, prior feature specs, initial schema,
migrations 001–008 in order, route/auth/RPC conventions, financial adapters,
domain DTOs, routes/permissions, query/UI helpers and representative test suites.
The proposal's identity columns, trainer-owned plans and mock expiry billing are
not authoritative: the installed migration chain and checked Google-session RPCs
are. This is a single-gym application, not a tenant-isolated platform.

## Reuse and deliverables

- Reuse invoices/items, payments/allocations, refunds, expenses and trainer payout
  provenance, current session/Origin checks, threadpool RPC calls, AppShell,
  existing routes, TanStack Query and shared UI components.
- Add migration 009 only (SQL file, NEVER execute): audit/idempotency, refund
  allocations, refund-aware balances, immutable posted ledger, checked financial
  read/write RPCs, automatic subscription charges and controlled lifecycle APIs.
- Add backend financial schemas, pure Decimal reporting/filter/export helpers,
  and financial routes registered in main.py.
- Replace workspace-backed FeesPage/FinancesPage with dedicated real APIs,
  payment/history/refund, expense lifecycle, report/CSV and subscription controls.
- Add isolated Python/mock and frontend tests; retain all existing user work.

## Policy and security checkpoint

- Money crosses new APIs as decimal strings; PostgreSQL numeric and Python Decimal
  perform calculations. No browser proportional allocation or guessed salaries.
- New purchases issue one invoice per nonzero subscription at purchase snapshot;
  free subscriptions need no debt. Unique subscription charge indexes prevent
  duplication. Existing unbilled subscriptions are NOT silently backfilled:
  explicit reviewed reconciliation is required to avoid double billing legacy data.
- Refunds/reversals are positive compensating entries, line allocated, reopen debt,
  and retain original receipt. Refunding any allocation linked to non-cancelled
  payout records is blocked pending settlement review. No automatic prorating.
- Cancellation preserves charges; plan switching is cancellation plus new purchase.
  Discounts/write-offs use explicit owner adjustments, bounded by unpaid balance;
  overpaid cancellation requires a separate refund. Prices/dates on posted receipts
  and purchase snapshots cannot be edited.
- Staff may collect/refund; owner-only expenses, adjustments and full reports.
  Backend guards plus database live-actor checks; actor never accepted from client.
  Definer functions pin search_path and revoke PUBLIC/browser execution. RLS and
  privilege revocation close raw financial writes, including service-role writes.
  Origin check prevents cookie-authenticated cross-origin mutations. Audit all
  mutations. React text rendering escapes output; CSV escapes formula prefixes.
- Shared member advisory lock precedes financial lock and member/invoice/payment
  locks, coordinating 008 deletion/onboarding, payments, renewals and cancellation.
  Request UUID + actor/action/payload equality makes ambiguous network retries safe.
  Draft expenses use optimistic versions; paid expenses reverse, never disappear.
- Reports use Asia/Kolkata dates and inclusive requested ranges. Collections minus
  refunds minus paid expenses and actual paid trainer payouts is net cash flow,
  NOT accounting profit. Receivables are separate; drafts are not cash expenses.

## API surface

- GET /fees-due: dashboard + filtered/sorted/paginated obligations
- GET /fees-due/{invoice_id}: invoice, lines and full receipt/refund history
- POST /fees-due/{invoice_id}/payments: exact amount, date, method, reference, notes
- POST /financial-payments/{payment_id}/refunds: amount/reason/date/reversal flag
- GET /finances, GET /finances/export: KPIs, trends, breakdowns and transaction ledger
- POST /financial-expenses, PATCH /financial-expenses/{id}: draft create/edit
- POST /financial-expenses/{id}/post or /reverse: controlled expense lifecycle
- POST /financial-subscriptions: renewal/new gym or PT purchase
- POST /financial-subscriptions/{id}/cancel: preserve debt and history
- POST /fees-due/{id}/adjustments: owner-only unpaid-charge reduction
- POST /financial-members/{id}/restore: explicit restoration, no history rewrite

## Verification and risks

Run Python unit/mock tests, frontend tests, lint/typecheck/build, static SQL parsing
where available. Never invoke existing .mjs SQL runners: they apply migrations.
Real database atomicity, triggers, backfill compatibility, RLS, concurrency and all
database E2E scenarios remain BLOCKED — PENDING MANUAL MIGRATION. Add a manual
verification matrix. Legacy partially allocated receipts/refunds require review;
migration must fail safely rather than guess provenance. Review DDL locks on large
tables, existing direct integrations and historical payouts before deployment.
