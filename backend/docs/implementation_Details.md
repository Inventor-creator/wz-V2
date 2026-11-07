# Gym database: implementation guide

Target: PostgreSQL 15+. Apply [`gym_schema.sql`](gym_schema.sql) to a new database. All money is `numeric(12,2)` in INR; dates for subscriptions are inclusive. This is an initial schema, not an in-place migration for an existing database. Inspect and map existing rows before adapting it.

## Model and relationships

| Area | Tables | Purpose |
| --- | --- | --- |
| Identity | `users`, `role_assignments` | Google sign-in identity and revocable owner/admin/trainer grants |
| People | `members`, `trainers` | Independent member and trainer profiles |
| Plans | `gym_plans`, `trainer_plans` | Editable catalog prices and durations |
| Subscriptions | `member_plans`, `member_trainer_plan` | Member assignments, dates and historical price snapshots |
| Billing | `billing_runs`, `invoices`, `invoice_items` | Batches, invoice headers and charge lines |
| Receipts | `payments`, `payment_allocations`, `refunds` | Receipts, line-level allocation and reversals |
| Settlement | `trainer_payout_rules`, `trainer_payouts`, `trainer_payout_items` | Policy, payout batches and collection provenance |
| Costs | `expenses` | Non-trainer operating costs |

`trainers.user_id` does not exist. A trainer can sign in only when an active `role_assignments` row links that `users.id` to `trainers.id` with `role='trainer'`. An active trainer grant is unique per user and per trainer. Owner/admin grants have `trainer_id IS NULL`. Revocation sets `revoked_at`, retaining history. A trainer profile can exist without login access. The application must check `users.active` and grant revocation on every privileged request.

Each `invoice_items` row belongs to the same member as its invoice and linked subscription, enforced by composite foreign keys. `gym` lines point to `member_plans`; `personal_training` lines point to `member_trainer_plan`; `other` lines have neither. Prices and descriptions are snapshots. Do not rewrite old items when a catalog price changes.

Each payment belongs to one invoice. `payment_allocations` ties it to individual items on that same invoice. This supports partial payments and exact gym versus PT revenue. An allocation can never exceed its payment or its invoice line; deferred triggers check these limits at commit. A payout item references one PT allocation and is unique across all payouts, so that allocation cannot earn a second payout item. The trigger verifies the payout trainer matches the PT assignment and the source payment is completed.

## Apply and migration order

1. Provision a database and an application role with only the needed privileges. Run `psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f gym_schema.sql` as a migration owner. The script uses `pgcrypto` for UUID generation; provision extension creation privilege or install the extension beforehand.
2. For an existing app, make an additive migration instead of replaying this initial script. Back up data, inventory existing IDs and foreign keys, add new tables/columns, backfill member and subscription IDs, reconcile historical money, validate constraints, then switch application writes. Remove any old `trainers.user_id` only after all trainer access has been mapped into active `role_assignments` rows. Do not guess identities from matching names.
3. Apply future changes as numbered, reviewed migrations in the same order in every environment. Run the schema migration before deploying code that uses it; deploy code that no longer uses an old column before dropping that column. Record migration versions with your migration framework. This script itself is intentionally not repeatable.
4. Smoke test role grants, member-consistent invoice lines, duplicate `billing_key`, duplicate payment idempotency key, over-allocation, duplicate payout source, and refund ceiling in a disposable database.

## Billing workflow and idempotency

Treat a billing cycle as an application-defined stable `cycle_key` such as `2026-11-monthly`; a unique constraint prevents two run records with the same key. A failed run can be resumed using the same record. The cycle key alone does not prevent duplicate charges: every intended line must have a deterministic `billing_key`, e.g. `gym:<subscription UUID>:<period start>:<period end>`. Use `INSERT ... ON CONFLICT (billing_key) DO NOTHING` while retrying a run. The key must not depend on a random invoice ID. Build one invoice per member and due date as appropriate, insert lines, verify nonempty totals, then mark it `issued` and the run `completed`, preferably in a transaction. An empty draft is harmless but must not be issued.

Renewal creates a **new** `member_plans` or `member_trainer_plan` row with its own dates and snapshot price. Keep historical subscriptions and invoices. Validate active plan and trainer status at creation in application logic. Decide whether overlapping subscriptions are allowed; if not, enforce that policy in a dedicated migration (for example, an exclusion constraint on date ranges), after checking existing data.

`invoices.status` describes only draft, issued or void. Paid/partial/unpaid is derived from issued line totals and completed payment allocations. The view `invoice_balances` supplies billed and allocated amounts; compute `billed - allocated` for outstanding. Do not store a second mutable balance or inferred payment status. Never issue an invoice with zero lines. After issue, treat its lines, amount, member and `billing_key` as immutable; corrections should use a documented credit or void/rebill workflow. Void only an invoice with no completed allocations or settle/refund it first. These workflow rules require application transactions or additional database procedures if clients can write directly.

For a gateway callback, verify the gateway signature, store its stable payment ID in `(provider, provider_payment_id)`, and use a request idempotency key. On a retry, return the existing payment rather than collecting twice. Mark a receipt completed only after confirmation and set `received_at`. Lock the payment and relevant invoice lines, insert allocations, and commit together. Never mark a completed, allocated payment failed later. The allocation trigger permits an unallocated completed payment while awaiting reconciliation; flag such cases operationally.

Refunds are separate rows and must total no more than the original completed payment. Keep the original payment and allocations for audit. For net cash reporting, subtract refunds; for net revenue by line, the application must assign refunds to original lines. This schema deliberately does **not** include `refund_allocations`, so exact net revenue by service after a partial refund is unavailable. Add that table, with same-invoice and total checks, before offering line-level partial refunds. If a refunded PT collection has already contributed to a paid trainer payout, handle recovery or adjustment explicitly; never delete the historical payout.

## Trainer payouts and expenses

Define a rule for each trainer and effective period. `percent` means a share of collected PT allocation; `fixed` needs a clearly specified business unit (for example, per paid assignment or per session) before use. Select the rule effective on collection date, calculate with decimal arithmetic, and copy `rule_kind`, `rule_value`, and calculated amount to each `trainer_payout_items` row. The schema records rule provenance, but it does not choose a rule or calculate the amount. Prevent overlapping active rule periods in the application or add an exclusion constraint after confirming the intended policy. Do not generate a payout item for a refunded or disputed receipt without a documented adjustment policy.

Build each trainer payout inside a transaction: lock eligible PT allocations, insert a period-specific payout, insert one item per eligible allocation, sum items for display, review, approve, then mark paid with `paid_at` and transfer reference. The unique `allocation_id` on payout items prevents a second settlement. `trainer_payouts` has a unique trainer/period pair; choose nonoverlapping periods in application logic. Draft/approved/paid transitions, freeze after approval, and amount reconciliation need guarded application writes or stored procedures. Expenses are separate from trainer payouts; include only `status='paid'` in cash cost reporting, and exclude `void`.

## Permissions and security

Authenticate Google ID tokens server-side: validate issuer, audience, expiry and subject; bind `google_subject` to the user. Email alone is not a reliable identity key for access grants. Do not let a client set `role_assignments`, `received_by`, `approved_by`, payment status, or financial amounts without server authorization. Only owner/super admin can grant/revoke roles; admin can manage members and billing according to product policy; trainer can read only their own profile, assignments and payouts. Enforce those checks in server endpoints and database access policies if clients query PostgreSQL directly. This SQL does not enable row-level security; never expose a broad database credential to browsers.

Use separate migration and app DB roles. Grant app access narrowly; consider stored procedures or a service layer for finance writes. Set a fixed `search_path`, use parameterized SQL, audit administrative changes, and keep gateway secrets outside the database. Minimize personal data, restrict exports/backups, and define retention for contact details and payment references. The schema stores transaction references, never card numbers or raw OAuth tokens.

## Example queries

Outstanding issued invoices (a negative balance should be investigated):

```sql
SELECT invoice_id, member_id, invoice_number, due_date,
       billed, allocated, billed - allocated AS outstanding
FROM invoice_balances
WHERE status = 'issued' AND billed > allocated
ORDER BY due_date, invoice_number;
```

Gross collected revenue by service, before refunds:

```sql
SELECT date_trunc('month', p.received_at) AS month,
       i.item_type, sum(a.amount) AS collected
FROM payment_allocations a
JOIN payments p ON p.id = a.payment_id
JOIN invoice_items i ON i.id = a.invoice_item_id
WHERE p.status = 'completed'
GROUP BY 1, 2 ORDER BY 1, 2;
```

Trainer access for an authenticated user (`$1` is a UUID):

```sql
SELECT ra.trainer_id
FROM role_assignments ra JOIN users u ON u.id = ra.user_id
WHERE ra.user_id = $1 AND ra.role = 'trainer'
  AND ra.revoked_at IS NULL AND u.active;
```

Unsettled PT collections eligible for payout, before refund/dispute policy filtering:

```sql
SELECT a.id AS allocation_id, mtp.trainer_id, a.amount AS collected_amount,
       p.received_at
FROM payment_allocations a
JOIN payments p ON p.id = a.payment_id AND p.status = 'completed'
JOIN invoice_items i ON i.id = a.invoice_item_id
JOIN member_trainer_plan mtp ON mtp.id = i.member_trainer_plan_id
WHERE NOT EXISTS (SELECT 1 FROM trainer_payout_items pi WHERE pi.allocation_id = a.id)
ORDER BY p.received_at, a.id;
```

Cash overview (refunds and paid expenses tracked separately to avoid join multiplication):

```sql
SELECT
  (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='completed') AS receipts,
  (SELECT COALESCE(sum(amount),0) FROM refunds) AS refunds,
  (SELECT COALESCE(sum(amount),0) FROM expenses WHERE status='paid') AS operating_costs,
  (SELECT COALESCE(sum(pi.amount),0) FROM trainer_payout_items pi
   JOIN trainer_payouts tp ON tp.id=pi.payout_id WHERE tp.status='paid') AS trainer_payouts_paid;
```

## Known boundaries for the first release

The database enforces identity links, invoice/member consistency, same-invoice allocation, numeric bounds, collection source for payouts, and unique idempotency keys. State transitions, immutable issued invoices, total payout versus items, rule-period overlap, and invoice issue conditions are application responsibilities unless you add database procedures and revoke direct table writes. Historical corrections and refunded allocations need an explicit ledger/credit design before complex refund workflows. These are implementation decisions for Codex to handle consciously, not implicit database guarantees.
