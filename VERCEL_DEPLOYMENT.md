# EventMesh — single Vercel project

## Required

1. Import the repository root as one Vercel Project.
2. Attach Postgres from the Vercel Marketplace.
3. Add `DEMO_MASTER_SECRET` with at least 32 random bytes.
4. Deploy.

No browser admin token and no `VITE_OPERATOR_A_URL` / `VITE_OPERATOR_B_URL` are required.

## Optional real integrations

### Fiber

Set `FIBER_RECEIVER_RPC_URL` and, if needed, `FIBER_RECEIVER_RPC_TOKEN`.

`PAYMENT_SETTLED` is fail-closed: without the receiver FNN, the API refuses to sign an ACCEPT acknowledgement for payment settlement.

### CKB

Set `CKB_PRIVATE_KEY` and `CKB_RPC_URL`.

The anchor state machine stores `BROADCASTING` before network submission. If submission throws after that point, the state becomes `BROADCAST_UNKNOWN` and automatic rebroadcast is blocked. This avoids silently creating a second checkpoint after an ambiguous response.

## Durable retry behavior

- Guided workflow operations carry idempotency keys.
- Idempotency keys are bound to a request hash.
- Payment hashes are globally unique in the demo database.
- Receiver evidence identity excludes `verifiedAt`; repeated observations update `last_verified_at` and `verification_count` rather than becoming false conflicts.
- Payment claim + evidence + ACK are committed in one Postgres transaction.
- Session rows are locked while sequence numbers are allocated.
- Public mutations are rate limited by a salted hash of the request IP; raw IP addresses are not stored.

## Scope

The one-project Vercel deployment provides logically separate signed Operator A/B identities in one reviewer surface. It is **not** evidence of independently administered operators. Use the original operator app on separate hosts/databases/FNNs for that funding/testnet proof.
