# Vercel v0.3 patch manifest

## New
- `api/demo.ts` — same-origin serverless demo API, Postgres state, two server-only signing identities, request idempotency, rate limiting, atomic payment settlement, fail-closed Fiber verification, durable CKB broadcast state.
- `vercel.json` — one-project Vercel build/function configuration.
- `.env.example` — minimal deployment environment.
- `.gitignore`, `.dockerignore`, `.github/workflows/ci.yml` — missing release hygiene files restored.
- `scripts/bootstrap-vercel.sh` — deployment instructions.
- `VERCEL_DEPLOYMENT.md` — operational notes and scope boundary.

## Changed
- `apps/demo/src/main.tsx` — same-origin `/api/demo`, no browser admin token, guided idempotent flow.
- `apps/demo/src/style.css` — simplified deployment/reconciliation UI.
- `apps/operator/src/store.ts` — repeated receiver verification no longer conflicts only because `verifiedAt` changed.
- `package.json` — Postgres dependency and Vercel demo build scripts.
- `README.md` — one-project Vercel deployment path.

## Important behavior
- `PAYMENT_SETTLED` fails closed without `FIBER_RECEIVER_RPC_URL`.
- Payment claim + receiver evidence + ACK are one Postgres transaction in the Vercel path.
- Evidence identity excludes observation time; retries update last observation instead of creating false equivocation.
- CKB exceptions after entering broadcast state become `BROADCAST_UNKNOWN`; automatic blind rebroadcast is blocked.
- The single Vercel project is a reviewer/demo surface with logically separate signing identities. Independent-operator evidence should still use separately administered deployments/FNNs/databases.
