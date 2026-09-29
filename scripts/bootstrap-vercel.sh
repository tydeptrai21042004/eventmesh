#!/usr/bin/env bash
set -euo pipefail
cat <<'MSG'
EventMesh one-project Vercel deployment

1. Push this repository to GitHub.
2. Import the repository as ONE Vercel Project (root directory = repository root).
3. Attach a Postgres database from Vercel Marketplace.
4. Add DEMO_MASTER_SECRET (generate: openssl rand -hex 32).
5. Optional real integrations:
   FIBER_RECEIVER_RPC_URL / FIBER_RECEIVER_RPC_TOKEN
   CKB_PRIVATE_KEY / CKB_RPC_URL
6. Deploy. Vercel uses vercel.json automatically.

No VITE_ADMIN_TOKEN, VITE_OPERATOR_A_URL, or VITE_OPERATOR_B_URL is needed.
MSG
