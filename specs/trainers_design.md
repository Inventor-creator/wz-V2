# Trainers tab

## Acceptance criteria

- Staff list/search/filter trainers, create profiles, edit contact/status, and view
  dedicated detail/assignment history without `/gym/workspace`.
- Profiles are independent of users. No `trainers.user_id`, automatic login grant,
  identity matching by name, or changes to Google identity/contact-bound accounts.
- Deactivation prevents new PT purchases (006) but retains assignments, access
  grants, billing and payouts. Manage login revocation in Access Management.
- No trainer deletion: retained profile IDs support assignment/payout provenance.
- Owners/Super Admin see payout rules and can schedule percent commission changes
  starting after today in Asia/Kolkata. Receptionists cannot read/write rule values.
- Do not invent a unit for fixed rules; show existing fixed/overlapping rules for
  review. No payout generation or retroactive rule-value changes.

## Migration and backend

Read implementation_Details.md and migrations 001–006. Add 007 only: trainer
mutation audit table, private directory projection, checked list/get/profile-write
and commission scheduling RPCs. Existing base tables/IDs/history are preserved.
Profile writes share the access-management advisory lock (002–004), then lock the
trainer row so deactivation serializes with grants and purchases (006).

POST/PATCH /trainers accepts only name, optional contact strings and isActive.
GET /trainers and GET /trainers/{id} return explicit staff-facing projections.
POST /trainers/{id}/commission-rules is owner-only and uses decimal values/dates.
Scheduling closes at most one preceding overlapping rule at start-1; it rejects
ambiguous overlaps and already scheduled future overlaps, rather than changing
past values or silently replacing future policy. Audit before/after rule states.

## Security checkpoint

Verified Google sessions and live role guards at HTTP and SQL layers. Client actor,
grant, user and computed fields rejected. Parameterized RPCs, fixed search_path,
strict Pydantic/Zod validation, Origin checks, React escaped output, safe errors
and audit events. Browser roles denied access; service role receives checked RPCs
and required read access, not raw profile/rule writes. Payout fields are omitted/
null server-side for receptionists, not merely hidden in the browser.

## UI and tests

Preserve OpenDesign-derived styling, aligned cards/toolbars and inline checkbox
layout; optional contact fields, clear independent access notice, error/empty/
loading/retry states and cache invalidation. Test all seven migrations against
disposable data, existing access/onboarding/dashboard/plan compatibility, role and
Origin enforcement, profile CRUD, inclusive distinct counts, assignment/financial
immutability, future rule scheduling/conflicts and audit retention. Run HTTP/UI
regressions, lint/build and responsive component fixtures. No live migration.
