# EventMesh v0.6 — one-project Vercel deployment

EventMesh deploys the Vite frontend plus `/api/demo` and `/api/health` as one Vercel project **without Postgres, Neon, Blob, SQLite, or another database service**.

## Workspace 1 — Demo

Required environment variable:

```env
DEMO_MASTER_SECRET=<32+ random characters>
```

Recommended:

```env
DEMO_RATE_LIMIT_PER_MINUTE=60
DEMO_STATE_MAX_BYTES=4194304
EVENTMESH_PUBLIC_ORIGIN=https://your-app.vercel.app
```

Demo uses deterministic server-side preview identities. The browser stores the signed portable snapshot in Local Storage so a refresh can resume the walkthrough. The one-click reference flow is available only here. CKB broadcasting is rejected from Demo.

## Workspace 2 — Real / Testnet

The connected workspace is **off by default**. Enable it only with dedicated Testnet credentials:

```env
EVENTMESH_TESTNET_MODE=true
EVENTMESH_TESTNET_ACCESS_KEY=<separate 32+ random characters>
TESTNET_RATE_LIMIT_PER_MINUTE=30
OPERATOR_A_PRIVATE_KEY=0x...
OPERATOR_B_PRIVATE_KEY=0x...
```

The browser asks for the access key and keeps it in React memory only. It is sent in the `x-eventmesh-access-key` request header and is not written to Local Storage or Session Storage. The Testnet signed snapshot itself uses Session Storage.

### CKB Testnet

Read-only RPC access uses the public Testnet endpoint by default:

```env
CKB_RPC_URL=https://testnet.ckbapp.dev/
```

Broadcasting stays off unless both are set:

```env
CKB_PRIVATE_KEY=0x...
TESTNET_ALLOW_CKB_BROADCAST=true
```

Before broadcasting, EventMesh persists the deterministic transaction hash/commitment identity in its cache. Ambiguous submission states must be reconciled by transaction hash rather than blindly retried.

### Fiber

Optional receiver-side verification:

```env
FIBER_RECEIVER_RPC_URL=https://receiver-fnn.example
FIBER_RECEIVER_RPC_TOKEN=<optional bearer token>
```

`PAYMENT_SETTLED` remains fail-closed unless the receiver-side Fiber RPC independently proves the matching paid invoice.

## Deploy

```bash
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

or import the repository into Vercel and set the same variables manually. `vercel.json` already points at the one-project Vite build and the two API functions.

## Database-free recovery model

`/tmp/eventmesh-preview-state.json` is only a bounded disposable cache. On a cold start, later requests carry the browser's signed snapshot. The API verifies the session signatures, event hashes, previous-hash links, ACKs, final commitment, and configured operator identities before reconstructing cache state.

Mutations also carry an expected event count and expected chain tip. A stale browser state receives HTTP `409` / `STATE_PRECONDITION_FAILED` rather than silently extending a different chain. The UI offers **Sync now** and a same-browser edit lease to reduce accidental forks.

## Important serverless limitation

Without a shared durable coordination service, two different clients can still submit competing next events from the exact same valid snapshot to different cold Vercel instances. Both descendants can be cryptographically valid. This is detectable as a fork, but cannot be globally serialized without shared coordination.

Therefore **Real / Testnet is a controlled Testnet surface, not production custody infrastructure**. For production-grade bilateral independence, run separate operator services and durable operator-owned storage or another consensus/coordination layer.

## Diagnostics

- `GET /api/health` — fast app readiness.
- `GET /api/health?deep=1` — writable cache, CKB RPC, Fiber RPC, Testnet workspace and broadcaster readiness.
- UI → **Real / Testnet** → **Deployment readiness** — operator-facing summary.
- UI → **Verify current evidence** — re-runs transcript verification.
- UI → **Export JSON** — portable verification artifact with a v2 export manifest.
