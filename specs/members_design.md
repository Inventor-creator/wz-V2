# Members CRUD

## Scope and acceptance

- Dedicated staff directory/detail queries, not `/gym/workspace`, with search,
  expiry/trainer/plan filters, actual balances and preserved history.
- Add member plus required gym subscription and optional shared PT/trainer
  assignment atomically. Prices/durations come from locked active catalogue rows;
  end dates are inclusive fixed calendar days. Never accept client prices/ends.
- Contact editing has a separate schema and does not require/rewrite subscriptions.
  Optional email/phone match the supplied database model. Joining-date corrections
  cannot move after any existing subscription start.
- Delete physically removes unused profiles; referenced members are inactive and
  hidden from the directory, retaining subscription/invoice/payment/payout facts.
  Confirmation explicitly explains retention. No automatic account/grant changes.
- No invoice issuance, payment collection, renewal or billing-cycle implementation
  is implied by member onboarding; remove the unsupported billing-cycle action
  from this page rather than simulate financial success.

## Backend/migration

Follow implementation_Details.md and preserve migrations 001–007 (including current
trainer work). Add 008: notes/deleted_at, private profile/current-subscription
projection, mutation audit, onboarding idempotency records, checked RPCs and member
availability triggers. Generate immutable member numbers server-side. Create uses
a stable UUID request key so a retry cannot duplicate profile/subscriptions.

Select displayed subscription deterministically: covering today first, then
nearest upcoming, then most recently ended; exclude cancelled entries. Membership
status distinguishes Upcoming, No plan, Archived and inclusive expiry. Full detail
retains cancelled and soft-deleted-plan history. Invoice balances derive from
issued line totals/completed allocations, not a second mutable balance.

## Security checkpoint

Live Google-session staff authorization (Super Admin/owner/receptionist) in HTTP
and SQL; trainers retain the separate scoped dashboard. Strict Pydantic/Zod fields,
Origin guard, parameterized static SQL with fixed search_path, escaped React text,
safe error mapping, no browser table/RPC privileges, minimal backend RPC grants.
Creation is transactional; lock parent availability/price rows, serialize member
mutations, audit edits/deletions. Member FK/SHARE locks protect deletion vs new
assignments. Existing history-only updates remain possible. No raw service writes.

## UI/tests

Aligned responsive table/forms with loading/error/retry/empty and success states.
Separate add/edit validation and create-only plan queries, nullable contacts,
idempotent retries and query invalidation across plans/trainers/dashboard/member
details. Test all eight migrations, old financial/identity data, atomic failures,
date/price snapshots, idempotency, permissions, safe delete, inclusive/order edge
cases, invoice balances, UI CRUD and error recovery. No live migration without
deployment authorization; local tests remain subject to the existing ignore policy.
