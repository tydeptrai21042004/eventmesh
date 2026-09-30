# Production-readiness notes

This repository is a production-oriented Testnet/demo implementation, not a claim of a fully managed production service.

## Hardened in this patch

- Durable Postgres/Neon state on Vercel through `DATABASE_URL`.
- Automatic, idempotent schema initialization; no manual migration step for the demo API.
- Optimistic concurrency control for serverless writes.
- Durable idempotency and rate-limit state when Postgres is enabled.
- Fail-closed Vercel storage configuration by default.
- Request body limits, same-origin browser mutation checks, idempotency-key/request-hash binding, Fiber receiver verification, and ambiguous CKB broadcast blocking remain enabled.
- Deep health exposes storage durability/writability and external dependency status without returning secrets.

## Still intentionally limited

- The Vercel demo stores the compact reconciliation state in one JSONB row. This is appropriate for a small public demo/reviewer workload, not high-throughput multi-tenant operation. A hosted service should normalize sessions/events/idempotency into separate tables and add retention/archival policies.
- The public demo endpoint is intentionally usable without end-user authentication. A real operator deployment should put its mutation surface behind the application's authn/authz layer.
- CKB anchoring persists the deterministic transaction hash before submission and blocks automatic retry when broadcast outcome is ambiguous; reconciliation uses that persisted identity.
- Fiber and CKB availability are external dependencies; deep health reports them separately from core storage readiness.
