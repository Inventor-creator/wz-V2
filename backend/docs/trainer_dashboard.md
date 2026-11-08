# Trainer dashboard and access onboarding

Uses `gym_schema.sql`, `implementation_Details.md`, and the existing migration chain.

## Deployment

Apply **`004_trainer_dashboard_and_onboarding.sql` after migrations 001–003**, then restart the backend. Do not edit/replay the initial schema or already-applied migrations. No live migration was automatically applied in this task. Migration 004 was tested against the supplied base schema and the complete prior chain in an isolated PostgreSQL-compatible database.

The migration adds checked read RPCs and an atomic create-and-link wrapper around migration 002's existing access mutation. It also closes direct browser access to the trainer/member/collection tables used by the dashboard, using RLS and privilege revocation. Supabase service-role access remains server-only; custom Google sessions are not Supabase Auth and do not establish auth.uid().

## Routes

All require the current cookie-backed session, an active authorized user, and live grants. The permanent Super Admin retains its protected override.

- `GET /trainer/options`: owners/Super Admin see selectable trainer profiles; trainer accounts receive only their linked profile.
- `GET /trainer/dashboard`: query `trainerId` (optional for owner/Super Admin selection), `search`, `planId`, `status`, `page` (default 1), `pageSize` (default 8; maximum 100). Allowed statuses: Active, Expiring Soon, Expired, Upcoming. Returns selected profile, summary, scoped plan options, paginated rows and total.
- `GET /trainer/members/{member_id}?trainerId=...`: contact information and this trainer's non-cancelled training history only. No gym memberships, invoices, receipts, notes or another trainer's history are returned.

Trainer scope is derived from `users.id → active role_assignments.trainer_id`. Trainers cannot select another trainer by forging an ID. Owners/Super Admin may select profiles, including inactive ones for history. Receptionists are denied, including accounts whose effective higher-priority role is receptionist. Revocation and inactive-user checks happen on every request and again in the read RPCs. Unknown or unrelated member IDs produce 404.

## Schema and date semantics

- No `trainers.user_id` exists or is introduced.
- `trainer_plans` is a **shared catalog** in the supplied schema, not a trainer-owned table. Dashboard filtering offers plans referenced by the selected trainer's assignments. Scope comes from `member_trainer_plan.trainer_id`.
- Rows represent non-cancelled PT subscriptions for active members, including expired history and upcoming periods. Multiple subscriptions can therefore produce multiple rows for a member. Counts use distinct member IDs. Archived/inactive member contacts and cancelled-only assignments are excluded.
- End dates are inclusive in Asia/Kolkata. An end date of today has zero days remaining and is still valid. A future start date is Upcoming, not an active member yet. Days remaining are integers; expired rows sort first, then member name and subscription ID for stable pagination.
- Subscription values use `price_snapshot`, never current catalog list_price. These are contract values, not collected revenue. No date, subscription or invoice is renewed by viewing a dashboard.

## Payout estimate policy

The estimate covers **this month's unsettled completed PT payment allocations** up to the gym-local current day, for issued invoices belonging to this trainer's assignments.

- Commission rules are selected on the receipt's gym-local collection date, honoring inclusive effective dates.
- Each eligible allocation's percentage amount is rounded to two decimal places, then summed using PostgreSQL numeric arithmetic.
- Allocations already referenced by any payout item are excluded, matching the unique source-allocation constraint. Cancelled payout sources still need an explicit correction policy, not an automatic second payout.
- Missing applicable rules show **Not Configured**. Overlapping or fixed rules show **Needs Review**: the schema does not define the business unit of fixed pay, so no monthly/per-session assumption is invented.
- Any refund on an otherwise eligible receipt causes Needs Review and no estimate. Without refund_allocations, partial refunds cannot be assigned precisely to PT lines. No guessed proportional deduction is used.
- Estimates are not approved or paid trainer payouts. This feature creates no financial records. Decimal amounts remain numeric in SQL; the UI preserves fractional INR amounts.

## Create and link a trainer while granting app access

The existing `POST /access-assignments` now accepts either an existing trainer UUID or a new profile:

```json
{
  "email": "coach@gmail.com",
  "role": "GYM_TRAINER",
  "newTrainer": { "name": "Aisha Khan", "phone": "9876543210" }
}
```

Phone is optional. Profile email comes from the authorized account email. User input does not supply a Google subject. The pending user still needs verified Google sign-in before obtaining a session.

Owner/Super Admin authorization and Origin checks remain mandatory. Profile creation, pending-user creation, grant insertion and access audit commit together. Duplicate grants, invalid accounts, protected bootstrap identity changes or other failures roll back the new profile too. Neither matching names nor matching profile emails silently link identities: selecting an existing profile remains explicit.

`PATCH /access-assignments/{id}` also supports `role=GYM_TRAINER` plus `newTrainer`. It grants active trainer access, appending a new grant and preserving prior revoked history through migration 002. Existing profile links still use trainerId. Supplying both newTrainer and trainerId, or newTrainer for a non-trainer role, is rejected. Removing access does not delete the trainer profile or financial history.

Changing an account's linked profile does not transfer members, rewrite subscriptions, or move payout provenance. Those historical assignments remain attached to the original trainer. The UI explicitly warns about this when editing an existing link.

In the UI choose **Create and link a new trainer** or **Link an existing trainer**. The old Google-user-ID input on the trainer profile form has been removed: account association belongs to role assignments.

## Verification and boundaries

Trainer route and UI tests cover authorization, query contracts, direct-query loading, filtering, member drawers and inline onboarding. SQL tests execute the full base schema plus migrations 001–004 and cover scoped data, numeric expiry, snapshot prices, allocation-based estimates, refunds, overlapping/fixed rules, rollback, unique grants, role revocation and browser database-role restrictions.

No real customer grants or payments are changed by tests. Native multi-connection Supabase concurrency and authenticated visual regression remain deployment checks. OpenDesign was unavailable during this task; the already-retrieved dashboard styles/layout were preserved.

Verification result: 48 backend tests, 35 frontend tests and 32 SQL checks passed; frontend lint and strict TypeScript/production build passed. Application startup/OpenAPI generation confirms all three trainer routes and the inline NewTrainer request model are registered.

This feature replaces the trainer **dashboard** dependency on `/gym/workspace`. The separate trainer-management/PT-plan CRUD pages and other workspace-backed modules still need their own backend integration; this migration does not fabricate those APIs or introduce trainer-specific plan ownership absent from the schema.
