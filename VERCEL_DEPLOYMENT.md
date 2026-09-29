# EventMesh v0.4 — Vercel + Neon + CKB Testnet

The reviewer demo is one Vercel project: Vite UI + same-origin serverless API + Neon/Postgres durable state. Operator signing keys stay server-side.

## Fast path

```bash
chmod +x scripts/generate-env.sh scripts/deploy-vercel-testnet.sh
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

The deploy script:

1. installs dependencies;
2. compiles all internal runtime packages to JavaScript;
3. runs typecheck, tests, and the Vite build;
4. links/creates the Vercel project;
5. uploads required environment variables;
6. deploys to Vercel;
7. calls `/api/health?deep=1`;
8. creates, appends to, and closes a real signed EventMesh smoke-test session through the deployed API.

You still need to authenticate the Vercel CLI and provide a real Neon connection string. CKB anchoring additionally needs a funded **CKB Testnet** private key.

## Required environment

```dotenv
DATABASE_URL="postgresql://...-pooler....neon.tech/neondb?sslmode=require"
DEMO_MASTER_SECRET="64-or-more-random-hex-characters"
```

Use the Neon pooled/serverless URL. `DEMO_MASTER_SECRET` is required for public mutation endpoints; the API no longer silently accepts the built-in local-development secret on Vercel.

## CKB Testnet

```dotenv
CKB_RPC_URL="https://testnet.ckbapp.dev/"
CKB_PRIVATE_KEY="0x..."
CKB_ANCHOR_CAPACITY_CKB="220"
```

`CKB_RPC_URL` is optional because v0.4 defaults reads/reconciliation to the public Testnet RPC above. Broadcasting is disabled until `CKB_PRIVATE_KEY` is configured. Use a Testnet-only key and fund it from a Testnet faucet; never reuse a Mainnet key.

Anchor broadcast is deliberately conservative. EventMesh writes `BROADCASTING` before network submission. If a response is ambiguous, it changes to `BROADCAST_UNKNOWN` and does not blindly rebroadcast. If the transaction hash was already obtained, v0.4 preserves it so `reconcile_anchor` can inspect the chain before any retry.

## Fiber receiver verification

```dotenv
FIBER_RECEIVER_RPC_URL="https://your-receiver-fnn.example/rpc"
FIBER_RECEIVER_RPC_TOKEN="..."
```

A native FNN is stateful, maintains channel data, and expects long-lived networking. Do not treat a Vercel Function as the FNN host. Point EventMesh at a receiver-owned FNN running on a suitable persistent host, or use a separate browser/WASM Fiber experiment. `PAYMENT_SETTLED` remains fail-closed until the configured receiver RPC is reachable and reports a matching paid invoice bound to the EventMesh session.

## Diagnostics

- `/api/health` — configuration-only health.
- `/api/health?deep=1` — probes Neon, the CKB Testnet RPC, and the configured Fiber receiver RPC using `node_info`.
- `/api/demo` — returns EventMesh runtime readiness even when the database is missing/unreachable instead of crashing the whole page.
- `node scripts/verify-deployment.mjs https://your-deployment.vercel.app` — remote signed-session smoke test.

The UI no longer blindly parses every Vercel response as JSON. If Vercel returns a platform text/HTML error, the page reports a useful non-JSON function failure and points you to Function Logs rather than showing `Unexpected token 'A'`.

## Why v0.4 compiles the workspace packages first

The previous deployment path exposed raw TypeScript files as package runtime exports while `vercel-build` only built the Vite frontend. v0.4 builds `@eventmesh/core`, `@eventmesh/fiber`, `@eventmesh/ckb`, and `@eventmesh/adapter-sdk` to `dist/*.js` before Vercel packages the serverless function. This removes dependence on runtime loading of workspace `.ts` files.

## Scope

The single-project Vercel surface contains two distinct signing identities but one deployment/admin boundary. It is a reviewer/demo deployment, not proof of two independently administered operators. For that stronger claim, run the two operator services on separate hosts/databases/FNNs and verify the exported transcript independently.
