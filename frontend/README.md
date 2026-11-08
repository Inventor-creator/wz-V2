# Workout Zone frontend

Functional role-aware gym management built with the existing React 19, strict TypeScript, Vite, Tailwind and npm setup. UI styles are reused from the **wzv2 OpenDesign** project.

Fees Due and Finances now use dedicated real financial APIs, exact decimal-string
commands, receipt/refund history, expense lifecycle, reports and CSV. They do not
use the workspace snapshot or development financial seed. Required migration
**009_fees_and_finances.sql is CREATED — NOT APPLIED — AWAITING MANUAL REVIEW**.
Real database financial verification is **BLOCKED — PENDING MANUAL MIGRATION**.
See `backend/docs/fees_finances.md` and `backend/docs/financial_testing.md` before
deployment. Demo authentication cannot authorize these real backend endpoints.

## Start

```sh
npm ci
npm run dev
```

Open `http://localhost:5173` and use **Continue with Google**. Backend authentication is enabled by default. Keep the backend running at `http://localhost:8080`.

For the isolated demo only, set `VITE_MOCK_API=true` in `.env.local`, restart Vite, and enter `admin@form.example` in **Open demo workspace**. Demo sessions reset on reload and do not read Google login cookies. Other seeded emails and integration requirements are in [IMPLEMENTATION.md](IMPLEMENTATION.md).

**Continue with Google** uses the existing backend OAuth flow. The demo sign-in is explicitly simulated and does not authenticate with Google. Changes reset on reload. Production builds cannot enable mocks.

The trainer dashboard uses dedicated backend routes, not the workspace snapshot.
When granting Trainer access, select **Create and link a new trainer** and enter
the name/optional phone, or link an existing profile. Apply backend migration
`004` after `001`–`003` first; see `backend/docs/trainer_dashboard.md`.

Membership Plans supports live create/edit/delete with its own API queries.
Apply backend migration `005` after `001`–`004`. Referenced plans are removed from
the catalogue while historical memberships and invoices are retained; unused plans
are permanently deleted. See `backend/docs/membership_plans.md`.

**Trainer Plans** at `/personal-training-plans` supports live catalogue CRUD,
search/status filters and safe deletion without a workspace snapshot. Apply
backend migration `006` after `001`–`005`. Plans are shared; select the trainer
separately when assigning a member. See `backend/docs/trainer_plans.md`.

**Trainers** now has independent list/detail queries, profile create/edit/status,
assignment history, and owner-only future commission scheduling. Apply migration
`007` after `001`–`006`. Profile deactivation stops new PT assignments; it does not
revoke login grants or erase history. See `backend/docs/trainers.md`.

**Members** now has dedicated add/edit/delete, list/detail and onboarding-option
queries. Apply backend migration `008` after `001`–`007`. Contact edits do not
rewrite subscriptions; deleting a referenced member removes them from the directory
without erasing debts/history. Adding a member records subscriptions, not a payment
or billing run. See `backend/docs/members.md`.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

## Features

- Protected routes and permission-based navigation for four roles.
- Members, atomic gym/optional PT onboarding, contact edits, safe deletion and history.
- Membership plans, trainers and shared PT plans with validated forms.
- Trainer-scoped dashboard with expiry sorting and configured payout estimates.
- Billing preview, confirmation and development idempotency protection.
- Outstanding fees, partial payment logging and payment receipts.
- Date-filtered finance KPIs, Recharts reports and payout breakdowns.
- Super Admin email authorization, role changes, trainer links and last-admin protection.
- Responsive OpenDesign shell, accessible native dialogs, loading/error/empty states.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the source map, backend contracts, design deviations, financial/date policies and known limitations. The existing backend needs gym domain APIs and trusted role/status fields before production use. Frontend guards and mock contract tests do not provide backend security.
