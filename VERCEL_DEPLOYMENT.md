# EventMesh v0.4.2 — zero-database Vercel preview

The reviewer demo remains a **single Vercel project**: Vite UI + same-origin serverless API + signed EventMesh evidence. No Postgres, Neon, Vercel Blob, Redis, or other external state service is required.

## Storage model

The preview keeps the existing JSON-file model:

- local development: `.data/eventmesh-demo-state.json`;
- Vercel Functions: `/tmp/eventmesh-demo-state.json`.

Vercel `/tmp` is **ephemeral and instance-local**. A cold start can reset the file, and two function instances can observe different files. The UI and exported evidence now state this directly. This deployment mode is intended for a reviewer/demo experience, not production durability.

## Fastest deployment

Import the repository into Vercel and deploy it. **No environment variable is required for the core signed reference flow.**

The zero-config preview uses deterministic, public **demo-only** signing identities. They are intentionally not secret and must never control funds or production authority.

You can also deploy from the repository:

```bash
chmod +x scripts/deploy-vercel-testnet.sh
./scripts/deploy-vercel-testnet.sh
```

The script can run without `.env.local`. If you want deployment-specific signer identities or optional integrations, run:

```bash
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

## Optional environment

```dotenv
# Optional but recommended for a public reviewer deployment.
DEMO_MASTER_SECRET="<random 64 hex characters>"

DEMO_RATE_LIMIT_PER_MINUTE=60
DEMO_STATE_MAX_BYTES=4194304
CKB_RPC_URL="https://testnet.ckbapp.dev/"
DEMO_ALLOW_CKB_BROADCAST=false
```

Optional real integration variables:

```dotenv
OPERATOR_A_PRIVATE_KEY="0x..."
OPERATOR_B_PRIVATE_KEY="0x..."
CKB_PRIVATE_KEY="0x..."
CKB_ANCHOR_CAPACITY_CKB=220
FIBER_RECEIVER_RPC_URL="https://your-receiver-fnn.example/rpc"
FIBER_RECEIVER_RPC_TOKEN="..."
```

## What works with zero configuration

- create a dual-signed session;
- append hash-linked bilateral events;
- generate explicit signed acknowledgements;
- run the complete reference service flow in one click;
- dual-sign the final state;
- verify the session/event/ACK/close signatures and transcript roots;
- export the complete evidence JSON;
- resume the last session from the same browser while the Vercel instance still has it.

Fiber payment verification remains fail-closed until a receiver Fiber RPC is configured. CKB broadcasting remains off unless both `CKB_PRIVATE_KEY` and `DEMO_ALLOW_CKB_BROADCAST=true` are explicitly configured.

## Diagnostics

- `/api/health` — lightweight preview readiness;
- `/api/health?deep=1` — JSON-file writability, CKB RPC reachability and optional Fiber RPC check;
- `/api/demo` — signer mode, storage mode, capabilities and operator identities;
- `node scripts/verify-deployment.mjs https://your-deployment.vercel.app` — runs the full reference flow and verifies its signed evidence.

Expected storage status on Vercel:

```json
{
  "mode": "ephemeral-json",
  "durable": false,
  "writable": true
}
```

That is intentional for this preview build.

## Security boundary

The built-in zero-config identities are public demo identities. Supplying `DEMO_MASTER_SECRET` derives deployment-specific demo identities instead. Explicit operator private keys remain server-side when supplied.

CKB funds are a separate boundary: the preview does not derive or expose `CKB_PRIVATE_KEY`, and broadcasting is disabled by default. Do not fund the public demo identities and do not describe `/tmp` state as durable storage.
