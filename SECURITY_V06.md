# EventMesh v0.6 security and stability changes

EventMesh v0.6 deliberately separates the database-free **Demo** workspace from the **Real / Testnet** workspace.

## Demo workspace

- Stable deterministic preview identities are derived server-side from `DEMO_MASTER_SECRET`.
- No database is required. A bounded disposable server cache is only an optimization; signed browser snapshots remain the recovery mechanism.
- The one-click reference flow exists only here.
- CKB broadcasting is rejected from Demo even if a Testnet signer is configured.
- Demo snapshots use browser Local Storage so a refresh can resume the walkthrough.

## Real / Testnet workspace

The connected workspace is disabled by default. Enabling it requires all of the following:

- `EVENTMESH_TESTNET_MODE=true`
- `EVENTMESH_TESTNET_ACCESS_KEY` with at least 32 characters
- explicit `OPERATOR_A_PRIVATE_KEY`
- explicit `OPERATOR_B_PRIVATE_KEY`

The browser access key is sent only in the `x-eventmesh-access-key` header and the UI never persists it. Testnet snapshots use Session Storage, not Local Storage.

Actual CKB Testnet broadcasting additionally requires `TESTNET_ALLOW_CKB_BROADCAST=true` and `CKB_PRIVATE_KEY`.

## Protocol hardening

- Workspace environment (`DEMO` or `TESTNET`) is part of the signed session object.
- Mutating requests carry `expectedEventCount` and `expectedChainTip`; stale writes are rejected with `STATE_PRECONDITION_FAILED`.
- Browser tabs use a short edit lease to reduce accidental same-browser forks.
- Event types are allow-listed and core service-flow order is checked server-side.
- `requestId`, service, notes, result hashes, payload sizes, final-state sizes, TTL, and event counts are bounded.
- Payment settlement is refused unless the receiver-side Fiber RPC independently verifies it.
- CKB anchoring persists deterministic transaction identity before broadcast and does not blindly retry an ambiguous submission.
- Same-origin checks, optional `EVENTMESH_PUBLIC_ORIGIN` pinning, stricter CSP, HSTS, permissions policy, and no-referrer policy are included.

## Remaining database-free limitation

A database-free serverless deployment cannot provide a globally serialized lock across all Vercel instances. Optimistic chain preconditions detect stale writes against the state visible to an instance, while the browser edit lease prevents the common same-browser race. Two different clients can still create competing descendants from the exact same signed snapshot on different cold instances. Those descendants are independently valid but form a detectable fork because they share the same sequence and previous hash with different event hashes.

For production-grade multi-client coordination, run each independent operator as its own service and use durable operator storage or another consensus/coordination layer. The Vercel Real / Testnet workspace remains a controlled Testnet deployment, not a production custody model.
