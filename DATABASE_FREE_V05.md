# EventMesh v0.5 — database-free patch

This patch removes database-engine requirements from both deployment paths.

## Vercel preview

- no `DATABASE_URL`, Neon, Postgres, Blob, or SQLite dependency;
- `/tmp/eventmesh-preview-state.json` is only a bounded disposable cache;
- the browser stores a signed portable session snapshot in `localStorage`;
- every mutation can carry that snapshot back to a fresh serverless instance;
- the API verifies session signatures, event/ACK signatures, the hash chain, close commitment, and configured participant keys before reconstruction;
- conflicting history and shorter-chain rollback are rejected.

## Standalone operators

- `better-sqlite3` is removed;
- each operator writes `eventmesh-state.json` using temp-file + atomic rename;
- conflict evidence, payment claims/evidence, sessions, events, closes, and anchors remain persisted;
- one writer process per state file is the supported model.

## UI features added

- one-click full reference flow;
- automatic browser resume;
- portable evidence import/export;
- server-side evidence verification;
- reconciliation notes;
- chain-tip and transcript-root display;
- clearer Fiber and CKB capability status;
- no generic "Service unavailable" state caused by a missing database.

## Vercel setup

Only one variable is required for stable server-side demo identities:

```bash
DEMO_MASTER_SECRET=<32+ random characters>
```

Generate and deploy with:

```bash
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

CKB Testnet broadcast and Fiber verification remain optional and fail closed unless explicitly configured.
