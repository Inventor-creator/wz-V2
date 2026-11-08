# MyApp Backend

Access-management routes are implemented and registered. See
[`docs/access_management.md`](docs/access_management.md) for required migrations,
endpoint contracts, permissions, audit/history semantics and deployment checks.

The trainer dashboard and atomic create-and-link trainer onboarding are also
implemented. Apply migration `004` after `001`–`003`; see
[`docs/trainer_dashboard.md`](docs/trainer_dashboard.md) for routes and payout policy.

Membership plan create/edit/delete routes are implemented as well. Apply migration
`005` after `001`–`004`; see [`docs/membership_plans.md`](docs/membership_plans.md).
Referenced plans are removed from the catalogue without deleting subscription or
financial history. Duration is stored in fixed calendar days.

Shared trainer/PT plan CRUD is implemented at `/personal-training-plans`.
Apply migration `006` after `001`–`005`; see
[`docs/trainer_plans.md`](docs/trainer_plans.md). Trainer selection belongs to the
member assignment, not the plan catalogue. Deletion preserves PT and payout history.

A FastAPI + Supabase Python API scaffold with Google OAuth login.

This is a **skeleton**: the infrastructure is wired up and working, while all
domain modules have been gutted to empty stubs. Fill in the `TODO`s to build
your own feature set.

## Stack

- **FastAPI** app server
- **Supabase Python** async client for database queries over HTTPS
- **Authlib** Google OAuth 2.0 with server-side session cookies

## What is already working

| Area | File | Status |
|------|------|--------|
| App wiring and routes | `main.py` | Ready |
| Lifespan, middleware, CORS | `config.py` | Ready |
| Google OAuth client | `authService.py` | Ready |
| Supabase client dependency | `database/__init__.py` | Ready |
| OAuth login/callback/logout/me | `Routes/authRoutes.py` | Ready |

## What you need to implement

- Manage database tables and relationships through Supabase migrations
- **`schemas/*.py`** — define Pydantic request/response schemas
- **`Routes/*.py`** — implement the CRUD endpoint stubs
- Register new routers in `main.py`

## Setup

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # fill in Supabase URL/service-role key and Google OAuth creds
python main.py
```

The API will be available at `http://localhost:8080` (Swagger docs at
`/docs`).

## Project Structure

```
backend/
├── main.py                 # FastAPI app entry point and router registration
├── config.py               # Lifespan and middleware configuration
├── authService.py          # Google OAuth client configuration
├── requirements.txt
├── database/
│   ├── __init__.py         # Supabase client dependency
│   └── models.py           # Schema is managed in Supabase
├── schemas/                # Pydantic request/response schemas (stubbed)
└── Routes/                 # FastAPI routers (auth wired, CRUD stubbed)
```

## Conventions

- The callback stores identity/profile data in `request.session["user"]`, not
  trusted role grants. `/auth/me` resolves the live user and unrevoked grants.
  Protected endpoints must resolve live authorization too, not trust a cookie role.
- Multi-entity scoping in the original project used an `X-Gym-Id` request
  header set by the frontend. The same pattern can be reused for any
  "active workspace" concept.
- Follow `docs/implementation_Details.md` before changing database code.
  Login reads `users.id`, `email`, `google_subject`, `active`, and `display_name`, plus live
  `role_assignments` (`user_id`, `role`, `trainer_id`, `revoked_at`). Pre-authorize
  an active user and an unrevoked grant (except the permanent bootstrap admin). Only a verified Google email can claim
  a pending account with a NULL subject; an existing subject is never replaced.
  OAuth names/avatars are kept in the session, not written to obsolete columns.
  Database roles map to frontend roles: `owner` → `GYM_OWNER`, `admin` →
  `GYM_RECEPTIONIST`, and `trainer` → `GYM_TRAINER`.
  `SUPER_ADMIN` is reserved for the configured permanent identity, not a DB grant.
  Unknown roles fail closed.
  Trainer IDs come from grants, never `trainers.user_id`.
- Manage schema changes with Supabase migrations or the SQL editor;
  application startup does not create tables.
- `SUPABASE_SERVICE_ROLE_KEY` is a backend-only secret that bypasses row-level
  security. Never put it in frontend environment variables or commit it.
- Google OAuth/session login is unchanged; Supabase Auth is not used.

## Permanent Super Admin and verified Google binding

`config.SUPER_ADMIN_EMAIL = "aryapat1234@gmail.com"` is the permanent server-side
Super Admin. Ordinary assignments cannot override this role. The verified Google
email/subject must match the database identity; possessing the email string in a
request is not authentication. Only this bootstrap identity can be auto-created.

The callback retains Authlib's authorization-code exchange/state/nonce checks,
then explicitly verifies the raw ID token using Google's `google-auth` library
(signature, issuer, audience, expiry, verified email). `token.userinfo` is not the
authority. Install updated dependencies with `pip install -r requirements.txt`.

**Apply** `migrations/001_google_identity_bootstrap_admin.sql` to the existing
database before deployment. It adds the requested unique non-null-subject index,
a unique normalized-email index needed for concurrent bootstrap creation, and
triggers protecting the permanent admin and already-bound Google subjects. It
does not invent a subject, drop data, replay the initial schema, or insert role
grants. Duplicate pre-existing identities cause migration failure and must be
reconciled manually, not deleted automatically. Run as a migration owner:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_google_identity_bootstrap_admin.sql
```

Alternatively execute the migration in the Supabase SQL editor. The service key
bypasses RLS but does not bypass normal triggers/unique constraints; database
owners can still disable/drop protections, so keep migration credentials separate.

Use `Depends(require_roles("GYM_OWNER", ...))` from `Routes.authRoutes` on future
business routes. It resolves live identity/grants and gives the permanent admin
all permissions. Use `reject_bootstrap_access_change(target_user)` before any
  future user/access mutation. Access-management routes now also use live
  authorization; gym domain endpoints remain unimplemented. Database triggers
also reject direct bootstrap deactivation, deletion, renaming and grant changes.

Set a strong `SECRET_KEY`; empty secrets are rejected. Signed application cookies
are HttpOnly and SameSite=Lax; HTTPS origins infer Secure cookies. Explicitly set
`SESSION_COOKIE_SECURE=true` for production HTTPS. Google tokens are not stored
in the session. Super Admin/owner login redirects to `/finances`.

After signing in through Google, run the read-only verifier:

```sh
python scripts/verify_bootstrap_admin.py
```

It checks for exactly one matching row, a non-null subject and `active=true`,
without logging the durable Google identifier. Equivalent database verification:

```sql
SELECT id, email, google_subject, active
FROM public.users
WHERE lower(email) = 'aryapat1234@gmail.com';
```

### Diagnosed NULL subject cause

During this fix, a read-only query found one bootstrap row with `active=true`,
`google_subject=NULL`, and **zero role assignments**. The previous callback called
`_authorized_user` before its conditional subject update; the missing grant raised
403 and skipped the write. The permanent admin is now resolved before ordinary
grant checks. The final read-only verification subsequently passed: exactly one
matching live user, `google_subject` non-null, and `active=true`. No subject was
fabricated or written by a diagnostic/test script; only the login flow binds it.

Direct SQL connectivity from this environment failed, so the migration was **not
applied remotely**. Do not infer deployment from source changes or test results.

For real Google login in the frontend, set `VITE_MOCK_API=false` in
`frontend/.env.local` and restart Vite. Otherwise the development adapter does
not read the backend session. Keep `GOOGLE_REDIRECT_URI` pointed to the backend
`/auth/callback`, and `FRONTEND_URL` pointed to the frontend origin.

Offline auth regression tests (using the activated backend virtualenv):

```sh
python -m unittest discover -s tests -v
```

These mock Google/Supabase responses; live OAuth and database integration must
also be verified against the deployed schema.

`tests/test_auth_schema.mjs` additionally executes the migration against an
in-memory PGlite PostgreSQL-compatible database. Install `@electric-sql/pglite`
as an isolated development tool and set `PGLITE_MODULE` to its `dist/index.js`,
then run `node --test tests/test_auth_schema.mjs`. This verifies the SQL indexes
and triggers but is not a live Supabase or multi-connection concurrency test.

Verification for this change: 27 Python tests passed, including real
google-auth signature/issuer/audience/expiry checks with ephemeral fixture keys;
8 SQL runner checks passed. OAuth exchanges, HTTP route tests and concurrency
simulation use isolated test doubles, never the production Google account.
