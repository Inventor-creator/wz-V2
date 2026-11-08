# Workout Zone implementation

## Run

```sh
cd frontend
npm ci
npm run dev
```

Development defaults to the real backend (`VITE_MOCK_API=false`). For an isolated demo, explicitly set `VITE_MOCK_API=true` in `.env.local` and restart Vite. Sign in using the **Open demo workspace** form. Demo sessions do not read backend cookies and reset on reload; do not use demo mode to test Google session persistence.

Seeded authorized demo emails (type an email, not a role):

| Email | Seeded role |
| --- | --- |
| admin@form.example | Super Admin |
| owner@form.example | Gym Owner |
| desk@form.example | Receptionist |
| rohan@form.example | Trainer, linked to t1 |

Log out before testing another account. Reload resets demo sessions and changes. No localStorage authorization, real payment processing, or persistent mock records are used.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run preview
```

Production builds **always disable mocks**, even if `VITE_MOCK_API=true`. Backend access is also the development default; remove any `.env.local` override enabling mocks to test Google login. Set `VITE_API_URL` to the backend origin. Configure the deployment server to fall back to `index.html` for SPA routes. No OAuth client secret belongs in Vite environment variables.

## OpenDesign source

Retrieved the complete `wzv2` project via OpenDesign MCP (`32f05a4d-d17a-4000-a77d-f1773080ecba`). Its `index.html` contains all screens in one interactive prototype, not separate files. Also inspected `PLAN.md`, `CHECKLIST.md`, `QA.md`, and `od://design-systems/wise/DESIGN.md`.

`src/design.css` reuses the prototype's complete CSS: dark green-charcoal surfaces, #9fe870 lime, pill buttons, card radii, 232px sidebar, typography fallbacks, 1200/992/650px responsive adaptations, badges, tables, login split layout, modal forms and focus states. `src/app.css` adds React/native-dialog adaptations. No font files or image assets were supplied; the same system fallbacks are used.

Implemented prototype equivalents: Google login/error/unauthorized, finance overview, members, membership plans, trainers and shared PT plans, training members dashboard, fees and payment receipts, access management, member details. Deviations: Recharts replaces hand-drawn prototype charts; native dialogs replace custom modal focus trapping; a labeled development-email sign-in replaces prototype role selection; additional security explanations are explicit; no demo controls simulate successful production billing.

## Layout and source map

- `src/App.tsx`: providers, router, protected routes, lazy finance bundle, error boundary.
- `src/features/auth`: auth context, session-expiry handling, guards, PermissionGate.
- `src/components`: shared shell, header/sidebar, tables, status, dialogs, loading/error/empty states, forms and KPI cards.
- `src/features/members`: filters, numeric expiry sorting, pagination, creation, contact edits, archiving, details and history.
- `src/features/plans`, `src/features/trainers`: shared gym/PT plan CRUD, trainer profiles, scoped dashboard, payout configuration. PT plans are not trainer-owned; assignments choose the trainer separately.
- `src/features/payments`: dedicated Fees Due queries, exact partial/full receipts,
  refund/reversal history, member restoration, reviewed legacy charge approval,
  new subscriptions/renewals and cancellation. `features/billing` is legacy demo
  compatibility code, not the production billing policy.
- `src/features/finances`: real cash reports, transaction ledger, expense lifecycle,
  audit and CSV. `src/lib/financialApi.ts`, `financial.ts`, `types/financial.ts`
  provide decimal-string contracts, cache invalidation and durable retry keys.
- `src/features/access`: privileged email assignments.
- `src/types/domain.ts`: domain models and separate subscription types.
- `src/lib`: API adapters, centralized permissions, Zod schemas, date and INR utilities.
- `src/mocks/seed.ts`: realistic Indian development fixtures, relative dates.
- `src/tests`: permissions, routing, sidebar, scoping, expiry, validation, billing and payment contract tests.

## Production integration and deployment

The FastAPI backend implements `/auth/login`, `/auth/callback`, `/auth/logout`,
`/auth/me`. Those paths are preserved. `/auth/me` already resolves live roles and
active grants; the frontend fails closed rather than granting a default role.
Its current session response is:

```ts
{ id: string; name: string; email: string; role: Role;
  status: 'ACTIVE' | 'REVOKED'; trainerId?: string }
```

The backend callback can continue redirecting to `/`; `/auth/callback` is also supported as a frontend session-resolution landing. `/login/error` handles rejected OAuth. Cookie authentication uses Axios `withCredentials`; the server must enforce allowed origins, secure/HttpOnly cookies, appropriate SameSite policy, CSRF protection, active-email authorization, role revocation and independent authorization for **every** read/mutation. Never trust submitted trainer IDs for trainer queries.

### Domain HTTP boundary

`src/lib/api.ts` exposes existing feature adapters; `financialApi.ts` exposes the
dedicated financial boundary. No mock fallback occurs on real HTTP failure.
Migrations must be reviewed/applied manually before dependent features run.

- `/gym/workspace`: legacy demo adapter contract, not a production dependency of
  any of the eight feature pages. Existing demo calls are retained for compatibility
  tests only. They do not provide authorization for dedicated financial APIs.
- Implemented with migration 008: `GET/POST /members`, `GET /members/options`, `GET/PATCH/DELETE /members/:id`. Dedicated directory/detail contracts replace the Members workspace dependency; creation atomically snapshots gym/optional PT terms, edits affect contacts only, and deletion preserves referenced records. See `backend/docs/members.md`. The old archive adapter is replaced by explicit safe deletion.
- `GET/POST /membership-plans`, `PATCH /membership-plans/:id` (archive uses `isActive:false`).
- Implemented with migration 007: `GET/POST /trainers`, `GET/PATCH /trainers/:id`, and owner-only `POST /trainers/:id/commission-rules` with a future effective period. Profiles are independent of login grants. These pages do not require `/gym/workspace`; see `backend/docs/trainers.md`.
- Implemented: `GET/POST /personal-training-plans`, `GET/PATCH/DELETE /personal-training-plans/:id`, using shared catalogue fields and fixed calendar days. The dedicated Trainer Plans page does not use `/gym/workspace`. Apply migration 006 after 001–005; see `backend/docs/trainer_plans.md` for safe deletion/audit/security semantics.
- Financial APIs: `GET /fees-due`, `/fees-due/:id`, `/finances`,
  `/finances/export`; checked payment/refund/adjustment/expense/subscription/member
  lifecycle commands. See `backend/docs/fees_finances.md` for all paths/contracts.
  The old `/billing/*`, `/invoices`, `/payments`, `/finances/summary|trends|payouts`
  adapter methods are demo compatibility only, not production page dependencies.
- `GET/POST /access-assignments`, `PATCH /access-assignments/:id`.

All eight pages now use dedicated feature queries. Fees/Finances pagination,
filtering and reporting run on the backend; its checked SQL dataset currently
loads a single gym's history into memory, so large installations should move the
equivalent aggregation/pagination into SQL. Invoice payment status is derived,
not manually updated. Access changes retain existing protections and grant links.

## Business policies and limitations

- Dates are calendar days in Asia/Kolkata. Final subscription day is inclusive (0 days remaining is still valid). Monthly/yearly durations use clamped calendar arithmetic, then subtract one day. Thus Jan 31 + one month ends Feb 27 in a non-leap year. Change this documented policy in both server and frontend if gym rules differ.
- Member edits update contact/profile data only. New membership/renewal controls
  create new snapshot subscriptions; explicit cancellation preserves all charges.
- Billing demo invoices expired, unbilled recorded subscriptions once; it does not simulate recurring renewals, taxation, refunds or proration.
- Real financial pages use exact recorded allocations/refund provenance and
  Python Decimal/PostgreSQL numeric, never proportional browser arithmetic.
  Current receivables are not historical as-of balances and never collections.
  Actual paid trainer payouts count as cash outflows, not guessed fixed salaries.
  Expense reversals retain original payments plus returned-cash offsets. Net cash
  flow is not profit. Unknown legacy facts are flagged, never invented.
- Tests cover frontend behavior and mock contracts only; they are not backend security tests or a substitute for real OAuth, concurrent payment/billing integration tests, or an accessibility audit.
- Full authenticated-page visual regression and end-to-end real-backend testing remain to be performed. Responsive CSS follows the retrieved source; login screenshots were inspected at desktop and mobile widths.
- Dependency audit: production dependency vulnerabilities were addressed with non-breaking updates. Remaining dev-tool advisories must be reviewed before deployment; do not force a breaking ESLint downgrade without checking compatibility.

## Historical verification results

- `npm test`: 24 passing tests across domain/mock contracts and rendered routing/sidebar/billing interactions.
- `npm run lint`: passed with no warnings.
- `npm run build`: strict TypeScript and production build passed. Feature routes and Recharts are lazy loaded; no oversized-chunk warning in the final build.
- `npm audit --omit=dev`: zero production vulnerabilities. Full audit retains 10 moderate development-tool dependency advisories.
- Inspected real-browser login screenshots at 1440px and 390px. Authenticated screen layouts were compared to the retrieved OpenDesign source, but full browser visual regression of every authenticated screen and 1024/768px review is not yet complete. No claim of pixel-perfect or exhaustive accessibility verification is made.

## Financial implementation verification

**ALL NEW SQL MIGRATIONS HAVE BEEN CREATED BUT NOT APPLIED.** Required 009 follows
001–008. No SQL migration runner was executed for this task, including against
disposable databases. Backend unit/mock/static and frontend regression results
are recorded in `specs/fees_finances_report.md`; real DB/concurrency/HTTP E2E and
authenticated browser financial testing remain **BLOCKED — PENDING MANUAL
MIGRATION** or explicitly not executed. See `backend/docs/financial_testing.md`.
The production financial pages always require real backend Google authentication;
development demo authentication does not simulate financial success.
