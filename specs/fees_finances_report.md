# Fees Due and Finances implementation report

Application code is implemented. Deployment and database correctness verification
remain conditional on developer review/application of migration 009.

**ALL NEW SQL MIGRATIONS HAVE BEEN CREATED BUT NOT APPLIED.** No new migration was
executed against any database, including disposable databases. Existing work was
preserved; no database reset, transaction deletion, git commit or push was performed.

## 1. Documentation and architecture reviewed

- `backend/docs/implementation_Details.md` read before implementation.
- All six module guides: `trainer_dashboard.md`, `members.md`,
  `membership_plans.md`, `trainer_plans.md`, `trainers.md`, `access_management.md`.
- `backend/docs/DATABASE_DESIGN.md` and full initial `gym_schema.sql`.
- **All eight** existing migrations 001–008, in chronological order. The repository
  contains eight existing files, rather than the approximately seven in the task.
- Backend/frontend READMEs, `frontend/IMPLEMENTATION.md`, prior three feature specs,
  recursively located Markdown files (root README is empty), current APIs/auth,
  frontend adapters/DTOs/routes/permissions/query/UI patterns and representative
  backend/frontend/test-runner implementations.
- Plan written before feature edits: `specs/fees_finances_design.md`.

Resolved discrepancies: working Google identity columns and live grants replace
the old auth proposal; PT plans remain a shared catalogue with separately selected
trainers; expiry-only mock billing/proportional browser revenue/guessed fixed
payouts are not production policy. Existing schema/migrations were not rewritten.

## 2. Modules completed in source

### Fees Due

Real dedicated queries replace workspace/mock financial data. Dashboard shows
current outstanding/overdue fees, owing members, net month collections and
partial/paid/upcoming counts. All issued obligations, including paid, expired and
archived-member records, support search, member selection, status filtering,
sorting and backend pagination. Membership and payment status remain separate.

Invoice details show original/net charges, adjustments, original receipts,
refundable balances, references, notes, actors and refund/reversal provenance.
Full/partial collection, controlled refund/reversal, owner fee adjustment,
reviewed historical charge approval, archived-member restoration and new gym/PT
purchase/renewal/cancellation controls are implemented. Unknown legacy allocations
block further collection/adjustment until reconciled.

### Finances

Owner/Super Admin dashboard, transaction ledger with filtering/sorting/pagination,
transaction/audit details, versioned expense drafts, posting/payment facts,
void/reversal confirmation, monthly trends, actual trainer payouts, method/plan/
category reports, receivables summary and full filtered transaction CSV.

Outstanding debt is never collections. Refunds and returned expense payments use
their own dates. Net cash flow is explicitly not accounting profit. No fixed
trainer payout is guessed from a selected reporting interval.

## 3. Important files

Backend:

- New `backend/migrations/009_fees_and_finances.sql`.
- New `backend/Routes/financialRoutes.py`, `backend/schemas/financial.py`,
  `backend/financial_service.py`; registration in `backend/main.py`.
- New tests: `test_financial_routes.py`, `test_financial_service.py`,
  `test_financial_sql_static.py`, `test_financial_e2e.py` under `backend/tests/`.

Frontend:

- Completed `features/payments/FeesPage.tsx`, `features/finances/FinancesPage.tsx`.
- New `features/payments/financialShared.tsx`, `SubscriptionDialog.tsx`,
  `features/finances/ExpenseDialog.tsx`, `lib/financial.ts`,
  `lib/financialApi.ts`, `types/financial.ts`, `tests/financial.test.tsx`.
- Small integration changes to `features/members/MembersPage.tsx`,
  `useMemberRefresh.ts` and shared `app.css`. Existing AppShell/sidebar/route guards
  were reused unchanged; no working module was redesigned.

Documentation:

- New `backend/docs/fees_due.md`, `finances.md`, `fees_finances.md`,
  `financial_testing.md`, design plan and this report.
- Updated implementation guide, Members guide, database-proposal warning, both
  component READMEs, frontend implementation guide and backend README.
- `.gitignore` now includes test source files while retaining cache exclusions;
  earlier regression tests were not deleted or overwritten.

## 4. Backend, authorization and database integration

FastAPI follows existing live Google-session/role guards, write-Origin checks,
synchronous Supabase RPC execution in the threadpool, safe error mapping and
closed request schemas. Money crosses new APIs as validated decimal strings;
Python Decimal and PostgreSQL numeric perform arithmetic. Response contracts and
OpenAPI are included. A fixed checked dataset RPC avoids per-row HTTP queries.

Staff can manage fees and subscriptions; only owner/Super Admin can read Finances,
manage expenses, waive fees or approve historical charges. Trainers are denied.
Actor identity is server-owned and checked against live DB grants again inside
RPCs. Raw browser financial access and raw service-role financial writes are
revoked. This is a single-gym system, not a tenant-isolation implementation.

See `backend/docs/fees_finances.md` for the full endpoint/request/filter table.

## 5. Frontend integration

Existing React/TanStack Query/UI/native-dialog patterns are retained. Real financial
APIs have no seed fallback. Forms validate exact amounts, block repeated submits
synchronously and keep per-actor/operation UUID retry keys across ambiguous
failures/dialog close/reload using session-stored hashes, not stored form data.
Edited ambiguous requests first resolve the original operation; absent results do
not authorize sending a potentially duplicated changed request.

Success invalidates fees/invoices/reports/member/detail/catalogue/trainer/dashboard
queries; member mutations also invalidate financial queries. Financial reads
refresh on focus and every minute while active. Initial loading, empty/error/retry
states, confirmations and mutation feedback use shared components. Existing
Members details exposes renewal/cancellation and member-filtered fees navigation.

## 6. SQL migration prepared

**`backend/migrations/009_fees_and_finances.sql` — CREATED — NOT APPLIED — AWAITING
MANUAL REVIEW**. Requires base schema plus 001–008; apply only after those approved
prerequisites. Do not replay the initial schema on an existing database.

- Extends payments/refunds/expenses; adds request/audit, refund attribution and
  unpaid-charge adjustment controls without duplicating existing ledgers.
- Adds one-charge-per-subscription uniqueness, immutable posted-history and purchase
  snapshot triggers, guarded expense transitions, complete new receipt/refund
  allocation checks, nonempty issue checks and bounded adjustment checks.
- Updates `invoice_balances` and `check_payment_allocation`; hardens deferred
  `check_refund_total` permissions/search path. Existing dependent view contracts
  are retained. New checked RPCs: `financial_read`, `financial_mutate`,
  `financial_request_status`, plus private helpers/triggers.
- New purchases automatically invoice once; free purchases have no debt. Prior
  unbilled purchases remain unchanged until explicit owner review/approval.
- Existing refunds receive documented deterministic FIFO line attribution only
  after complete original-allocation preflight; incompatible legacy rows abort
  the transaction for manual reconciliation, never deletion.

Risks: duplicate legacy subscription charge lines cause uniqueness failure;
incomplete refunded receipts require reconciliation; legacy expense dates/methods
remain unknown and cannot be fabricated; DDL/index locks and tightened privileges
may affect external integrations. Global serialization and full-history in-memory
reporting favor single-gym correctness over large-ledger throughput.

Manual instructions, preflight, execution command and verification checklist are
in `backend/docs/fees_finances.md` and `financial_testing.md`. The developer must
back up/review first, apply approved 009 manually, reload schema/restart, then
verify the database/application together. No SQL execution was used to make tests
pass, and no earlier migration file was edited.

## 7. Edge cases and integrity safeguards

Implemented controls, **not yet proven against the pending database schema**:

- Same key/actor/action/target/payload returns the stored result; altered replay
  fails. Invoice/member/payment locks and coordinated advisory locks serialize
  overpayment, refund, deletion, renewal and cancellation races.
- Original receipts, allocations, refunds, adjustments and audit entries cannot be
  silently edited/deleted. Refunds are positive compensating rows with exact line
  provenance and bounded refundable amount; repeated full reversals fail.
- Refunds tied to any non-cancelled trainer payout reservation require settlement
  review. Paid payout provenance is never removed to permit a refund.
- Member deletion retains referenced profiles/debts/history; restoration keeps the
  same IDs. Archive/expiry do not block collection of an existing valid obligation.
- Price changes never rewrite historical charges; renewals use new rows/snapshots;
  cancellation preserves debt; free purchases require no zero-value receipt.
- Expense paid facts are immutable; stale versions fail; returned cash offsets
  original outflows on its own date. Unknown legacy paid facts block reversal.
- Invalid precision/zero/negative/excess amounts, methods, IDs, reasons, dates and
  unauthorized fields are rejected. PostgreSQL remains the final balance arbiter.

Unit/mock-tested: exact validation, 500 generated monetary reconciliation cases,
calendar/leap/year/month boundaries, archived balances, current-vs-period metrics,
pending/failed/draft exclusion, original-history DTOs, frontend filters/forms/
confirmations/retries, role/Origin denial, safe failure responses and cache updates.

## 8. Verification results

| Command / check | Final result | Scope |
|---|---|---|
| Backend `python -m unittest discover -s tests` with temporary pglast on PYTHONPATH | **108 passed, 10 skipped/blocked; 118 discovered; 0 failures** | Pure/unit/mocked routes/auth/regressions + static SQL parsing |
| Frontend `npm test` | **103 passed**, 10 files, 0 failures | Rendered JSDOM/UI/mock/permission/domain regressions |
| `npm run lint` | Passed, no warnings | Frontend ESLint |
| `npm run typecheck` | Passed | Strict TypeScript |
| `npm run build` | Passed | TypeScript + production Vite bundle |
| PostgreSQL SQL/PLpgSQL parser | Passed | Static syntax only, no connection/execution |
| `git diff --check` | Passed | Whitespace |
| New real DB/constraint/RLS/concurrency tests | **BLOCKED — PENDING MANUAL MIGRATION** | No DB integrity claim |
| Ten real HTTP E2E scenarios | Implemented, all **BLOCKED — PENDING MANUAL MIGRATION** | Explicit disposable-installation opt-in required |
| Existing migration-executing `.mjs` runners | Not executed | Prohibited during this task |
| Authenticated browser/mobile/visual financial E2E, live OAuth, load tests | Not executed | No prepared migrated/authenticated environment/browser integration |

The actual backend command used the existing Python executable at
`/Users/aryaupatil/Random Shit/Venvs/DSshit/bin/python` and an isolated temporary
`pglast` tool directory on PYTHONPATH. No application dependency was added for it.
Earlier lint/UI-test failures were repaired and the relevant full suites rerun.
Earlier modules' historical PGlite results were not counted as this task's tests.

## 9. Financial integrity verification boundary

Calculation/HTTP/UI contracts and SQL syntax are verified at their stated levels.
Static review checks the intended FK/uniqueness/authorization/compensating-entry/
locking paths, but **cannot establish runtime PostgreSQL correctness**. In
particular, mock 409s do not prove real overpayment/refund enforcement, and parser
success does not prove schema binding, function privileges, deferred-trigger
behavior or concurrent commit safety. These remain explicit deployment gates.

## 10. Remaining developer actions

1. Review SQL, legacy-data preflight, FIFO attribution and privilege/DDL impacts;
   back up and confirm prerequisite versions.
2. Manually apply approved 009; never relax constraints or delete history to force
   installation. Reconcile incompatible legacy facts explicitly.
3. Run the ten opt-in HTTP scenarios against an authorized, manually migrated
   disposable installation, and native multi-session/privilege/rollback checks.
4. Verify all eight modules with real sessions and responsive browser interactions;
   reconcile reports/CSV with retained transactions and external cash records.
5. Review unbilled legacy purchases in the owner workflow. Consider SQL-side
   aggregation for large histories. Gateway processing, tax/accrual accounting and
   trainer payout generation/recovery are not claimed by this release.
