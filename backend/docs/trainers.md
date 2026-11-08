# Trainer management

## Deploy

Apply **`007_trainer_management.sql` after migrations 001–006**, then restart the
backend. Do not replay the initial schema or earlier migrations. Back up and review
existing data as required by `implementation_Details.md`. No live migration is
automatically applied by this feature.

007 adds an audit table, private directory projection and checked staff RPCs.
Existing profile IDs, grants, assignments, plans and financial data remain intact.
No existing contacts or identities are backfilled/guessed. RLS from 004 remains
enabled. Raw backend profile/rule writes are revoked; checked onboarding from 004
continues to work as a definer RPC.

## Profiles and login are independent

`trainers` has **no `user_id`**. Creating a profile does not create a user or grant.
Editing a contact email/phone changes only the profile, not Google identity or
`users.email`. Names/contact emails are not unique identity keys and never trigger
automatic account linking. Login grants remain in Access Management (002–004).
`hasLoginAccess` means an unrevoked trainer grant linked to an active user.

Deactivation stops **new PT assignments** through 006's active-trainer trigger.
It retains existing assignments, prices/dates, invoices, payments, grants and
payouts. A deactivated profile with a live grant can still view its historical
trainer dashboard; revoke login separately when required. Reactivation restores
eligibility for future purchases. There is no DELETE route: IDs preserve history.

## API and authorization

| Method | Path | Result |
| --- | --- | --- |
| GET | `/trainers` | Staff directory with counts/access status |
| POST | `/trainers` | Create independent profile, HTTP 201 |
| GET | `/trainers/{id}` | Profile, assignments and permitted rule history |
| PATCH | `/trainers/{id}` | Partial contact/profile/status update |
| POST | `/trainers/{id}/commission-rules` | Future percent commission, HTTP 201 |

Super Admin, owners and receptionists may manage profiles. Only Super Admin and
owners may read/write commission rules. Trainers use existing scoped `/trainer/*`
APIs instead. Actors come from verified Google sessions and SQL rechecks live
roles. Mutations require the configured frontend Origin. Unknown/identity/derived
fields are rejected. Browser database roles cannot call these RPCs/read projections.

```json
{"name":"Rohan Deshmukh","email":"contact@example.com","phone":"+919876543210","isActive":true}
```

Name: 2–160 trimmed characters. Contact email/phone are optional strings defaulting
to empty; empty clears them on PATCH. Null PATCH fields and empty patches are
rejected. Email is validated/lowercased (254 characters maximum). Phone follows
existing onboarding: spaces/hyphens removed, optional `+` and 8–15 digits; ten
local digits get `+91`. `isActive` must be a boolean.

List/write responses add `assignedMembersCount`, `activeMembersCount`, and
`hasLoginAccess` to the profile. Total count is distinct members across history.
Active count uses active member profiles and non-cancelled assignments covering
today inclusively in Asia/Kolkata, excluding future assignments. Deactivating a
trainer does not cancel otherwise current assignments. Counts are not writable.

GET item returns `{trainer, assignments, payoutRules}`. Assignment history includes
cancelled/expired/upcoming/current rows and inactive members with original dates/
purchase prices. Soft-deleted catalogue rows stay joined. Plan names are current
catalogue labels; invoice descriptions remain snapshots. Receptionists receive
`payoutRules: null` **from SQL**, not merely a hidden UI. Owners see existing fixed
or overlapping policy for review as well as percent rules.

## Future commission rules

```json
{"commissionRate":55.25,"effectiveFrom":"2099-01-01","effectiveUntil":null}
```

- Percent only: 0–100 inclusive, at most two decimals, server decimal arithmetic.
  Fixed rules need a defined business unit before write/calculation support.
- Start must be **after today in Asia/Kolkata**; UI defaults to tomorrow. Optional
  end is inclusive and cannot precede start.
- At most one preceding current/past rule may close at `new_start - 1 day`, keeping
  its ID, rate and past effective dates. A new rule is appended.
- Ambiguous overlaps or an overlapping already-scheduled future rule produce 409
  and roll back all changes, not a silent overwrite.
- A finite end does not automatically restore the old rate. Later dates need a
  separately scheduled rule; gaps are not guessed.
- Past/today collections and payout snapshots are not recalculated. No receipts,
  allocations, payouts or other financial transactions are generated. Estimates
  retain 004's collected-PT-allocation policy.
- Payout execution, retroactive corrections and refund recovery are separate
  workflows. The old undated overwrite adapter is removed.

Profile/rule writes create actor/trainer/time/before/after audit events. The shared
access-management advisory lock precedes trainer row locks, maintaining grant/
onboarding/purchase compatibility. Native multi-connection load/concurrency testing
remains a deployment check; SQL tests are single-connection. Profile edits remain
last-write-wins, without optimistic versions.

## UI and verification

Directory/detail use dedicated queries, not `/gym/workspace`, with filters,
loading/error/retry/empty states, confirmation and cache refresh. Access changes
also invalidate these caches. PT plans remain shared at `/personal-training-plans`.

Tests cover all seven migrations, existing paid payout/allocation provenance,
profile writes without identity changes, deactivation/004 dashboard/004 onboarding/
006 purchase compatibility, permissions, future periods/conflicts and auditing.
HTTP tests exercise session/Origin guards and validation; UI tests cover CRUD,
filters/details, rule scheduling, errors, cancellation and refresh.

Run backend `python -m unittest discover -s tests`; frontend `npm test`,
`npm run lint`, `npm run build`. Optional SQL execution:
`PGLITE_MODULE=<package>/dist/index.js node --test tests/test_trainer_management_schema.mjs`.
The existing `.gitignore` ignores tests directories; that policy is unchanged.
These are local checks, not a live Supabase deployment or authenticated E2E test.

OpenDesign was unreachable; existing styles/tokens were reused. Cards were checked
at 1440/1024/768/390px; details and both forms at desktop/mobile sizes. SSR form
fixtures check layout only, not hydrated defaults.

Verified locally: **67 backend tests, 67 frontend tests and 58 SQL checks** passed,
plus frontend lint, strict TypeScript/production build and registered OpenAPI
routes. No live Supabase migration or financial operation was performed.
