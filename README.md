# EventMesh for CKB/Fiber — Cross-Operator Reconciliation Proofs

> **Working project name.** This repository is unrelated to the Apache EventMesh project. Resolve the public-product naming collision before a wider launch; the protocol/domain strings stay `eventmesh-v0.2.0` for this testnet reference implementation.

**Problem:** a Fiber payment can succeed while two independently operated applications still disagree about what business event that payment settled after a timeout, retry, crash, or lost response.

**EventMesh** is a bilateral reconciliation layer for that boundary. Two operators keep separate keys and databases, exchange signed application events, explicitly ACCEPT/REJECT exact event hashes, can bind receiver-verified Fiber payments to those events, dual-sign the final state, and optionally checkpoint one compact proof to CKB.

```text
Fiber answers:      did value move?
EventMesh answers:  what exact application state did both operators accept?
CKB answers:        what proof did they durably checkpoint?
```

EventMesh does **not** replace Fiber, wallets, spending policy, access receipts, application execution, routing/LSPs, escrow, arbitration, marketplaces, or consensus.

## Why this is a CKB/Fiber gap worth validating

The August 2026 CKB/Fiber opportunity map classifies **cross-operator game/device events (CGE)** as a frontier hypothesis: the CKB/Fiber dependency is plausible, but the user/trust model still needs evidence. That is the right maturity level for this project. The funding goal is therefore **not** to claim a proven large market; it is to validate the gap with an independent application, a real Fiber payment, a restart/retry failure, and a reproducible CKB proof.

See:

- `docs/MARKET_GAP_AND_VALIDATION.md` — pain, adopter hypothesis, non-overlap, interview/kill criteria;
- `docs/FUNDING_PROPOSAL_DRAFT.md` — Spark-ready $1,000 validation milestone;
- `docs/FUNDING_READINESS_CHECKLIST.md` — exact evidence still required before submission/closure;
- `docs/ECOSYSTEM_POSITIONING.md` — boundaries against Fiber, Clasp, FiberLatch, Myelin, generic event buses;
- `docs/INTEGRATION_GUIDE.md` — minimal external-adopter integration and failure-test recipe.

## The reference failure

```text
Operator A                         Operator B
    |                                  |
    |------ SERVICE_REQUESTED -------->|
    |<------------ ACCEPT -------------|
    |                                  |
    |<----- RESULT_COMMITTED ----------|
    |------------- ACCEPT ------------>|
    |                                  |
    |========== Fiber payment =========>|
    |                                  |  receiver FNN = Paid
    |                                  X  process crashes
    |                                  |
    |                             restart from SQLite
    |------ PAYMENT_SETTLED ---------->|
    |<-- receiver re-verifies + ACCEPT |
    |                                  |
    +------ same dual-signed close ----+
                       |
                       v
                      CKB
```

No shared database is the source of truth. No sender-side "payment success" assertion is enough to make the receiver accept `PAYMENT_SETTLED`.

## What v0.2 already implements

- distinct secp256k1 operator identities and SQLite/WAL stores;
- domain-separated session/event/ACK/close signatures;
- signed hash-linked events and exact counterparty ACK/REJECT;
- immutable/idempotent evidence plus durable conflict records;
- proposal-collision vs same-sender equivocation distinction;
- globally blocked Fiber payment-hash reuse;
- receiver-owned `get_invoice` verification for `PAYMENT_SETTLED`;
- payment hash + session + amount + currency + optional UDT script binding;
- deterministic `paymentEvidenceRoot` in the dual-signed close;
- `EVENTMESH_V02` CKB commitment and PENDING → COMMITTED reconciliation;
- independent CKB `get_transaction` verification;
- standalone transcript/Fiber/CKB verifier;
- machine-readable `/admin/sessions/:id/evidence-summary`;
- a tiny adapter SDK and paid-service reference adapter;
- a guided demo that exercises the real invoice/payment/receiver-verification path when FNNs are enabled.

## Quick local proof

```bash
cp .env.example .env
npm install --no-audit --no-fund
npm run verify:all
docker compose up --build
npm run smoke
```

Open `http://localhost:3000` for the guided reconciliation demo.

Local smoke mode intentionally omits Fiber/CKB. It proves bilateral session/event/ACK/close behavior and idempotent ACK replay. The funded proof must use separate FNNs and CKB Testnet.

## Guided paid-service demo

The demo no longer starts from arbitrary `WORK_REQUEST` JSON. It presents one concrete integration boundary:

```text
SERVICE_REQUESTED
→ SERVICE_ACCEPTED
→ RESULT_COMMITTED
→ Fiber invoice/payment
→ PAYMENT_SETTLED (receiver FNN verification)
→ SESSION_COMPLETED
→ dual-signed close
→ CKB commitment
```

When Fiber is enabled on both operators, the UI can:

1. create the invoice on receiver B;
2. pay it from sender A;
3. submit the generated EventMesh payment claim;
4. make B query its own FNN before ACKing the settlement event.

The Failure Lab also exposes safe retry/replay checks and the exact manual restart scenario that must be recorded for funding evidence.

## Machine-readable evidence summary

```bash
curl http://localhost:4001/admin/sessions/<SESSION_ID>/evidence-summary
```

It reports:

- bilateral session signatures;
- event/final/ACCEPT counts;
- accepted Fiber claims vs receiver evidence;
- conflict kinds/count;
- dual-signed close status;
- transcript/final/payment roots;
- CKB anchor status;
- reviewer-oriented readiness booleans.

This endpoint is evidence presentation only; the standalone verifier remains the trust-minimized verification path.

## Full independent verification

```bash
npm run verify -- transcript.json \
  --adapter paid-service-reference \
  --receiver-fiber-rpc http://RECEIVER_FNN:8237 \
  --ckb-rpc https://YOUR_CKB_TESTNET_RPC \
  --require-close \
  --require-fiber \
  --require-ckb
```

Expected terminal result:

```text
RESULT: VERIFIED
```

See `docs/HOW_TO_VERIFY.md`.

## Funding evidence package

Start from `docs/evidence/manifest.example.json`, publish the transcript next to it, then run:

```bash
npm run evidence:check -- artifacts/funding-evidence/manifest.json
```

The structural check requires the published session ID, independent operator URLs, accepted Fiber payment hash, committed CKB transaction hash, transcript, external integration reference, and failure-test result to agree with each other. Then run the standalone verifier against independent RPCs.

## CKB commitment

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

The verifier derives these bytes itself and accepts an anchor only after CKB reports the transaction committed and the exact output data is present.

v0.2 uses one commitment per proof session for clarity. A later production design should batch multiple session commitments into a higher-level root if on-chain capacity becomes material; per-event on-chain storage is explicitly out of scope.

## Adapter boundary

`@eventmesh/adapter-sdk` intentionally owns only application semantics:

```ts
interface EventMeshAdapter<TState> {
  name: string;
  eventTypes: readonly string[];
  validateEvent(event): ValidationResult;
  validateTranscript?(transcript): ValidationResult;
  deriveFinalState(transcript): TState;
}
```

The paid-service reference adapter validates one full ordered workflow and deterministic final state. A funded external integration should use a similarly small 3–5-event adapter in a repository maintained independently from EventMesh.

## Security / status

**Reference implementation / Testnet validation project. Not audited. Do not use production keys or mainnet funds.**

For a public deployment, do not compile an admin token into the browser demo. Keep the operator admin API protected and use a reviewer credential or a separate deliberately scoped demo service.

The strongest next proof is not more protocol surface. It is:

```text
independent application
+ independent operator hosts/FNNs
+ real Fiber payment
+ receiver restart/recovery
+ one committed CKB proof
+ third-party verification
+ documented adopter feedback
```

## One-project Vercel demo (v0.4.1 JSON path)

The public demo deploys the Vite UI, `/api/demo`, and `/api/health` from one Vercel project. It requires no database: demo state is JSON-backed (`/tmp` on Vercel, `.data/` locally). Browser code never receives operator private keys or an admin token.

The v0.4.1 demo path keeps the runtime packages compiled before function packaging, reports JSON-storage readiness through `/api/demo` and `/api/health`, and handles non-JSON platform errors without crashing on `JSON.parse`. Vercel `/tmp` is explicitly treated as ephemeral demo storage, not durable persistence.

### Generate configuration and deploy

```bash
chmod +x scripts/generate-env.sh scripts/deploy-vercel-testnet.sh
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

The script pushes the runtime variables to Vercel, deploys, probes `/api/health?deep=1`, and performs a signed create → event → close smoke test against the deployed URL. CKB uses Testnet by default for RPC reads; broadcasting requires both a funded Testnet-only `CKB_PRIVATE_KEY` and `DEMO_ALLOW_CKB_BROADCAST=true`.

A native Fiber FNN should remain on a persistent host; set `FIBER_RECEIVER_RPC_URL` to that receiver-owned node. EventMesh intentionally refuses `PAYMENT_SETTLED` when the receiver RPC cannot prove the matching paid invoice.

See `VERCEL_DEPLOYMENT.md` for the zero-database JSON demo, CKB Testnet, Fiber, diagnostics, and security details.

This Vercel surface is intentionally a reviewer/demo surface. The original `apps/operator` two-process implementation remains available for independent-host protocol testing.
