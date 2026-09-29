# Funding Readiness Checklist

This file separates **implemented code** from **evidence that still has to be produced in the real world**. Do not describe an unchecked evidence item as already completed in a grant application.

## A. Repository readiness

- [x] MIT license present.
- [x] Direct dependency versions pinned.
- [x] Node major/minor runtime pinned in Docker/CI (`22.16.0`).
- [x] `.env.example` contains the documented runtime variables without secrets.
- [x] `.gitignore` / `.dockerignore` exclude keys, local DBs, logs, and private evidence.
- [x] CI workflow runs typecheck, tests, and builds.
- [x] Local two-operator smoke script.
- [x] Machine-readable session evidence summary.
- [x] Standalone transcript/Fiber/CKB verifier.
- [x] Reference adapter with transcript-level semantic validation.
- [ ] Commit a generated `package-lock.json` from a networked Node 22/npm 10 environment, then switch CI/Docker to `npm ci` for full transitive reproducibility.

## B. Product positioning

- [x] Pain statement leads with payment/application state mismatch rather than generic "signed events".
- [x] Explicit boundaries against Fiber, Clasp, FiberLatch Access, and Myelin.
- [x] No claim that the market is already proven.
- [x] External integration moved inside the funded validation milestone.
- [x] Failure/recovery proof is a primary deliverable, not a later idea.
- [x] User validation has explicit interview and kill criteria.
- [ ] Resolve the public naming collision with Apache EventMesh before broad launch.

## C. Funding submission inputs still required from the applicant

- [ ] Applicant/team name as it should appear publicly.
- [ ] GitHub identity used for Spark verification.
- [ ] Discord handle.
- [ ] Email contact.
- [ ] Final public repository URL.
- [ ] Optional live demo URL/video URL.
- [ ] Exact 4-week start window.

Do not invent these fields in the proposal.

## D. Independent integration evidence

- [ ] Choose one independently maintained CKB/Fiber application/service.
- [ ] Obtain maintainer agreement to integrate/test.
- [ ] Define only 3–5 application event types.
- [ ] Publish the external repository + exact commit/PR.
- [ ] Measure integration size and setup steps.
- [ ] Record maintainer feedback after the failure test.

Acceptance rule: an EventMesh-owned example does **not** satisfy this section.

## E. Two-host/Fiber proof

- [ ] Operator A and B run on separate hosts or independently administered environments.
- [ ] Different EventMesh private keys.
- [ ] Different SQLite databases/volumes.
- [ ] Different FNN nodes/credentials.
- [ ] Real Fiber Testnet invoice created by receiver B.
- [ ] Real payment sent by A.
- [ ] Receiver B reports `Paid` from its own FNN.
- [ ] `PAYMENT_SETTLED` claim binds hash/session/amount/currency (+ UDT script if used).
- [ ] Sender-side success is not used as the acceptance authority.

## F. Failure/recovery proof

Required primary scenario:

- [ ] Fiber payment reaches receiver.
- [ ] Receiver application/operator process is stopped before application settlement ACK completes.
- [ ] Receiver restarts using the same durable store.
- [ ] Settlement is re-attempted.
- [ ] Receiver re-verifies its own FNN state.
- [ ] Exactly one payment-linked transition is accepted.
- [ ] No manual database edit.

Also publish:

- [ ] duplicate event delivery result;
- [ ] duplicate ACK result;
- [ ] payment-hash reuse rejection;
- [ ] conflicting ACK/equivocation retention;
- [ ] false/uncommitted CKB anchor rejection.

## G. CKB proof

- [ ] Dual-signed close exists.
- [ ] `EVENTMESH_V02` bytes derived from the close.
- [ ] A broadcasts the Testnet anchor.
- [ ] Anchor is first recorded PENDING if not yet committed.
- [ ] A reconciles to COMMITTED.
- [ ] B independently queries CKB RPC and verifies exact output data.
- [ ] Publish transaction hash and explorer link in final report.

## H. Reproducible reviewer package

Create `artifacts/funding-evidence/` (do not commit private secrets) containing:

```text
manifest.json
transcript.json
commands.md
failure-log.md
integration.md
interviews.md
```

Start `manifest.json` from `docs/evidence/manifest.example.json`.

Run:

```bash
npm run evidence:check -- artifacts/funding-evidence/manifest.json
npm run verify -- artifacts/funding-evidence/transcript.json \
  --adapter paid-service-reference \
  --receiver-fiber-rpc <INDEPENDENT_RECEIVER_FNN> \
  --ckb-rpc <CKB_TESTNET_RPC> \
  --require-close --require-fiber --require-ckb
```

Final acceptance target:

```text
Funding evidence package: STRUCTURE PASS
RESULT: VERIFIED
```

## I. Grant-closure report should answer

1. Did a real external builder have the stated problem?
2. What exact failure was reproduced?
3. What did EventMesh change about recovery/ambiguity?
4. What did it *not* solve?
5. Was the CKB checkpoint useful beyond the dual-signed transcript?
6. How much integration code was required?
7. What should be built next—or explicitly not built—based on evidence?

## J. Closure manifest guardrails

- [x] evidence manifest requires an external integration repository/commit/maintainer;
- [x] requires receiver restart, zero manual DB edits, and exactly one business transition;
- [x] requires at least 3 validation interviews and a written conclusion;
- [x] transcript must contain the declared accepted Fiber payment, a dual-signed close, and a COMMITTED CKB anchor;
- [ ] replace template/self-reported fields with public evidence links before grant closure.
