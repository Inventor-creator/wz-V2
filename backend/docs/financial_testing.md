# Financial verification and manual acceptance

No new migration was executed, including against disposable databases.

## Safe checks

From `backend/`, using the backend Python virtualenv:

```sh
python -m unittest discover -s tests
```

Tests use mocked Google/Supabase calls or pure calculations. `test_financial_e2e.py`
is skipped by default with **BLOCKED — PENDING MANUAL MIGRATION**. No Python test
executes migration SQL. Existing `.mjs` schema runners **do execute migrations**;
they were not invoked in this task and must not be used to bypass this restriction.

Static parsing optionally uses `pglast` from an isolated temporary tool directory:
`PYTHONPATH=<temporary-pglast-directory> python -m unittest discover -s tests`.
It parses SQL and PL/pgSQL only; it does not connect to or create any database.
Parser success cannot prove schema binding, privileges, trigger runtime behavior,
numeric integrity or multi-session concurrency. No runtime dependency was added.

From `frontend/`:

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

Coverage includes request validation (exact money strings, invalid precision,
dates/methods/IDs/unknown fields), live-role/Origin denial, safe RPC errors, HTTP
pagination/date contracts, cash-vs-receivables calculations, archived balances,
refund/expense-reversal month boundaries and leap days, CSV formula escaping,
500 generated exact-Decimal reconciliation cases, frontend forms/filters/loading/
errors, reversal confirmations, retry keys, rapid-click guards and invalidation.
Existing six-module unit/mock regressions are included. Test directories are now
unignored for source files, not caches, so coverage can be committed.

## Real HTTP E2E suite — currently BLOCKED

The ten scenarios in `tests/test_financial_e2e.py` are implemented but not executed
against a database. A developer must first apply reviewed migrations manually to
an explicitly authorized **disposable test installation**, then configure:

- `WZ_FINANCIAL_E2E=DISPOSABLE_MANUALLY_MIGRATED` (explicit opt-in)
- `WZ_TEST_API_URL`, `WZ_TEST_ORIGIN`
- `WZ_TEST_OWNER_COOKIE` (complete Cookie header from an owner/Super Admin session)
- `WZ_TEST_TRAINER_COOKIE` (independent insufficient-role session)
- `WZ_TEST_PLAN_ID` (active positive-price gym plan; at least INR 0.03)

Run `python -m unittest discover -s tests -p test_financial_e2e.py` only after that
manual preparation. The test suite performs **no schema creation or migrations**.
It deliberately retains its test financial history. Do not run against the live
gym, log session cookies or attempt destructive cleanup.

| Scenario | Implemented automated check | Current status |
|---|---|---|
| 1 Full payment | New member auto-charge → receipt → zero balance | BLOCKED — PENDING MANUAL MIGRATION |
| 2 Partial payment | Two installments and overpayment rejection | BLOCKED — PENDING MANUAL MIGRATION |
| 3 Delete with debt | Archived member + same retained invoice balance | BLOCKED — PENDING MANUAL MIGRATION |
| 4 Reverse receipt | Original remains, debt reopens, second reversal rejected | BLOCKED — PENDING MANUAL MIGRATION |
| 5 Expense | Draft → paid → reverse; retained versions/history | BLOCKED — PENDING MANUAL MIGRATION |
| 6 Renewal | New invoice, prior debt intact, duplicate rejected, cancel preserves debt | BLOCKED — PENDING MANUAL MIGRATION |
| 7 Concurrency | Two simultaneous full receipts; exactly one accepted | BLOCKED — PENDING MANUAL MIGRATION |
| 8 Unauthorized | Trainer denied fees, reports, export | BLOCKED — PENDING MANUAL MIGRATION |
| 9 Lost response | Discard committed response, retry same key → same receipt | BLOCKED — PENDING MANUAL MIGRATION |
| 10 Regression | Existing module API read smoke checks | BLOCKED — PENDING MANUAL MIGRATION |

These are HTTP/database integration tests, **not** a substitute for browser visual,
keyboard/mobile/a11y, real Google OAuth or browser-to-database E2E verification.
No authenticated real-browser financial test was run in this environment.

## Additional post-application verification (developer checklist)

1. Compare pre/post counts and IDs of members, subscriptions, invoices, original
   receipts/refunds and payouts. Verify no unintended new debt for legacy purchases.
2. Check `invoice_balances`: no negative billed/allocated/outstanding; verify
   refund allocations exactly match each refund and never exceed their source.
3. Exercise owner and receptionist payment access and direct trainer RPC denials;
   try raw anon/authenticated/service-role ledger writes and view reads. Checked
   functions must work while direct writes fail. Check revocation after login.
4. Test two simultaneous partial payments summing above the balance; simultaneous
   refunds; same-key retries; same-key changed payload/actor; concurrent archive
   versus payment, renewal versus cancellation and stale expense versions.
5. Exercise payment/refund after expiry and archive, restored free memberships,
   repeated archive/delete/restore, partial-then-full refund, invalid precision,
   references, reasons, future postings and timeout outcomes.
6. Test refund of a receipt reserved in draft/approved/paid trainer payouts:
   reject without changing payout provenance. A cancelled reservation requires
   explicit settlement review, not payout-item deletion.
7. Verify invoice snapshots remain unchanged after catalogue edits/deletion;
   cancellation of partial/full/free/future membership retains correct balances.
   Approve a legacy unbilled charge only after checking external payment records;
   retry it twice and verify one obligation. Test free/duplicate renewals.
8. Compare CSV and unfiltered ledger sums, gross/refund/net/category/method/plan
   reports, zero months, Feb 29, year/month boundaries and midnight Asia/Kolkata.
   Verify current receivables are not presented as historical period-end balances.
9. Test archived members with multiple receipts/refunds and with no invoice;
   preserve outstanding debt and restore via the archived-member selector.
10. Reconcile legacy unallocated receipts, unknown paid-expense dates/categories,
    refunded trainer payouts and duplicate subscription lines without deleting
    original history. Re-run all application checks after approved corrections.

## Results

See `specs/fees_finances_report.md` for final command counts and verification scope.
Earlier module documentation's PGlite results predate this task's prohibition and
were **not rerun**. Mock success must never be reported as financial DB validation.
