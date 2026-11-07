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

Implemented prototype equivalents: Google login/error/unauthorized, finance overview, members, membership plans, trainers and trainer-specific plans, training members dashboard, fees and payment receipts, access management, member details. Deviations: Recharts replaces hand-drawn prototype charts; native dialogs replace custom modal focus trapping; a labeled development-email sign-in replaces prototype role selection; additional security explanations are explicit; no demo controls simulate successful production billing.

## Layout and source map

- `src/App.tsx`: providers, router, protected routes, lazy finance bundle, error boundary.
- `src/features/auth`: auth context, session-expiry handling, guards, PermissionGate.
- `src/components`: shared shell, header/sidebar, tables, status, dialogs, loading/error/empty states, forms and KPI cards.
- `src/features/members`: filters, numeric expiry sorting, pagination, creation, contact edits, archiving, details and history.
- `src/features/plans`, `src/features/trainers`: plan/trainer CRUD, trainer-dependent PT plans, scoped dashboard, payout configuration.
- `src/features/billing`, `src/features/payments`: billing preview/confirmation, invoice balances, partial payments, receipts.
- `src/features/finances`, `src/features/access`: reports and privileged email assignments.
- `src/types/domain.ts`: domain models and separate subscription types.
- `src/lib`: API adapters, centralized permissions, Zod schemas, date and INR utilities.
- `src/mocks/seed.ts`: realistic Indian development fixtures, relative dates.
- `src/tests`: permissions, routing, sidebar, scoping, expiry, validation, billing and payment contract tests.

## Production integration required

The existing FastAPI backend implements `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`. Those paths are preserved. It currently returns no role/status in `/auth/me`; the frontend deliberately fails closed rather than granting a default role. Extend that trusted session response to:

```ts
{ id: string; name: string; email: string; role: Role;
  status: 'ACTIVE' | 'REVOKED'; trainerId?: string }
```

The backend callback can continue redirecting to `/`; `/auth/callback` is also supported as a frontend session-resolution landing. `/login/error` handles rejected OAuth. Cookie authentication uses Axios `withCredentials`; the server must enforce allowed origins, secure/HttpOnly cookies, appropriate SameSite policy, CSRF protection, active-email authorization, role revocation and independent authorization for **every** read/mutation. Never trust submitted trainer IDs for trainer queries.

### Domain HTTP boundary

`src/lib/api.ts` exposes typed adapters. The currently missing server routes must return these domain types (no mock fallback on HTTP failure):

- `GET /gym/workspace`: `Database` shape, strictly role-scoped. Trainer responses must include **only** their trainer profile, PT plans/subscriptions, assigned member contacts and own payout configuration; exclude gym memberships, all invoices/payments, access assignments and other trainers. Receptionists must not receive payout configurations or access assignments. Aggregate financial endpoints are owner/admin-only.
- `GET/POST /members`, `GET/PATCH /members/:id`, `POST /members/:id/archive`.
- `GET/POST /membership-plans`, `PATCH /membership-plans/:id` (archive uses `isActive:false`).
- `GET/POST /trainers`, `GET/PATCH /trainers/:id`.
- `GET/POST /personal-training-plans`, `PATCH /personal-training-plans/:id`.
- `POST /billing/preview`: `BillingCharge[]`; no side effects.
- `POST /billing/run`: `{idempotencyKey:string}` → created invoice count. Enforce unique subscription/billing period and persisted idempotency atomically. Independently charge gym and PT, use historical prices, never mark paid or extend subscriptions implicitly. Use transactionally consistent previews in the production server.
- `GET /invoices`, `GET /invoices/:id`; `GET/POST /payments`.
- `GET /finances/summary`, `/finances/trends`, `/finances/payouts`; `PATCH /trainers/:id/payout` with `{commissionRate}`.
- `GET/POST /access-assignments`, `PATCH /access-assignments/:id`.

The workspace endpoint supplies most screens' role-scoped query; the Access Management screen now uses dedicated `/access-assignments` and `/access-assignments/trainers` queries and does not require a workspace endpoint. Those backend routes are implemented; apply the migrations documented in `backend/docs/access_management.md` before using them. Granular list adapters are also available for further backend integration. Production should paginate large datasets server-side and replace the remaining workspace snapshot with feature-specific queries. Payment creation must atomically revalidate current balance, prevent duplicates, create a durable receipt and update invoice status. Persist plan references and subscription purchase prices. Access changes protect the permanent Super Admin, preserve grant history, and securely link trainer profiles through role assignments.

## Business policies and limitations

- Dates are calendar days in Asia/Kolkata. Final subscription day is inclusive (0 days remaining is still valid). Monthly/yearly durations use clamped calendar arithmetic, then subtract one day. Thus Jan 31 + one month ends Feb 27 in a non-leap year. Change this documented policy in both server and frontend if gym rules differ.
- Member edits update contact/profile data only. They intentionally do not overwrite historical subscriptions. A dedicated renewal/change-subscription workflow and backend rules are still needed.
- Billing demo invoices expired, unbilled recorded subscriptions once; it does not simulate recurring renewals, taxation, refunds or proration.
- Finance collections are filtered by payment date; category allocation is proportional to invoice line amounts. Outstanding balances are current balances for invoices issued by report end, **not historical as-of balances**. Fixed payouts, if returned by the server, are interpreted per report period. Estimates are not disbursements. Unlinked historic PT payments cannot be attributed to a trainer. Revenue after payouts is not net profit.
- Tests cover frontend behavior and mock contracts only; they are not backend security tests or a substitute for real OAuth, concurrent payment/billing integration tests, or an accessibility audit.
- Full authenticated-page visual regression and end-to-end real-backend testing remain to be performed. Responsive CSS follows the retrieved source; login screenshots were inspected at desktop and mobile widths.
- Dependency audit: production dependency vulnerabilities were addressed with non-breaking updates. Remaining dev-tool advisories must be reviewed before deployment; do not force a breaking ESLint downgrade without checking compatibility.

## Verification results

- `npm test`: 24 passing tests across domain/mock contracts and rendered routing/sidebar/billing interactions.
- `npm run lint`: passed with no warnings.
- `npm run build`: strict TypeScript and production build passed. Feature routes and Recharts are lazy loaded; no oversized-chunk warning in the final build.
- `npm audit --omit=dev`: zero production vulnerabilities. Full audit retains 10 moderate development-tool dependency advisories.
- Inspected real-browser login screenshots at 1440px and 390px. Authenticated screen layouts were compared to the retrieved OpenDesign source, but full browser visual regression of every authenticated screen and 1024/768px review is not yet complete. No claim of pixel-perfect or exhaustive accessibility verification is made.
