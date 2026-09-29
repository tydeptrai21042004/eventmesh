# Apply the EventMesh funding-readiness patch

**Exact baseline:** `eventmesh-main(5).zip`  
**Patch format:** changed/new files only; no deletions.

1. Extract `eventmesh-main(5).zip`.
2. Extract the changed-files patch **into the repository root** and allow the listed files to overwrite.
3. Review `PATCH_NOTES.md`, `docs/FUNDING_PROPOSAL_DRAFT.md`, and `docs/FUNDING_READINESS_CHECKLIST.md`.
4. On a networked Node 22.16 / npm 10 environment, run:

```bash
npm install --no-audit --no-fund
npm run verify:all
```

5. For the local two-operator reconciliation proof:

```bash
cp .env.example .env
docker compose up --build
npm run smoke
```

6. For funding-grade evidence, follow `docs/HOW_TO_VERIFY.md` and `docs/INTEGRATION_GUIDE.md`. The local smoke test deliberately does not claim real Fiber or CKB evidence.

> The archive does not include a generated `package-lock.json` because package-registry access was unavailable during artifact creation. Generate and commit the lockfile on a networked Node 22/npm 10 environment before tagging a reproducible release, then switch CI to `npm ci`.
