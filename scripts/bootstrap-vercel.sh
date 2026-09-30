#!/usr/bin/env bash
set -euo pipefail
cat <<'MSG'
EventMesh v0.6 — one-project, database-free Vercel deployment

Demo workspace
1. Push this repository to GitHub.
2. Import it as ONE Vercel Project (repository root).
3. Add DEMO_MASTER_SECRET (generate with: openssl rand -hex 32).
4. Deploy. Demo mode needs no Postgres, Neon, Blob, or SQLite service.

Optional Real / Testnet workspace
1. Set EVENTMESH_TESTNET_MODE=true.
2. Set a separate 32+ char EVENTMESH_TESTNET_ACCESS_KEY.
3. Set OPERATOR_A_PRIVATE_KEY and OPERATOR_B_PRIVATE_KEY to dedicated Testnet keys.
4. Optionally configure FIBER_RECEIVER_RPC_URL / FIBER_RECEIVER_RPC_TOKEN.
5. CKB reads use Testnet by default. Broadcasting additionally requires
   CKB_PRIVATE_KEY and TESTNET_ALLOW_CKB_BROADCAST=true.
6. Set EVENTMESH_PUBLIC_ORIGIN to the final HTTPS origin to pin mutation origin checks.

The browser never persists the Testnet access key. The Demo snapshot uses Local
Storage; Testnet snapshots use Session Storage. No VITE_* secret variables are needed.
MSG
