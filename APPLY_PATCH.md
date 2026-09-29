# Apply EventMesh v0.2 ecosystem merge patch

This patch is relative to the uploaded `eventmesh-main (1)(1).zip` baseline.

1. Extract the changed-files ZIP into the **repository root** and allow files to overwrite existing paths.
2. Review `CHANGELOG_FUNDING_PATCH.md` and `docs/ECOSYSTEM_POSITIONING.md`.
3. With Node 22 and network access, run:

```bash
npm install --no-audit --no-fund
npm run verify:all
```

4. For the local two-operator protocol proof:

```bash
cp .env.example .env
docker compose up --build
node scripts/smoke.mjs
```

The local smoke proof does not claim real Fiber or CKB Testnet evidence. Follow `docs/HOW_TO_VERIFY.md` for the independent Fiber/CKB proof.
