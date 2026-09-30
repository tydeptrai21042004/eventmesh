# Production-readiness notes

This repository is a production-oriented Testnet/reference implementation, not a claim of a fully managed production service.

## Hardened in v0.5

- No database engine is required by either the Vercel preview or standalone operator runtime.
- Vercel uses a bounded disposable `/tmp` cache plus a cryptographically verified portable browser snapshot for cold-start reconstruction.
- The standalone operator uses an atomic JSON state file on persistent storage.
- Portable snapshots are verified with the signed session, event/ACK signatures, hash chain, close commitment, and configured operator identities before restoration.
- Warm-cache rollback to a shorter client snapshot is rejected.
- Request body limits, same-origin browser mutation checks, idempotency-key/request-hash binding, Fiber receiver verification, and ambiguous CKB broadcast blocking remain enabled.
- Deep health exposes cache writability and external dependency status without returning secrets.

## Still intentionally limited

- Vercel preview state is **not durable server-side state**. Browser-carried signed snapshots make the reviewer flow recoverable, but they do not provide multi-party durable storage semantics.
- The JSON operator store assumes one writer process per state file. Do not mount the same file into multiple concurrent writers without adding an explicit locking/consensus layer.
- The public demo endpoint is intentionally usable without end-user authentication. A real operator deployment should put its mutation surface behind the application's authn/authz layer.
- CKB anchoring can persist deterministic transaction identity only within the configured host's state. Testnet broadcasting should remain disabled in disposable Vercel previews unless ambiguous-broadcast recovery is acceptable for the demo.
- Fiber and CKB availability are external dependencies; deep health reports them separately from core signing/cache readiness.
