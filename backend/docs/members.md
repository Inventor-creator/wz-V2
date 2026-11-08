# Members

## Deployment and migration order

Apply **`008_member_crud.sql` after migrations 001–007**, then restart the backend.
Do not replay `gym_schema.sql` or change earlier migrations. Back up and review
existing data as described in `implementation_Details.md`. No live migration is
automatically applied by this feature.

008 adds `members.notes` (empty for existing rows), `deleted_at`, audit events,
private profile/subscription projections, onboarding idempotency records and
checked RPCs. Existing member numbers, IDs, grants, subscriptions, invoices,
payments and payout provenance are preserved. It uses 005/006's catalogue fields
and active-plan/trainer rules and remains compatible with 004/007's trainer views.

## API

| Method | Path | Result |
| --- | --- | --- |
| GET | `/members` | `{members, summary}` directory and derived KPIs |
| GET | `/members/options` | Active gym plans, shared PT plans and trainers |
| GET | `/members/{id}` | Profile, full subscriptions, invoice/payment history |
| POST | `/members` | Atomic onboarding, profile response, HTTP 201 |
| PATCH | `/members/{id}` | Profile/contact fields only |
| DELETE | `/members/{id}` | Explicit physical-delete or retention mode |

Super Admin, owners and receptionists can manage members. Trainers continue using
the separate scoped `/trainer/*` routes, not staff directory/financial endpoints.
Google sessions supply the actor; SQL rechecks live authorization. Writes require
the configured frontend Origin. Unknown identity, status, balance, price and end
date fields are rejected. Browser DB roles cannot access these RPCs/projections;
the service role uses checked writes, not raw member/subscription table writes.

## Add a member

```json
{
  "requestKey": "<stable UUID for this onboarding attempt>",
  "fullName": "Ananya Sharma",
  "email": "ananya@example.com",
  "phone": "+919876543210",
  "joiningDate": "2026-11-08",
  "planId": "<active gym plan UUID>",
  "startDate": "2026-11-08",
  "trainerId": "<optional active trainer UUID>",
  "ptPlanId": "<optional shared PT plan UUID>",
  "ptStartDate": "2026-11-08",
  "notes": "Prefers morning sessions"
}
```

- Required: name (2–160 trimmed characters), joining date, active gym plan and gym
  start date. Optional contacts default to empty strings; notes max 2,000 chars.
  Email is validated/lowercased, max 254 characters. Phones follow onboarding's
  existing 8–15 digit normalization, with optional `+`; ten local digits get `+91`.
- Dates are YYYY-MM-DD calendar dates. Subscription starts cannot precede joining.
  Choose both trainer and shared PT plan, plus PT start, or neither. Empty/null PT
  selectors mean no PT; an unused UI PT start default is discarded.
- Server locks and validates catalogue/trainer rows, copies actual prices and day
  counts and computes `end = start + duration_days - 1`. Clients cannot set prices,
  end dates, member numbers or derived balances. Free/one-day plans are supported.
- Member number is generated from its UUID with a `WZ-` prefix, not inferred from
  identity/contact data. No user, Google identity or role grant is created.
- Member and gym/optional PT subscriptions commit together. A failure leaves no
  partial profile, purchase, audit event or request record.
- Retry the same request key with the same normalized fields and actor to receive
  the original profile response, without duplicating purchases, even if catalogue
  availability changed afterward. Reusing it for different fields/actor is 409.
  The UI preserves this key through errors and retries. Replay does not resurrect
  a subsequently removed profile. Request/audit records follow administrative
  retention, not a claim of personal-data erasure.

Migration 008 alone records subscriptions only. Pending migration 009 adds
automatic invoice issuance for new nonzero purchases in the same transaction;
creation still never collects money, generates payouts or renews an old row.
Reviewed historical billing, payments and new-row renewals use dedicated checked
financial workflows, not the obsolete mock Run Billing Cycle action.

## Edit member details

PATCH accepts a nonempty subset of `fullName`, `email`, `phone`, `joiningDate` and
`notes`. Explicit null fields are invalid; empty strings clear optional contacts.
Corrected joining dates cannot move after an existing subscription start. Leaving
a legacy joining date unchanged does not rewrite/validate old contracted dates.

The edit form has its own schema and needs no active catalogue/trainer query. A
deleted plan or inactive trainer cannot block a contact edit. Subscription links,
purchase dates/prices, invoices and payments are never changed by this form.
Plan changes/renewals require new subscription rows in a separate workflow, not
retroactive edits. Profile edits are last-write-wins (no ETag/version check).

## Delete and history

- No subscriptions or invoices: physically delete the profile, mode `DELETED`.
  Audit snapshots survive, with the live member FK nulled.
- Any subscriptions/invoices, even cancelled/expired/void: mark inactive with a
  deletion timestamp and hide from staff directory/get/edit. Mode is
  `REMOVED_FROM_DIRECTORY`. No cascade deletes or reactivation through this API.
  Migration 009 adds explicit, audited restoration through the financial lifecycle
  API and Archived members selector; it preserves the same profile/history.
- Subscription prices/dates, invoice items/descriptions, payments, allocations,
  refunds and trainer payouts remain intact. Historical names/contact labels stay
  on the retained profile; this is directory removal, not regulatory erasure.
- Outstanding issued invoices still count after directory removal. Do not confuse
  deletion with settling a balance. Existing active-member trainer dashboards stop
  including the inactive profile; staff assignment/financial records retain it.
- New subscriptions require an active, non-deleted member. History-only lifecycle
  updates are still permitted. Parent locks/FKs protect concurrent purchase/delete
  operations. Native multi-connection concurrency/load testing remains a deployment
  check; local SQL tests use a single connection.

## Read semantics and UI

Displayed gym/PT selection is deterministic: non-cancelled subscriptions covering
today first, then nearest upcoming, then most recently ended, with stable ties.
Future renewals do not hide a currently valid membership. Expiry is inclusive in
Asia/Kolkata. No-plan/upcoming/archived profiles do not inflate active-member KPIs.
Filters operate on these displayed assignments; full history is in the detail view.

Balances derive from `invoice_balances`, never an independently writable amount.
With pending migration 009, issued charges are net of explicit adjustments and
completed allocations are net of refunds. Draft/void invoices are not outstanding
debt. Receipt status remains the original pending/failed/completed fact; Fees Due
shows compensating refund/reversal details separately.
Detail history includes cancelled entries and soft-deleted plan labels, with
original subscription prices/dates. Invoice descriptions remain original snapshots.

Directory/detail/form use dedicated queries, not `/gym/workspace`, with search,
status/plan/trainer filters, ordering, pagination display, loading/error/retry,
confirmation and success feedback. Query invalidation refreshes counts/options
across plans, trainers, Access Management and member views. Lists are currently
loaded per feature and paginated client-side; large installations should add
server-side pagination rather than a global workspace snapshot.

## Verification

Tests run all eight migrations against disposable PostgreSQL-compatible data,
including paid payouts/source allocations, idempotency/rollback, fixed-day/price
snapshots, contact edits with unavailable plans, safe deletion/audits, actual
balances and role/database privilege checks. HTTP tests cover Google-session and
Origin guards, IDs/dates and readonly-field rejection; UI tests cover add/edit/
delete, PT, retries, filters, detail history and errors.

Run backend `python -m unittest discover -s tests`; frontend `npm test`,
`npm run lint`, `npm run build`. Optional SQL execution:
`PGLITE_MODULE=<package>/dist/index.js node --test tests/test_member_schema.mjs`.
Financial work now unignores test source files so regression coverage can be committed.
Local tests/SSR layout fixtures are not a live Supabase or authenticated E2E test.

Verified locally: **74 backend tests, 84 frontend tests and 67 SQL checks**, plus
lint and strict TypeScript/production build. Directory layouts were inspected at
1440/1024/768/390px, with create/edit/detail fixtures checked on desktop/mobile.
Member forms keep header/actions visible while fields scroll on small screens.

### Fees/Finances integration (pending 009)

New onboarding subscriptions automatically issue snapshot-price charges in the
same database transaction; free purchases create no debt. Contact edits remain
contact-only. Member details now links to member-filtered Fees Due and exposes
renewal/new gym/PT purchase and cancellation controls (including free plans).
Cancellation keeps original charges; fee waivers/refunds are separate explicit
actions. Existing unbilled purchases require owner review before charge approval.
Member mutations and financial mutations invalidate both modules' caches.

**009 CREATED — NOT APPLIED — AWAITING MANUAL REVIEW.** Earlier SQL verification
results above are historical; none of those migration-executing tests were rerun
for this task. Real financial integration is **BLOCKED — PENDING MANUAL MIGRATION**.
See [fees_finances.md](fees_finances.md) and [financial_testing.md](financial_testing.md).
