# Workout Zone — proposed PostgreSQL database design

Status: **proposal, not an applied migration**. No remote database was inspected or changed.

## 1. Scope and conventions

The backend uses Supabase PostgreSQL, FastAPI, and server-managed Google OAuth. Retain those choices. The existing auth code expects `public.users`; retain that table name and the existing `email`, `google_id`, `full_name`, and `picture` columns when preparing a migration.

Assumption: one Workout Zone gym, one current role per authorized account, and one invoice per payment. These match the current frontend. Do not introduce speculative multi-tenant relationships. If multiple independent gyms are required, decide that **before** writing migrations: introduce gyms, gym memberships/access grants, and tenant-consistent composite foreign keys throughout; adding an unchecked `gym_id` column is not sufficient isolation.

Conventions:

- Entity primary keys: `uuid DEFAULT gen_random_uuid()`. Preserve existing user ID types until the actual deployed schema is inspected; do not blindly cast or recreate existing identities.
- Money: `numeric(12,2)` in INR, never floating point. The currency is a gym-wide setting; multi-currency accounting is outside this proposal.
- Business dates: `date`. Event timestamps: `timestamptz`, stored as instants and displayed in the gym timezone (`Asia/Kolkata`).
- Email identity: `citext` with a unique constraint on users; validate and trim at input. Do not remove Gmail dots or plus suffixes. Verify extension availability or use a unique index on `lower(email)` instead.
- Phone: text in E.164 format, not an integer. Members' contact emails/phones need not be unique: shared household contacts are possible.
- Lifecycle: archive/deactivate operational records; financial/history foreign keys use `ON DELETE RESTRICT` (or the default equivalent), never cascading deletes.
- `created_at`/`updated_at` may be added to mutable entities; historical versions and posted financial facts are immutable. Updates to lifecycle state are separately audited.
- Lookup codes such as duration units and payment methods may be constrained text or PostgreSQL enums. A lookup table is only necessary if codes carry separately managed attributes. 3NF does not require a table for every enum.

## 2. Identity and authorization

### `users`

| Column | Constraint / meaning |
| --- | --- |
| `id` | PK |
| `email` | NOT NULL, UNIQUE; authorized Google email |
| `google_id` | NULL until first approved login; UNIQUE when present; verified Google subject |
| `full_name` | Nullable until login; account display name |
| `picture` | Nullable Google avatar URL |
| `created_at` | NOT NULL |
| `last_login_at` | Nullable |

An invited user is represented by a users row with no Google subject yet, not a second email-based identity in a separate invitation table. A later Google login attaches to that same row. Account display names are distinct from a trainer's professional profile name.

### `roles`

`code PK`, `label NOT NULL`.

Seed exactly `SUPER_ADMIN`, `GYM_OWNER`, `GYM_RECEPTIONIST`, and `GYM_TRAINER`. No automatic privileged default role.

### `access_assignments`

`id PK`, `user_id FK users UNIQUE NOT NULL`, `role_code FK roles NOT NULL`, `status NOT NULL` (`ACTIVE`/`REVOKED`), `granted_by_user_id FK users NULL`, `granted_at NOT NULL`.

- `granted_by_user_id` is nullable only for the explicitly audited initial bootstrap grant.
- This table holds the current grant. Changes are recorded in `access_assignment_events`, not by accumulating ambiguous competing active grants.
- Do **not** duplicate email, full name, or trainer ID here. Join users for identity; join trainers by `trainers.user_id` for the linked profile.
- Do **not** also store role/access status in users: the assignment is the single authority.

### `access_assignment_events`

`id PK`, `assignment_id FK access_assignments NOT NULL`, `actor_user_id FK users NULL`, `event_type NOT NULL`, `previous_role_code FK roles NULL`, `new_role_code FK roles NOT NULL`, `previous_status NULL`, `new_status NOT NULL`, `occurred_at NOT NULL`, `reason NULL`.

These are append-only historical event facts, not competing current assignments. Initial creation has no previous state. Role changes, revocation, reactivation, and bootstrap are distinguishable events. Trainer-account linking changes need analogous audit events.

## 3. Operational records and catalog

### `gym_settings`

Singleton: `id boolean PK CHECK (id)`, `display_name NOT NULL`, `timezone NOT NULL`, `currency_code NOT NULL CHECK (currency_code = 'INR')`.

Validate timezone against PostgreSQL timezone names in the service. The singleton row can also be locked while maintaining global access-control invariants.

### `members`

`id PK`, `full_name NOT NULL`, `email NULL`, `phone NOT NULL`, `joining_date NOT NULL`, `status NOT NULL` (`ACTIVE`/`ARCHIVED`), `notes NULL`, `archived_at NULL`, timestamps.

Require email at the API layer if retaining the current frontend contract. Nullable storage allows legitimate offline members if that requirement is later relaxed. A member is not automatically an application user.

### `trainers`

`id PK`, `user_id FK users UNIQUE NULL`, `name NOT NULL`, `email NOT NULL`, `phone NOT NULL`, `is_active NOT NULL`, timestamps.

The optional user link enables login but does not create permission by itself. A user with trainer role must have exactly one linked trainer profile before accessing member data. A trainer can exist without an application login. Contact details are professional-profile facts, not duplicated OAuth attributes that must stay synchronized.

### `gym_membership_plans`

`id PK`, `name NOT NULL`, `is_active NOT NULL`, timestamps.

### `gym_membership_plan_versions`

`id PK`, `plan_id FK gym_membership_plans NOT NULL`, `version_number integer NOT NULL`, `price numeric(12,2) NOT NULL`, `duration integer NOT NULL`, `duration_unit NOT NULL` (`DAY`/`MONTH`/`YEAR`), `description NOT NULL`, `effective_from timestamptz NOT NULL`.

Constraints: `UNIQUE(plan_id, version_number)`, `UNIQUE(plan_id, effective_from)`, `price > 0`, `duration > 0`, `version_number > 0`.

Versions are immutable. A plan edit creates a new version; it does not change terms referenced by old subscriptions. Select the latest version effective at purchase time. Do not store a redundant `current_version_number` on the plan.

### `personal_training_plans`

`id PK`, `trainer_id FK trainers NOT NULL`, `name NOT NULL`, `is_active NOT NULL`, timestamps.

The trainer owning a plan is immutable once referenced. Reassigning a member to another trainer requires a new subscription/plan rather than rewriting history.

### `personal_training_plan_versions`

Same fields and constraints as gym plan versions, with `plan_id FK personal_training_plans`.

Keep this catalog separate from gym plans: PT plans require a trainer; gym plans do not. Two small, explicit version tables are preferable here to a generic polymorphic plan with unenforced references.

## 4. Separate subscription histories

### `member_gym_subscriptions`

`id PK`, `member_id FK members NOT NULL`, `plan_version_id FK gym_membership_plan_versions NOT NULL`, `start_date date NOT NULL`, `end_date date NOT NULL`, `price_at_purchase numeric(12,2) NOT NULL`, `lifecycle_status NOT NULL` (`CONFIRMED`/`CANCELLED`), `created_by_user_id FK users NOT NULL`, `created_at NOT NULL`, `cancelled_at NULL`, `cancellation_reason NULL`.

### `member_training_subscriptions`

Same fields, with `plan_version_id FK personal_training_plan_versions`.

- `CHECK (end_date >= start_date)`; `CHECK (price_at_purchase >= 0)` to permit a deliberate complimentary/discounted purchase, even when catalog price is positive.
- **No `trainer_id` on training subscriptions.** It is determined by `plan_version_id → plan_id → trainer_id`. Return it through a backend join for the frontend DTO.
- **No `plan_id` beside `plan_version_id`.** The version already identifies the plan.
- Purchase price is an independently agreed contractual amount, potentially different from catalog list price. It is not an automatically synchronized copy of list price.
- End date is a contracted service boundary, initialized by the duration policy but retained as a historical fact. Do not recompute old subscription terms after a plan edit. Future approved extensions should be separate adjustment events, not silent overwrites.
- Do not store `days_remaining`, `is_expired`, or a time-dependent `ACTIVE`/`EXPIRED` flag. Derive those from dates and current gym-local date; distinguish cancellation from expiry.
- Initial policy: end day is inclusive, matching the frontend. Confirm the existing month-end policy with the gym before implementing billing SQL: the frontend currently clamps calendar addition then subtracts one day.
- Renewals create new subscription rows. No invoice or payment action implicitly extends a subscription.

Whether overlapping subscriptions are forbidden is a business decision, not implied by normalization. If forbidden, use an exclusion constraint on member plus date range (and active lifecycle), not a race-prone pre-insert SELECT. Do not forbid historical PT trainer changes by accident.

## 5. Invoices, payments and billing

### `invoices`

`id PK`, `invoice_number text UNIQUE NOT NULL`, `member_id FK members NOT NULL`, `invoice_date date NOT NULL`, `due_date date NOT NULL`, `document_status NOT NULL` (`DRAFT`/`ISSUED`/`VOID`), `issued_by_user_id FK users NOT NULL`, `billing_run_id FK billing_runs NULL`, `created_at NOT NULL`, `issued_at NULL`, `voided_at NULL`, `void_reason NULL`.

`CHECK (due_date >= invoice_date)`. Allocate invoice numbers with a database sequence, never `MAX(number) + 1`. Gaps in numbering are acceptable unless legal requirements dictate a different controlled process.

Do **not** store `total_amount`, `outstanding_amount`, or `UNPAID`/`PARTIAL`/`PAID` as competing balances. These are derived by a view. Document lifecycle (`VOID`, for example) is not a payment status.

### `invoice_line_items`

`id PK`, `invoice_id FK invoices NOT NULL`, `gym_subscription_id FK member_gym_subscriptions NULL`, `training_subscription_id FK member_training_subscriptions NULL`, `description_snapshot text NOT NULL`, `amount numeric(12,2) NOT NULL`.

Critical constraints:

```sql
CHECK (num_nonnulls(gym_subscription_id, training_subscription_id) = 1),
CHECK (amount > 0),
UNIQUE (gym_subscription_id),
UNIQUE (training_subscription_id)
```

PostgreSQL's normal UNIQUE behavior permits multiple NULLs. Therefore each non-null subscription can be invoiced at most once while each line has exactly one real subscription foreign key. There is no uncheckable generic `subscription_id` pointing to one of two tables.

- Do not store `fee_type`: which foreign key is non-null determines GYM/PT.
- Do not repeat member ID: derive it through the invoice; a constraint trigger must also verify the linked subscription belongs to that invoice's member.
- Invoice description and amount are immutable issued-document facts. They may differ from today's plan description or subscription purchase price only through explicitly authorized pricing/adjustment rules, not through automatic synchronization.
- For the current workflow, one subscription row represents one purchased billing period. Billing an expired subscription creates its unpaid invoice once. Renewals create another subscription row. Do not add period columns that just repeat subscription dates.
- If installment/recurring charges per single subscription become necessary, introduce a `subscription_billing_periods` entity with canonical period keys and a unique charge per period; replace the one-charge-per-subscription uniqueness deliberately. Arbitrary client-supplied start/end windows are not sufficient duplicate protection.
- A complimentary zero-price subscription produces no positive-charge invoice line. Do not generate a zero-value receivable.
- Voiding an invoice does not automatically free its subscription for rebilling. Credit notes/replacement documents need an explicit accounting policy. Never delete issued invoice lines to bypass uniqueness.

### `payments`

`id PK`, `invoice_id FK invoices NOT NULL`, `amount numeric(12,2) NOT NULL`, `method NOT NULL` (`CASH`/`UPI`/`CARD`/`BANK_TRANSFER`), `payment_date date NOT NULL`, `transaction_reference text NULL`, `notes text NULL`, `recorded_by_user_id FK users NOT NULL`, `idempotency_key uuid UNIQUE NOT NULL`, `created_at NOT NULL`.

- `CHECK (amount > 0)`.
- No `member_id`: `invoice_id → member_id` already exists.
- No invoice outstanding balance or member name copies.
- Do not make transaction reference globally unique without knowing provider semantics. A payment may have no external reference; idempotency is controlled separately.
- The payment is an immutable receipt fact, not a charge attempt or proof of gateway settlement. Only authorized staff may record a confirmed collection. Corrections/refunds require separate reversal/credit records; do not mutate a posted payment.
- This design intentionally supports one payment against one invoice, matching the UI. If one receipt must settle multiple invoices, introduce `payment_allocations(payment_id, invoice_id, amount)` and remove invoice_id from payments; do not keep both representations.

### `billing_runs`

`id PK`, `idempotency_key uuid UNIQUE NOT NULL`, `request_hash text NOT NULL`, `requested_by_user_id FK users NOT NULL`, `cutoff_date date NOT NULL`, `started_at NOT NULL`, `completed_at NULL`.

One atomic run creates its invoices and completion timestamp in the same transaction. A rollback removes all of those changes. Record failed attempts in operational logs or an explicit attempts table, not as misleading completed financial runs. Reusing an idempotency key with a different request hash is rejected; reusing it with the same request returns the already-created run and invoices.

### Read views / DTO projection

- `invoice_balances`: separately aggregate line sums and payment sums by invoice, then join; never join raw lines to raw payments before summing, because that multiplies both totals.
- `total_amount = SUM(invoice_line_items.amount)`.
- `amount_collected = SUM(payments.amount)`.
- `outstanding_amount = total_amount - amount_collected` for issued, non-void invoices.
- Payment status: PAID when balance is zero; PARTIAL when `0 < collected < total`; otherwise UNPAID. Exclude drafts/voids from receivables. Invoice issuance requires at least one positive line.
- Membership/training expiry views compute `end_date - gym_local_today` numerically. Cancelled subscriptions must not be presented as valid memberships solely because dates are in the future.
- Views return frontend `feeType`, `trainerId`, `memberId` and computed statuses; frontend DTOs need not mirror physical table columns.

If exposing views through Supabase/PostgREST, use security-invoker views where supported, grant narrowly, and verify underlying RLS behavior. A view is not automatically a permission boundary.

## 6. Historical trainer compensation

### `trainer_payout_rules`

`id PK`, `trainer_id FK trainers NOT NULL`, `effective_from date NOT NULL`, `effective_to date NULL` (exclusive), `payout_type NOT NULL` (`COMMISSION`/`FIXED`), `commission_rate numeric(5,2) NULL`, `fixed_amount numeric(12,2) NULL`, `fixed_period_unit NULL` (initially MONTH), `created_by_user_id FK users NOT NULL`, `created_at NOT NULL`.

- COMMISSION requires rate in 0–100 and NULL fixed amount/period.
- FIXED requires nonnegative fixed amount and explicit fixed period; rate must be NULL.
- `effective_to > effective_from` when present.
- Exclude overlapping effective ranges for the same trainer using a PostgreSQL GiST exclusion constraint (`btree_gist` if available).
- Insert new rule versions when rates change. Close the old open interval transactionally; never overwrite a historical rate.
- No rule means **Not Configured**, not 0%.

The current frontend's fixed-amount-per-selected-report behavior is not an adequate payroll rule. Agree whether fixed compensation is monthly, prorated, or independent of collections before building production reports. Commission should have an explicit basis, recommended initially **collected PT fees**, and a rule-selection date, recommended initially payment_date.

Actual disbursements require an additional ledger; do not label an estimate as a paid payout. Recommended second-phase entities:

- `trainer_commission_earnings`: payment FK, PT invoice-line FK, payout-rule FK, allocated collected amount, earned amount; unique payment/line pair. Enforce payment and line share the same invoice.
- `trainer_fixed_earnings`: payout-rule FK, accrual month, earned amount; unique rule/accrual month with explicit proration rules at rate boundaries.
- `trainer_disbursements`: trainer FK, payment date, method, reference, idempotency key.
- Separate disbursement-allocation rows link earnings to disbursements, preventing double settlement and over-allocation.

Until that ledger exists, the financial API should expose configured **estimates**, with missing-rule indicators, rather than inventing payouts that were never paid.

## 7. Why this is at least 3NF

Normalization is assessed against the declared business dependencies, not merely by adding UUIDs:

1. **1NF:** columns contain scalar values; subscriptions, invoice lines, payments, role changes and plan versions are rows, not arrays or JSON blobs in their parent records.
2. **2NF:** attributes depend on the complete candidate key. Version terms depend on the complete `(plan_id, version_number)` candidate key, not on plan_id alone; stable plan identity is in the parent plan table.
3. **3NF:** non-key attributes are not maintained through other non-key attributes in the same operational relation. Examples deliberately removed:
   - `payments.invoice_id → invoices.member_id`: do not repeat member_id on payments.
   - `training_subscription.plan_version_id → plan_id → trainer_id`: do not repeat plan_id/trainer_id on subscriptions.
   - `access_assignment.user_id → users.email/full_name`: do not repeat account identity on assignments.
   - `invoice_line.subscription FK → fee category`: do not store an additional fee_type that can disagree.
   - `role_code → role label`: put labels in roles, not on every grant.

Catalog prices, contracted purchase prices and legally invoiced amounts are **different facts**, not interchangeable copies. Historical event states and document snapshots are also intentionally different facts. Do not claim they are synchronized duplicates while allowing them to drift. Derived totals and time-dependent statuses are view outputs, not independently writable columns.

Most core relations also meet BCNF under these dependencies. A formal final normalization review should use the actual accepted business rules, particularly whether subscriptions may be repriced, moved between trainers, billed in installments, or shared between gyms.

## 8. Required transactional invariants

Foreign keys and CHECKs alone cannot enforce cross-row and cross-table financial/access invariants. Use server-side PostgreSQL functions/transactions with narrowly granted execution; several independent Supabase REST requests are **not** one transaction.

### Billing

1. Authenticate actor and authorize billing.
2. Insert/resolve billing-run idempotency key; reject mismatched request hash.
3. Select eligible non-cancelled, positive-price, expired subscriptions at the gym-local cutoff date, scoped to non-archived members, excluding existing charges. Revalidate eligibility rather than trusting preview input.
4. Lock selected subscriptions in a consistent order. Keep unique line/subscription constraints as the final concurrency guarantee.
5. Create grouped invoices and independent gym/PT lines using persisted contractual values; mark invoices issued only when complete.
6. Complete the run and commit. Never record a payment or extend dates.

Use all-or-nothing semantics initially. If concurrent runs compete, one can retry against the newly committed state; do not swallow a unique violation and leave empty/partially assembled invoices. Preview is non-binding; return a changed-preview conflict before execution if the product requires exact confirmation of its original totals.

### Payments

1. Authorize actor and resolve payment idempotency key; reject key reuse with changed payload.
2. Lock the invoice row `FOR UPDATE`.
3. Verify it is issued and non-void; derive line total and posted collections.
4. Require `0 < amount <= current outstanding`, reject future payment dates under the current UI policy, then insert the payment.
5. Commit and return the receipt plus recomputed balances.

All issuance, payment, voiding and later correction paths must share this locking discipline. A browser's balance check is not sufficient, and a cross-table CHECK using a subquery is not an appropriate PostgreSQL implementation.

### Privileged access

- Serialize every access mutation using one transaction advisory lock or the singleton settings row lock. Check that the actor is still an active Super Admin and the result retains at least one active Super Admin. Two concurrent demotions must not both pass.
- Bootstrap the first admin in an explicit controlled migration/administrative command, never in a public signup endpoint.
- Write the audit event in the same transaction as the grant change.
- Validate trainer links and trainer-role grants atomically, including changes through the trainer-management endpoint. Receptionists may manage trainer profiles but must not be allowed to relink authentication identities or grant themselves access.
- On every protected request, resolve the current assignment from the database. Do not trust the role cached at login in a signed session cookie after revocation.

## 9. Authorization and Supabase deployment

The backend currently uses the Supabase **service-role key**, which bypasses RLS. Adding RLS policies alone will not secure these backend queries.

- No browser Supabase service key. Do not expose gym tables to anon/authenticated Supabase roles just because the backend uses Supabase.
- Enable RLS on application tables and initially grant no direct browser policies. Backend authorization is still mandatory when using service_role.
- Prefer a least-privilege backend database role or narrowly scoped RPC functions over broad service-role table access as implementation matures.
- The existing custom Google session is **not** a Supabase Auth session: `auth.uid()` will not magically identify that user. Choose either backend-only access with verified application identity or a deliberately designed identity bridge. Do not write policies that assume the bridge exists.
- Trainer reads derive trainer ID from authenticated user → trainers.user_id and return only currently assigned PT members and appropriate PT history. Owner/admin trainer selection is a separate authorized query. An old cancelled subscription alone must not grant continuing access to a member.
- Receptionist responses exclude aggregate financial reports, payout rules and access assignments. Dedicated financial endpoints allow owner/admin only.
- Only trusted admin operations can link a trainer profile to a user. That link must not be treated as a harmless trainer contact edit.

### Existing auth changes needed later

Current `/auth/me` returns only the stored session user. It must resolve the live user/assignment, return trusted role and status, and derive trainerId through the trainer link. Do not modify a Google-linked user's subject merely because another login presents the same email. Require verified Google email, validate issuer/audience through the OAuth library, attach a subject only to a pending authorized identity, and reject mismatched already-linked subjects.

## 10. Initial indexes and verification plan

These are query-driven **candidates**, not measured performance claims:

- Existing PK/UNIQUE constraints cover account email, Google subject, role grants, trainer user link, invoice numbers, plan version keys and idempotency keys.
- Foreign-key indexes on members' subscriptions, plan-version references, invoice member ID, invoice billing_run_id, line invoice ID, payment invoice ID, PT-plan trainer ID, payout-rule trainer ID and audit assignment/actor IDs.
- `(end_date, id)` partial index on confirmed subscriptions for expiry/billing sweeps; evaluate `(member_id, end_date DESC)` for member history.
- `payments(payment_date, id)` for collection reports; `invoices(due_date)` partial on issued documents for aging candidates.
- Trainer member scoping joins indexed `trainers(user_id) → personal_training_plans(trainer_id) → versions(plan_id) → subscriptions(plan_version_id)`.
- Consider `pg_trgm` indexes on normalized member/trainer names only if measured substring searches require them.

Validate using `EXPLAIN (ANALYZE, BUFFERS)` against realistic data and role-scoped queries. Small-table sequential scans are normal; do not force indexes or promise sub-100ms queries without measurement.

## 11. Migration and test checklist

Before any SQL is applied:

1. Inspect actual Supabase tables, column/ID types, policies, functions and existing rows; take a backup. The repository no longer contains a database model module, so it is not evidence that the remote database is empty.
2. Confirm single/multi-gym scope, billing-at-expiry policy, cancellation/refund rules, month-end dates, overlapping plans, and commission/fixed-pay semantics.
3. Write reviewed, ordered Supabase migrations. Expand existing users safely, backfill normalized grants, then switch auth reads. Do not drop the current users table or silently manufacture privileged grants.
4. Add constraints, indexes, immutable-document protections and transactional RPCs; lock down all direct writes that could bypass those protections.
5. Add DTO projections so normalized storage remains compatible with the frontend's camelCase/computed fields.
6. Apply to a disposable PostgreSQL/Supabase database and run integration tests before staging/production.

Required database tests: foreign-key/XOR violations; duplicate subscription charging under distinct billing keys; same-key retry and changed-payload rejection; simultaneous full/partial payments; attempted overpayment; posted-document mutation; archived history preservation; effective payout-rule overlap; exact date boundaries; two concurrent last-admin demotions; revoked sessions; unauthorized trainer identity relinking; other-trainer member enumeration; receptionist financial/access denial; anonymous PostgREST access and actual service-role bypass behavior.

Frontend tests cannot establish any of these server/database security properties. This proposal intentionally does not claim migration, integration-test, or performance verification yet.
