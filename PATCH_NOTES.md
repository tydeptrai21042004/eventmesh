# EventMesh CKB/Fiber hardening patch — 2026-10-01

This package contains the concrete code changes derived from the CKB ecosystem/protocol review. It intentionally keeps the existing EventMesh architecture and demo surface while hardening the proof semantics.

## Highest-priority changes implemented

1. **Commitment v3 while keeping legacy v0.2 proofs readable**
   - New profiled sessions produce `commitmentVersion: 3` closes.
   - Legacy `EVENTMESH_V02` commitments remain verifiable.
   - New CKB commitments use `EVENTMESH_V03` and bind the signed receiver-observation root, application-profile hash and chain-context hash.

2. **Receiver-owned Fiber evidence is no longer detachable metadata**
   - `PAYMENT_SETTLED` ACCEPT ACKs bind the exact receiver observation through `evidenceHash`.
   - `paymentObservationRoot` Merkle-commits the complete signed Fiber observations.
   - Commitment-v3 verification fails if payment evidence is removed, substituted, signed by the wrong operator, or detached from its ACK.

3. **Application semantics are signed and deterministic**
   - Sessions can sign `{ id, version, rulesHash }` as an application profile.
   - Built-in profiles: `generic-bilateral` and `paid-service`.
   - Both operators independently derive the final state before signing a profiled close; caller-supplied JSON is not authoritative.
   - The standalone verifier repeats the same derivation.

4. **Paid-service profile is strengthened**
   - Required author roles: A requests/pays; B accepts/commits result/completes.
   - Required order: `SERVICE_REQUESTED -> SERVICE_ACCEPTED -> RESULT_COMMITTED -> [PAYMENT_SETTLED] -> SESSION_COMPLETED`.
   - A payment, when present, is bound to the exact `requestId`, exact `RESULT_COMMITTED.eventHash`, and canonical `purposeHash`.
   - The receiver still verifies payment through its own FNN before ACKing.

5. **Signed chain context**
   - Sessions can bind CKB/Fiber network context into the signed evidence.
   - Commitment v3 signs the chain-context hash into the close and CKB anchor bytes.

6. **CKB anchor adapter understands v3 commitments**
   - V3 anchor data is 237 bytes.
   - Standard secp minimum output capacity is therefore 298 CKB under the repository's capacity model; the adapter raises capacity automatically when needed.

7. **Bounded public peer rate-limit state**
   - The in-memory peer rate limiter now has a maximum tracked-peer bound and evicts expired/old buckets instead of allowing an unbounded IP-key map.

8. **Regression tests added/expanded**
   - Stripping signed Fiber evidence from a v3 transcript must fail.
   - Removing the payment ACK `evidenceHash` must fail.
   - Paid-service payment-to-result binding is checked.
   - Wrong bilateral event authorship is rejected.
   - Operator A caller JSON cannot override deterministic paid-service final state.
   - V3 CKB commitment size/minimum capacity is checked.

## Changed files

- `README.md`
- `api/demo.ts`
- `apps/demo/src/main.tsx`
- `apps/operator/package.json`
- `apps/operator/src/app.ts`
- `apps/verifier/src/index.ts`
- `docs/HOW_TO_VERIFY.md`
- `docs/PRODUCTION_READINESS.md`
- `docs/PROTOCOL.md`
- `packages/adapter-sdk/src/index.ts`
- `packages/adapter-sdk/src/paid-service.ts`
- `packages/ckb/src/index.ts`
- `packages/core/src/index.ts`
- `tests/adapter.test.ts`
- `tests/ckb.test.ts`
- `tests/core.test.ts`
- `tests/operator.integration.test.ts`

## Applying the patch

From the root of the original repository:

```bash
patch -p1 < EventMesh_CKB_Hardening.patch
```

Alternatively, copy/unzip the changed files from this bundle over the same relative paths.

## Verification performed here

- All modified `.ts` / `.tsx` files were parsed/transpiled with the installed TypeScript compiler with **no syntax diagnostics**.
- `apps/operator/package.json` parses as valid JSON.
- The unified diff has no whitespace errors.
- The patch was dry-run against the pristine uploaded tree before packaging.

### Important test limitation

The uploaded archive did not contain installed dependencies or a lockfile. Dependency installation did not complete in this execution environment, so I did **not** label the Vitest suite as executed/passing. The patch includes the regression tests, but run the repository's normal check after dependency installation:

```bash
npm install
npm run check
```

For a reproducible release, commit the generated `package-lock.json` and use `npm ci` in CI after that.

## Intentionally not included in this patch

These are valuable follow-up items, but they are larger architectural P1/P2 changes and were intentionally kept out of this protocol-hardening patch to avoid destabilizing the existing system:

- per-session actor/mutex serialization;
- append-only journal + compacted snapshot store;
- persistence of the fully serialized signed CKB transaction for exact post-crash rebroadcast;
- external signer/KMS interface;
- batch/Merkle or rolling CKB anchor;
- CellFlow-backed anchor transaction lifecycle;
- mTLS / signed HTTP peer-channel authentication.

The next implementation milestone should be those operational hardening items only after this protocol layer passes the full repository test suite.
