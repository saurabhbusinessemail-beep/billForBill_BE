# F026 product unit rollout

Run from `BE` with the normal application MongoDB configuration. Stop catalog,
document and inventory writes during the backfill; take a database backup first.

1. `npm run migrate:product-units` previews the shared and business product counts.
2. Review `repair` products. Missing references, incompatible dimensions, wrong
   canonical metric factors, duplicate options and unsupported precision require
   an authorized product edit. The migration never invents a conversion.
3. `npm run migrate:product-units -- --apply` embeds valid configurations and marks
   unresolved products `needsUnit`. Retry is safe: products already embedded are
   left unchanged. Existing legacy fields remain for repair/audit and rollback.
4. Run the preview again, verify stored unit names/factors against the backup,
   and exercise product, document, pricing and inventory flows before resuming
   writes. New writes require valid embedded product units.

This migration changes only current product configuration. It never changes
document lines, bill snapshots, movements, balances or reorder levels. Do not
remove legacy product fields or generic unit collections in this rollout.
Rollback requires the matching application version and retained legacy fields;
newly created embedded-only products require explicit handling before reverting
application readers. No automatic cleanup or stock rebase is provided.

Decimal bounds: factors and base quantities are positive and at most 10 billion;
factors support eight decimal places, document quantities six, and stock four.
Conversions must be exact at the destination precision. Selected-unit prices use
the document engine's twelve-digit bound and six decimal places. The seed keeps
its configured base units and skips optional conversions such as one piece to
one twelfth of a dozen, which cannot be represented exactly at that precision.

Focused checks: `npm run test:f026` (requires the existing frontend TypeScript
installation for tests of the shared editor's conversion helper).

Live regression (PowerShell, from `BE`):
`$env:F026_INTEGRATION='1'; npm run test:f026:integration`.
This opt-in command uses fresh uniquely named app/jobs databases on the configured
MongoDB server and removes its generated records when finished; it never applies
the migration to the application database. It requires database creation/write
access on that server. Results and rollout evidence: `docs/harness/F026_VERIFICATION.md`.

Optional isolated browser review: first build the frontend, then additionally set
`F026_UI_REVIEW=1` before the live regression. The temporary HTTPS app listens on
localhost:3443 using the existing local certificate. Open its printed review URL.
Finish with Enter, Ctrl+C, or create the printed temporary `.stop` file to trigger
cleanup. Do not terminate the process before cleanup completes.
