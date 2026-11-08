# Access management API

Implemented against `gym_schema.sql` and `implementation_Details.md`. Google OAuth remains server-side; Supabase Auth is not used. There is no `access_assignments` table: API resources project `users` + `role_assignments`.

## Deployment

1. On a new empty database, apply the supplied initial schema once. **Do not replay it on an existing database.** Inventory/back up existing rows and adapt missing base tables additively if necessary.
2. Apply `migrations/001_google_identity_bootstrap_admin.sql` if not already installed.
3. Apply `migrations/002_access_management.sql` as the migration owner. It adds atomic RPCs, an audit table and a private projection. It enables RLS on identity/grant tables with no direct browser policies and grants the Supabase `service_role` the narrow table access needed by OAuth. Grant writes go through the RPCs. Keep the service key on the backend only.
   Then apply `migrations/003_delete_access_assignments.sql` to enable deletion. Existing audit references become nullable with `ON DELETE SET NULL`; original grant identifiers and facts remain in audit snapshots.
4. Restart the backend. Migration 002 notifies PostgREST to reload its schema cache. If RPCs remain missing, reload the Supabase/PostgREST schema cache. Missing migrations return HTTP 503, never fake success.

No migration was automatically applied to the live database as part of route implementation. Both migrations were executed against a disposable PostgreSQL-compatible test database.

## Authorization

- All routes require a valid application session and live DB authorization.
- Owner and permanent Super Admin are allowed, following the implementation guide. Receptionists (`admin` DB role) and trainers are denied. The existing frontend navigation still shows the Access Management screen only to Super Admin, per its original UI permission matrix; owners can use the authorized API.
- The permanent account `aryapat1234@gmail.com` is returned as a synthetic protected SUPER_ADMIN row, even without an ordinary grant. Its API row ID is its user UUID. No endpoint can revoke, relink, rename or demote it.
- The schema allows only `owner`, `admin`, `trainer` grants. No endpoint creates another SUPER_ADMIN. Lowercase DB roles map to frontend `GYM_OWNER`, `GYM_RECEPTIONIST`, `GYM_TRAINER`.
- Mutation requests require `Origin` equal to `FRONTEND_URL`. The browser sends it automatically; scripted cookie-authenticated API calls must include it. Untrusted/missing origins are rejected to protect cookie-authenticated privilege changes.
- The RPC receives actor ID only from the backend's live session dependency. Database functions independently recheck actor grants after obtaining a transaction advisory lock. Browser Supabase roles cannot execute the RPCs or read identity/grant tables.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/access-assignments` | All grants, including revoked history and protected bootstrap row |
| GET | `/access-assignments/trainers` | Active trainer options; no invented `trainers.user_id` |
| POST | `/access-assignments` | Authorize email, create pending user if needed, grant role |
| PATCH | `/access-assignments/{id}` | Change role/trainer link or ACTIVE/REVOKED grant status |
| DELETE | `/access-assignments/{id}` | Delete one grant; 204 response, keep account/financial records/audit snapshots |
| POST | `/access-assignments/{id}/revoke` | Revoke grant without deleting history |
| POST | `/access-assignments/{id}/reactivate` | Append a fresh grant based on a revoked one |

### Create

```json
{
  "email": "staff@gmail.com",
  "role": "GYM_TRAINER",
  "trainerId": "<existing active trainer UUID>",
  "displayName": "Optional staff display name"
}
```

For owner/receptionist, omit trainerId or send null/empty string. Trainer roles require an active trainer profile. Email is trimmed/lowercased and validated. `displayName` is optional; pending records use email as a nonempty placeholder until first verified login supplies a name. Google subjects are never accepted by these endpoints.

After migration 004, trainer access may instead include `newTrainer: {"name":"Trainer name","phone":"9876543210"}` with no trainerId. This creates and links the profile in the same transaction as the access grant; phone is optional. PATCH also supports creating a new linked trainer profile. See [trainer_dashboard.md](trainer_dashboard.md). The frontend defaults to creating a new profile when granting new trainer access, so pre-creating a trainer is no longer necessary.

### Patch

```json
{ "role": "GYM_RECEPTIONIST", "trainerId": null }
```

Or `{ "status": "REVOKED" }` / `{ "status": "ACTIVE" }`. Email may be echoed by the existing UI but cannot change identity. Actor, grantedBy, grantedAt, userId and Google subjects are not writable request fields. Unexpected fields are rejected.

### Response

```json
{
  "id": "<grant UUID>",
  "userId": "<user UUID>",
  "email": "staff@gmail.com",
  "name": null,
  "role": "GYM_TRAINER",
  "status": "ACTIVE",
  "grantedBy": "Administrator display name",
  "grantedAt": "2026-11-01T10:00:00+00:00",
  "trainerId": "<trainer UUID>",
  "isPermanent": false,
  "accountActive": true
}
```

`name=null` represents an identity that has not completed Google login. Status describes the grant; `accountActive=false` additionally prevents login. These routes do not silently reactivate disabled users, replace subjects, or reset account identities. Reactivating a disabled account requires a separate explicit administrative process.

## Transaction and history semantics

- Creating a pending user, granting its role and writing the audit event commit together. Invalid trainers/conflicts leave no orphan user.
- Role/trainer changes revoke the old row and insert a new grant, preserving granted_by/granted_at history. The response therefore has a **new grant ID**. Reactivation also appends a new row rather than clearing revoked_at on an old one.
- Existing unique indexes prevent duplicate active user/role pairs and multiple accounts linking the same active trainer profile. An unsuccessful replacement rolls the old revocation back.
- Multiple distinct active roles per user remain supported because the supplied schema explicitly permits them. Revoking one grant does not revoke other grants. OAuth resolves the highest supported active role: owner, then admin, then trainer.
- Audit events record the trusted actor and old/new grant projections in the same transaction. Operational API clients cannot update/delete audit events. Migration owners retain administrative powers and must be trusted.
- The UI now offers **Delete** instead of Revoke/Reactivate. Deletion physically removes an individual grant, not its user account. Other grants on the account remain effective. Existing audit records survive, with the optional live grant FK cleared and original UUIDs retained in snapshots. A new deletion audit event is committed atomically. The permanent bootstrap identity cannot be deleted. Repeating DELETE returns 404.
- Revocation/reactivation API routes remain for compatibility and role-history workflows. Repeated revocation is a no-op; repeated reactivation of an old grant conflicts if the resulting active grant already exists.

Errors: 401 missing/invalid session; 403 forbidden actor, protected bootstrap or bad Origin; 404 missing assignment/active trainer; 409 duplicate grant/trainer or disabled account; 422 malformed input/incompatible links; 503 missing RPC/schema or database unavailable. Raw database errors and Google subjects are not returned.

## Frontend integration

The Access Management page uses dedicated access queries and trainer options instead of `/gym/workspace`. Mutations invalidate the access query. Deletion requires explicit confirmation describing the retained account, audit trail and other grants. Permanent rows have no edit/delete controls; the backend remains authoritative. SUPER_ADMIN is not offered as an assignable catalog role.

## Verification

```sh
python -m unittest discover -s tests -v
```

`tests/test_access_routes.py` covers HTTP contracts and real session guards with isolated database doubles. `tests/test_access_schema.mjs` executes the supplied base schema and both migrations in a disposable PGlite database (the pgcrypto extension statement is omitted there because gen_random_uuid is built in). It tests history, rollback on conflicts, pending users, audit events, trainer uniqueness, role checks, bootstrap protection and database-role restrictions.

Run that optional SQL test with `PGLITE_MODULE` pointing to an isolated installation of `@electric-sql/pglite/dist/index.js`. Live Supabase deployment and true multi-connection concurrency testing remain deployment verification tasks; no production grants are mutated by these tests.

Current verification: 41 Python tests, 31 frontend tests, and 21 Node SQL test checks (including suite wrappers) passed. Frontend lint and strict TypeScript/production build also passed. Coverage includes protected permanent rows, confirmation before grants/deletion, independent access queries, timestamp formatting, actual grant removal and audit retention.
