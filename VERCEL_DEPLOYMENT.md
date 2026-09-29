# EventMesh v0.4.1 — one-project Vercel demo without a database

The reviewer demo is one Vercel project: Vite UI + same-origin serverless API + signed EventMesh state. **No Postgres, Neon, Vercel Blob, or other database is required.**

For this demo build, state is JSON-backed:

- local development: `.data/eventmesh-demo-state.json`;
- Vercel Functions: `/tmp/eventmesh-demo-state.json`.

`/tmp` on Vercel is **ephemeral and instance-local**. It can disappear on a cold start and two concurrent function instances can have different files. This mode is intentionally for a reviewer/demo deployment, not durable production reconciliation.

## Fast path

```bash
chmod +x scripts/generate-env.sh scripts/deploy-vercel-testnet.sh
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

Only `DEMO_MASTER_SECRET` is required for mutation endpoints. The generator creates a random 32-byte secret automatically.

## Minimal environment

```dotenv
DEMO_MASTER_SECRET="<random 64 hex characters>"
DEMO_RATE_LIMIT_PER_MINUTE=60
DEMO_STATE_MAX_BYTES=4194304
CKB_RPC_URL="https://testnet.ckbapp.dev/"
DEMO_ALLOW_CKB_BROADCAST=false
```

Optional server-side variables:

```dotenv
OPERATOR_A_PRIVATE_KEY="0x..."
OPERATOR_B_PRIVATE_KEY="0x..."
CKB_PRIVATE_KEY="0x..."
CKB_ANCHOR_CAPACITY_CKB=220
FIBER_RECEIVER_RPC_URL="https://your-receiver-fnn.example/rpc"
FIBER_RECEIVER_RPC_TOKEN="..."
```

## Security defaults

- Requests that mutate demo state require `application/json`.
- Browser mutation requests are restricted to the same origin.
- Request bodies are limited to 64 KiB.
- JSON state writes use a temporary file + atomic rename and restrictive file permissions.
- A per-instance minute rate limit is applied.
- Idempotency keys are persisted in the JSON state and conflicting reuse is rejected.
- Missing `DEMO_MASTER_SECRET` disables public mutation endpoints; secrets shorter than 32 characters are rejected.
- Operator signing keys remain server-side. If explicit operator keys are not supplied, deterministic demo keys are derived from `DEMO_MASTER_SECRET`.
- CKB broadcasting is **off by default**. Supplying `CKB_PRIVATE_KEY` alone is not sufficient; `DEMO_ALLOW_CKB_BROADCAST=true` must also be set explicitly.
- `PAYMENT_SETTLED` remains fail-closed until a receiver Fiber RPC is configured and verifies the payment claim.

## Diagnostics

- `/api/health` — configuration-only health.
- `/api/health?deep=1` — checks JSON storage writability, CKB Testnet RPC, and the optional Fiber receiver RPC.
- `/api/demo` — reports runtime/storage readiness and recent demo sessions.
- `node scripts/verify-deployment.mjs https://your-deployment.vercel.app` — creates, appends to, and closes a signed smoke-test session.

## Important limitation

This JSON mode deliberately trades durability for zero infrastructure. Do not describe it as durable storage on Vercel. For production, replace `api/demo-store.ts` with a durable store that provides multi-instance concurrency control while keeping the signing/protocol layer unchanged.
