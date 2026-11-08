# Fees Due and Finances: deployment, API and integrity

Status: application code implemented; database integration **BLOCKED — PENDING
MANUAL MIGRATION**. Unit/mock/static checks are not a database deployment.

**ALL NEW SQL MIGRATIONS HAVE BEEN CREATED BUT NOT APPLIED.**

## Migration 009 — CREATED — NOT APPLIED — AWAITING MANUAL REVIEW

File: `backend/migrations/009_fees_and_finances.sql`. Requires the supplied base
schema and migrations **001 through 008**, in order. Do not replay the base schema,
edit older migrations, reset databases or run the existing `.mjs` SQL runners as
part of this task. No new migration has been executed against any database.

Changes:

- Existing payments gain notes; refunds gain refund/reversal classification;
  expenses gain payment date/method, version and reversal timestamp.
- Adds `financial_requests`, `financial_events`, `refund_allocations`, and
  `invoice_adjustments`. No duplicate invoice/payment/expense ledger is created.
- Adds one-charge-per-subscription indexes and refund/adjustment integrity checks.
  Existing IDs, charges, receipts, members and trainer payouts are retained.
- Replaces `invoice_balances` without changing its columns/types: billed is original
  charge less explicit adjustments; allocated is completed allocations less
  line-attributed refunds. Existing member views therefore see corrected balances.
- Adds automatic new-purchase invoicing and onboarding-actor attribution triggers.
  Free subscriptions create no invoice/debt. Existing unbilled subscriptions are
  listed for **explicit owner review**, not automatically invoiced.
- Adds checked `financial_read`, `financial_mutate`, `financial_request_status`
  RPCs and private helpers/triggers. Locks coordinate with 008's member lifecycle.
- Enables RLS/revokes browser access and raw service-role ledger writes. Pins
  definer search paths, including deferred constraint validation functions.
  Checked RPCs, not browser Supabase sessions, are the financial boundary.
- Posted invoices/items/payments/allocations/refunds/adjustments/audit records are
  append-only. Only the onboarding actor may be filled on a previously unattributed
  invoice. There is no posted-transaction DELETE endpoint.

### Preflight and risks (developer action)

1. Back up the database and inventory actual applied migrations. Check schema
   drift against `gym_schema.sql` and 001–008; no live schema was inspected here.
   A preflight also aborts on non-finite legacy numeric money (PostgreSQL NaN/
   Infinity); reconcile it explicitly rather than rendering plausible totals.
2. Review existing `invoice_items` grouped by non-null `member_plan_id` and
   `member_trainer_plan_id`. Multiple charge lines for one subscription make the
   unique index fail atomically. Reconcile legacy recurring/duplicate billing
   deliberately; **do not delete records to force the migration through**.
3. For receipts with refunds, compare payment amount with summed allocations.
   Migration aborts if the original refunded receipt is not fully allocated.
   Existing refunds gain deterministic FIFO line attribution ordered by allocation
   creation time/UUID, then refund timestamp/UUID. Review this allocation policy,
   especially where historical trainer settlement exists. It never changes the
   original payment/refund amounts or payout records.
4. Inspect legacy paid/void expenses missing payment facts. Migration does not
   invent cash dates/methods; such rows produce reconciliation warnings and are
   excluded from date-based cash reporting until separately reviewed/corrected.
5. Review integrations that write raw ledger tables: privileges are intentionally
   tightened. This release records confirmed offline cash/UPI/card/bank receipts;
   it is **not** a payment gateway or pending-payment reconciliation implementation.
6. Plan a maintenance window for indexes, DDL locks, historical refund allocation
   and privilege changes. Global financial/member locks favor correctness for this
   single gym over high write throughput. Review backups and rollback procedures.

Only the developer should execute the reviewed SQL, e.g. from `backend/`:

```sh
# Manual developer operation ONLY, after review, backup and prerequisites:
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/009_fees_and_finances.sql
```

Alternatively use the Supabase SQL editor as the migration owner. The transaction
must succeed in full; do not bypass failures/constraints. Record the deployment
version, refresh PostgREST's schema cache (the file includes NOTIFY), restart the
backend and run the post-application checklist in [financial_testing.md](financial_testing.md).

## HTTP contracts

All reads require a live cookie-backed Google session and current database grants.
All writes additionally require the configured frontend `Origin`. Actor IDs,
receipt status, invoice prices and snapshot terms are server-owned.

| Method | Path | Access / behavior |
|---|---|---|
| GET | `/fees-due` | Staff; KPIs, obligations, archived profiles, unbilled review |
| GET | `/fees-due/{invoiceId}` | Staff; lines, original payments, refunds, refundable amounts |
| POST | `/fees-due/{invoiceId}/payments` | Staff; confirmed full/partial receipt |
| POST | `/financial-payments/{paymentId}/refunds` | Staff; partial refund or remaining-receipt reversal |
| POST | `/fees-due/{invoiceId}/adjustments` | Owner; unpaid-fee reduction / explicit discount |
| GET | `/finances` | Owner; cash KPIs, ledger, expense history, reports, audit |
| GET | `/finances/export` | Owner; all matching transaction rows as formula-safe CSV |
| POST | `/financial-expenses` | Owner; create draft |
| PATCH | `/financial-expenses/{id}` | Owner; replace editable draft fields using version |
| POST | `/financial-expenses/{id}/post` | Owner; confirm expense payment |
| POST | `/financial-expenses/{id}/reverse` | Owner; void draft or compensate paid expense |
| POST | `/financial-subscriptions` | Staff; new gym/PT purchase or renewal |
| POST | `/financial-subscriptions/{id}/cancel` | Staff; cancel membership, preserve charge |
| POST | `/financial-subscriptions/{id}/bill` | Owner; approve a historical unbilled purchase |
| POST | `/financial-members/{id}/restore` | Staff; restore inactive/deleted-directory profile |
| GET | `/financial-requests/{requestKey}` | Staff; only own committed result, or null |

Staff means owner, permanent Super Admin or receptionist. Owner means owner or
permanent Super Admin. Trainers never receive this financial dataset. There is no
multi-gym/tenant model in the repository; do not imply tenant isolation.

Every mutation accepts `requestKey` (UUID). UUIDs in paths identify existing rows.
Money must be a **decimal string**, e.g. `"1250.50"`, positive, at most two decimal
places, no exponents, at most `9999999999.99`. Unknown fields are rejected.

```json
{
  "requestKey": "f7e5c30d-4ac2-46b3-a69c-5e3fdf49b345",
  "amount": "500.25", "date": "2026-11-01", "method": "upi",
  "reference": "UPI-reference", "notes": "First installment"
}
```

- Payment: amount/date/method/reference/notes. Methods: cash, upi, card, bank, other.
  Nonblank references are unique per method/provider. No overpayment/credit wallet.
- Refund: amount/date/reason/reversal (boolean). Reversal must equal the **remaining
  refundable** amount, including after earlier partial refunds. Dates must not
  precede original receipt or exceed today. Posted amount/date/method are immutable.
- Adjustment: amount/reason. Can reduce only unpaid charges, never manufacture
  credit or hide money already collected. For a fully paid cancelled purchase:
  refund first, then separately authorize any charge waiver. No automatic proration.
- Expense create/edit: amount/incurredOn/category/description/reference; edits also
  require current `version`. Categories are Rent, Electricity, Equipment,
  Maintenance, Salaries, Cleaning, Marketing, Miscellaneous. Legacy categories stay
  readable; new writes use the supported catalogue. Future drafts are allowed.
- Expense post: date/method/version; payment date must be >= incurred date and <=
  today. Reverse: reason/version; void draft has no cash effect; paid reversal
  retains original paid date and offsets it on today's Asia/Kolkata date. Use it
  only when cash was returned/reversed, not for an unpaid reimbursement promise.
- Purchase: memberId/kind (`GYM` or `PT`)/planId/startDate, plus trainerId only for
  PT. Locks active catalogue/trainer and snapshots server prices/duration. Same
  member/type/plan/start is rejected even with a new request key. Overlapping
  different purchases are deliberately permitted (e.g. future plans); inspect dates.
- Cancel/historical bill: kind/reason. Restore: reason. No implicit debt waiver,
  payment, subscription extension or retrospective catalogue-price rewrite.

Success returns `{id, action}`. Errors: 401 session, 403 access/Origin, 404 missing,
422 invalid data, 409 balance/version/duplicate/settlement conflict, 503 missing
migration/database/network. SQL details are not returned. Retry ambiguous outcomes
with the original key and unchanged fields, not a new UUID.

### Filters and response semantics

Fees: search, memberId (UUID), status PAID/UNPAID/PARTIAL/OVERDUE/UPCOMING;
sort dueDate/memberName/total/paid/balance/lastPaymentDate. Payment state is distinct
from membership Active/Expired/Upcoming/Cancelled; archived members retain debts.
Overdue means positive balance and due date **before** today; due today is not overdue.

Finances: start/end (inclusive ISO dates, maximum 3660 days), search, type, method,
status; sort date/amount/type/entity/status. Both: page >=1, pageSize 1–100,
direction asc/desc. Stable UUID tie-breaks. Responses contain rows/total/page/pageSize.
Summary KPIs are independent of table search/status filters; report dates affect
cash reports. Expense drafts/history are returned independently of cash dates.

Reads use one checked dataset RPC (plus a fixed number of owner projections), no
per-row Supabase calls. HTTP pagination/filtering/reporting is server-side in
Python Decimal; the underlying single-gym dataset is currently loaded in memory.
For large histories, move equivalent aggregation/pagination into SQL rather than
truncating records or losing totals. This scalability work is a known limitation.

## Financial model and calculations

- Line charge = original invoice line minus owner-approved adjustments.
- Line net paid = completed original allocations minus refund allocations.
- Invoice balance = summed net charges minus summed net paid. Only issued invoices
  contribute receivables. No independently stored mutable balance.
- Payment allocation is deterministic by line UUID; refund allocation is FIFO by
  original allocation timestamp/UUID. There is no floating proportional split.
- Collections = completed receipts dated in range minus refunds/reversals dated in
  range. A refund of a previous-month receipt reduces the refund month's cash.
- Expenses = dated paid expenses minus dated returned/reversed expenses. Drafts
  contribute nothing. Reversed paid expense's original cash outflow is retained.
- Net cash flow = net collections − net expenses − actual paid trainer payout
  items. This is **not accounting profit**, earned revenue or accrued payroll.
- Receivables are current outstanding balances across all issued invoices, including
  future-due/expired/archived debts; they are not historical period-end balances.
- Monthly trends, payment methods, purchased-plan descriptions and expense categories
  use those same underlying transactions. Plan labels come from invoice snapshots,
  not the edited catalogue. Unallocated legacy receipts generate a warning; cash
  totals remain actual receipts, with no invented plan attribution.
  Further collection/fee adjustment against an invoice with incompletely allocated
  legacy receipts is blocked, avoiding collection against an uncertain balance.
- Current-month metrics always mean current Asia/Kolkata calendar month, regardless
  of selected range. Backdated posting changes the selected historical cash period;
  audit created timestamps remain actual recording times.

Refunds touching **any non-cancelled trainer payout reservation**, including paid
payouts, are blocked pending settlement review. Do not delete payout items to
override the block. The existing trainer dashboard conservatively flags refunded
collections for review; it does not invent negative/retroactive commissions.
Payout generation/recovery remains outside this release; actual paid payouts are
included in Finances without estimating fixed salaries.

## Concurrency, deletion and retries

All financial mutations take 008's member advisory lock, then the financial lock,
then affected member/invoice/payment/expense row locks. Checked reads also take the
financial lock for consistent multi-projection datasets. Duplicate key replay
requires the same actor, action, target and normalized fields and returns the
stored result. Overpayments/refunds and stale expense versions fail atomically.
This design still requires native multi-connection verification after migration.

Existing deletion archives referenced profiles; it never deletes debts or receipt
history. Payments/refunds against existing invoices remain possible after archival
or expiry; new subscriptions require restoration/active member. Repeated deletion
returns not-found. Restore does not recreate a physically deleted unused profile.
Contacts can still be edited without changing subscriptions or invoices.

Frontend keys use per-actor/URL SHA-256 form digests plus UUIDs in session storage;
no financial form contents or credentials are stored. Rapid clicks are guarded
synchronously. Network/5xx failures keep keys. If fields change after an ambiguous
failure, the client first checks the original committed result; if it succeeded,
it refreshes balances and requires review before another entry. Clearing browser
storage or manually issuing a new key is not an idempotent retry. An absent lookup
result does not prove a delayed request cannot arrive: edited submissions remain
blocked until an unchanged retry resolves the original outcome.

Mutations invalidate fee/invoice/finance/member/detail/catalogue/trainer/dashboard
caches; member create/edit/delete also invalidate financial queries. Production
financial pages never call `/gym/workspace` or use the development financial demo.
