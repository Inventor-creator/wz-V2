# Trainer plans

## Scope and acceptance criteria

- Staff (permanent Super Admin, owner, receptionist) can list, create, edit,
  deactivate/reactivate through Edit, and delete PT catalogue plans.
- A dedicated `/personal-training-plans` page works without `/gym/workspace`.
- Follow `backend/docs/implementation_Details.md`: `trainer_plans` is shared;
  `member_trainer_plan` selects both a plan and a trainer at purchase time.
  Do not infer plan ownership from historical trainer assignments.
- Fixed calendar days, nonnegative INR amounts with two decimal places, optional
  descriptions, and unchanged subscription/invoice/payment/payout history.
- Unused plans are physically deleted. Referenced plans are marked inactive and
  removed from the catalogue. Audit snapshots survive either outcome.

## Backend and migration

Add migration 006 after 001–005, without rewriting earlier migrations or the base
schema. Add description/deleted_at, an audit table, private projection and checked
RPCs. Retain existing IDs, names, prices, days, and foreign keys. Keep globally
unique names, including retained historical plans. New PT purchases require an
active catalogue plan and trainer. Lock rows to serialize deletion against purchases.
Lifecycle updates on existing assignments remain possible after catalogue removal.

Expose GET/POST `/personal-training-plans` and GET/PATCH/DELETE item routes.
Reuse the membership plan field contract and validation, not trainer ownership.

## Frontend

Reuse the aligned membership card/form layout with an explicit plan kind.
Add role-gated navigation, search/status filters, confirmation, feedback, error,
empty/loading states and query invalidation. Trainer details link to the shared
catalogue instead of editing fictional trainer-owned plans. Mock purchases select
the trainer independently; existing purchase snapshots are not rewritten.

## Security checkpoint

- Verified Google session supplies the actor; live role checks in API and SQL.
- Trainers cannot manage the catalogue; no actor or ownership fields from clients.
- Existing write-Origin guard on mutations, strict Pydantic/Zod validation.
- Fixed SQL search_path, static parameterized RPCs, browser DB roles denied,
  backend granted only public RPC execution and needed catalogue reads.
- Audit each mutation and log safe database error codes; do not expose SQL errors.
- React escapes text; no HTML injection or financial side effects.
- Existing application rate-limiting policy is unchanged by this feature.

## Verification

Full migration chain in a disposable PostgreSQL-compatible database: permissions,
invalid fields, CRUD, inclusive dates/distinct member counts, safe deletion,
audit retention, inactive trainer/plan purchase rejection, and historical invoice
and payout preservation. HTTP session/origin tests and frontend CRUD/filter/error
tests, lint, build, and responsive fixture screenshots. No live migration without
explicit deployment authorization.
