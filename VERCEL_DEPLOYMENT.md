# EventMesh on Vercel — one project, no database

EventMesh v0.5 deploys the Vite frontend and `/api/*` functions as one Vercel project **without Postgres, Neon, Blob, SQLite, or another database service**.

The preview uses two layers of state:

1. a bounded `/tmp/eventmesh-preview-state.json` cache inside the current serverless instance; and
2. a portable signed snapshot stored in the browser and attached to later mutations.

If Vercel starts a fresh instance, the API verifies the session signatures, event/ACK signatures, hash chain, close commitment, and participant identities before reconstructing the disposable cache. The server therefore does not treat client JSON as trusted state.

> This is a preview/reviewer deployment model. It is not a substitute for durable multi-party production storage. The standalone operator service uses an atomic JSON file on its persistent host.

## 1. Required variable

```bash
DEMO_MASTER_SECRET=<at least 32 characters; preferably 32 random bytes as hex>
```

The secret keeps the two demo signing identities stable across Vercel instances. Operator private keys are derived server-side when explicit operator keys are not supplied; they are never sent to the browser.

## 2. Optional CKB Testnet / Fiber variables

```bash
CKB_RPC_URL=https://testnet.ckbapp.dev/
CKB_PRIVATE_KEY=
DEMO_ALLOW_CKB_BROADCAST=false
CKB_ANCHOR_CAPACITY_CKB=220

FIBER_RECEIVER_RPC_URL=
FIBER_RECEIVER_RPC_TOKEN=
```

`PAYMENT_SETTLED` remains fail-closed unless the receiver-side Fiber RPC independently verifies the claim. CKB broadcast remains disabled unless `DEMO_ALLOW_CKB_BROADCAST=true` and a Testnet-only key is configured.

## 3. Local setup

```bash
chmod +x scripts/generate-env.sh scripts/deploy-vercel-testnet.sh
./scripts/generate-env.sh
npm install
npm run check
```

Local development writes `.data/eventmesh-demo-state.json`. The standalone operator writes `eventmesh-state.json` inside its configured data directory.

## 4. Deploy

```bash
./scripts/deploy-vercel-testnet.sh
```

The script runs checks, pushes the non-database environment variables, deploys, probes deep health, then performs a signed create → event → portable verification → close → final verification flow.

## 5. Health checks

- `GET /api/health` — lightweight signing-service readiness.
- `GET /api/health?deep=1` — preview-cache write check plus CKB/Fiber connectivity diagnostics.
- `GET /api/demo` — protocol, identities, capabilities, and storage mode.

Expected preview storage metadata:

```json
{
  "storage": {
    "mode": "ephemeral-preview",
    "durable": false,
    "portableRecovery": true
  }
}
```

A `durable: false` value is intentional. The UI says "Database-free preview" rather than claiming server-side durability.

## 6. New preview features

- automatic browser resume after refresh;
- signed snapshot reconstruction after Vercel cold starts;
- one-click full reference flow;
- server-side evidence verification;
- JSON import/export;
- reconciliation notes;
- transcript-root and chain-tip display;
- optional Fiber verification;
- optional CKB Testnet checkpointing/reconciliation.

## 7. Security boundary

The portable snapshot is **not trusted merely because it came from localStorage or an imported JSON file**. Before restoration the API verifies the bilateral signed session and full event chain with `verifyTranscript`, checks that both participant public keys are the configured preview identities, rejects conflicting history, and prevents a warm cache from being rolled back to a shorter chain.

The public preview is still intentionally unauthenticated at the end-user layer. Same-origin checks and rate limits are abuse controls, not application identity. Do not use production funds or production signing keys.
