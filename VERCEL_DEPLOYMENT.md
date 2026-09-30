# EventMesh on Vercel — one project, durable state

EventMesh still deploys as one Vercel project: the Vite demo frontend and `/api/*` functions are built together. The production-oriented path now uses Postgres/Neon through `DATABASE_URL`; no separate migration command or database service process is required.

## 1. Required production variables

```bash
DATABASE_URL=postgresql://...
DEMO_MASTER_SECRET=<at least 32 characters; preferably 32 random bytes as hex>
```

The easiest Vercel setup is to connect a Neon/Postgres integration so `DATABASE_URL` is injected into the project. You can also add a connection string manually.

On first access EventMesh automatically creates only its namespaced tables:

- `eventmesh_schema_migrations`
- `eventmesh_demo_state`

The state table stores the compact demo ledger as JSONB with a monotonically increasing revision. Mutations use optimistic compare-and-swap updates so concurrent serverless invocations cannot silently overwrite a newer revision.

To inspect initialization:

```sql
SELECT version, name, applied_at
FROM eventmesh_schema_migrations
ORDER BY version;
```

No manual SQL bootstrap is required.

## 2. Optional Testnet/Fiber variables

```bash
CKB_RPC_URL=https://testnet.ckbapp.dev/
CKB_PRIVATE_KEY=
DEMO_ALLOW_CKB_BROADCAST=false
CKB_ANCHOR_CAPACITY_CKB=220

FIBER_RECEIVER_RPC_URL=
FIBER_RECEIVER_RPC_TOKEN=
```

`PAYMENT_SETTLED` remains fail-closed unless the receiver-side Fiber RPC is configured and verifies the payment claim. CKB broadcasting remains disabled unless `DEMO_ALLOW_CKB_BROADCAST=true` and a Testnet key is present.

## 3. Local setup

```bash
./scripts/generate-env.sh
npm install
npm run check
```

Local development can still run without `DATABASE_URL`; it uses `.data/eventmesh-demo-state.json` in a single process. This keeps local setup simple while avoiding a false durability claim on Vercel.

## 4. One-command Vercel deployment

```bash
./scripts/deploy-vercel-testnet.sh
```

The script runs the full checks, links the Vercel project, pushes any variables present in `.env.local`, deploys, then calls the live deep-health endpoint and performs a signed create → append → close smoke flow.

If a Neon integration already supplies `DATABASE_URL`, you may leave it empty in `.env.local`; the integration-provided variable remains available to the deployed project.

## 5. Health checks

- `GET /api/health` — inexpensive readiness status.
- `GET /api/health?deep=1` — initializes/checks Postgres, probes CKB RPC, and optionally probes Fiber.
- `GET /api/demo` — protocol/capability metadata including storage mode and durability.

For a normal production Vercel deployment, deep health should report:

```json
{
  "storage": {
    "mode": "postgres-jsonb",
    "durable": true,
    "writable": true,
    "schemaVersion": 1
  }
}
```

## 6. Explicit throwaway preview mode

Vercel `/tmp` is ephemeral and instance-local. EventMesh therefore refuses it by default. For a disposable preview only, you can explicitly set:

```bash
ALLOW_EPHEMERAL_VERCEL_STATE=true
```

Do not use that mode as evidence of durable reconciliation.
