# EventMesh v0.2 Funding-Readiness Patch Notes

**Baseline:** `eventmesh-main(5).zip`  
**Patch type:** changed/new files only; no deletions.  
**Product direction:** cross-operator **reconciliation**, not another wallet/payment router/runtime/event bus.

## What this patch changes

### 1. Makes the pain visible

The first-screen story is now the concrete partial-failure problem:

```text
Fiber payment = Paid
+ application response/process failure
+ independent operator databases
= uncertain business state
```

The repository positions EventMesh as the narrow layer that records which exact application events both operators accepted, binds receiver-verified Fiber value when relevant, and checkpoints the final proof to CKB.

### 2. Replaces the generic demo with a guided paid-service reconciliation flow

The demo now walks through:

```text
SERVICE_REQUESTED
→ SERVICE_ACCEPTED
→ RESULT_COMMITTED
→ Fiber invoice/payment
→ PAYMENT_SETTLED
→ SESSION_COMPLETED
→ dual-signed close
→ optional CKB anchor
```

It exposes a reviewer-oriented evidence panel and safe replay/retry checks. The funding-grade restart/lost-response scenario is explicitly documented.

### 3. Adds a real application boundary instead of putting business logic in core

`@eventmesh/adapter-sdk` now includes a small paid-service reference adapter with event-level and transcript-level invariants plus deterministic final-state derivation. The standalone verifier can run it with `--adapter paid-service-reference` and compare the close `finalState` with the adapter-derived state.

### 4. Makes funding evidence machine-checkable

New `scripts/evidence-check.mjs` + `docs/evidence/manifest.example.json` require the closure package to identify:

- two different operator origins;
- accepted Fiber payment hash;
- committed CKB transaction;
- dual-signed transcript;
- external integration repository/commit/maintainer;
- receiver restart;
- zero manual DB edits;
- exactly one business transition;
- at least three validation interviews and an evidence-based conclusion.

### 5. Adds a machine-readable evidence summary

`GET /admin/sessions/:id/evidence-summary` exposes session/event/payment/conflict/close/CKB readiness without pretending that one operator's summary replaces independent verification.

### 6. Fixes reproducibility and deployment gaps

Added:

- `.env.example`;
- `.gitignore`;
- `.dockerignore`;
- Node 22.16-pinned Docker images;
- CI workflow;
- funding/adopter verification docs.

The Docker topology now gives Operator B CKB RPC read access even though only A is configured to broadcast, allowing B to independently verify a received anchor.

### 7. Makes overlap boundaries explicit

Funding docs now keep EventMesh out of Fiber routing/payment lifecycle, Clasp-style wallet permissions, FiberLatch access receipts, Myelin-style execution/finality/disputes, escrow, marketplaces, consensus, and generic event-bus scope.

### 8. Adds falsifiable market validation

The proposal no longer claims a proven large market. It asks whether one independently maintained CKB/Fiber application can integrate a 3–5 event adapter and recover a real payment/application partial failure with no shared DB/manual edit, then publish reproducible Fiber/CKB evidence. Continue/narrow/stop criteria are documented.

## Important release limitation

A dependency-backed `npm run verify:all` could not be executed in the artifact environment because the uploaded baseline has no lockfile/cache and registry installation timed out. TypeScript/TSX syntax transpilation, JavaScript syntax, JSON/YAML parsing, evidence-check self-test, archive integrity, and clean-baseline patch reconstruction are performed before packaging. Run the full dependency-backed suite on a networked machine before publishing Testnet evidence.

## Branding note

Apache EventMesh is an established unrelated project. The repository now treats “EventMesh” as a working project name and recommends a distinctive public rebrand before wider distribution; protocol/domain strings stay stable for the v0.2 Testnet reference implementation.
