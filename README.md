# EventMesh for CKB/Fiber — Cross-Operator Reconciliation Proofs

> **Working project name.** This repository is unrelated to the Apache EventMesh project. Resolve the public-product naming collision before a wider launch; the protocol/domain strings stay `eventmesh-v0.2.0` for this testnet reference implementation.

**Problem:** a Fiber payment can succeed while two independently operated applications still disagree about what business event that payment settled after a timeout, retry, crash, or lost response.

**EventMesh** is a bilateral reconciliation layer for that boundary. Two operators keep separate keys and independent state files, exchange signed application events, explicitly ACCEPT/REJECT exact event hashes, can bind receiver-verified Fiber payments to those events, dual-sign the final state, and optionally checkpoint one compact proof to CKB.

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
    |                             restart from JSON state
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

- distinct secp256k1 operator identities and atomic JSON-file stores;
- crash-recoverable session creation (`CREATING` → retry same signed session → `ACTIVE`);
- durable event/ACK/anchor outbox with idempotent redelivery;
- peer state-head reconciliation with local-evidence repair and fork/ACK-divergence detection;
- domain-separated session/event/ACK/close signatures;
- signed hash-linked events and exact counterparty ACK/REJECT;
- immutable/idempotent evidence plus durable conflict records;
- proposal-collision vs same-sender equivocation distinction;
- globally blocked Fiber payment-hash reuse;
- receiver-owned `get_invoice` verification for `PAYMENT_SETTLED`;
- payment hash + session + amount + currency + optional UDT script binding;
- optional obligation/result/purpose/payee binding for multi-job and milestone sessions;
- receiver FNN observations signed by the receiving EventMesh operator;
- legacy-compatible `paymentEvidenceRoot` plus commitment-v3 `paymentObservationRoot`;
- PAYMENT_SETTLED ACKs bind the exact receiver-signed observation through `evidenceHash`;
- signed application profile/rules hash + chain context on new sessions;
- deterministic final-state derivation on both operators for profiled sessions;
- backward-compatible `EVENTMESH_V02` plus strengthened `EVENTMESH_V03` CKB commitments, with tx identity persisted before broadcast;
- configurable PENDING → COMMITTED → CONFIRMED reconciliation depth;
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

### Production-oriented operator controls

The standalone operator accepts the following hardening knobs in addition to the existing identity/Fiber/CKB variables:

```text
MAX_BODY_BYTES             maximum Fastify request body size (default 256 KiB)
PEER_RATE_LIMIT_MAX        peer requests allowed per source/window
PEER_RATE_LIMIT_WINDOW_MS  peer rate-limit window
PEER_REQUEST_TIMEOUT_MS    outbound peer timeout
CKB_MIN_CONFIRMATIONS      confirmations required before CONFIRMED
```

Durable peer delivery is visible through `GET /admin/outbox`, can be retried with `POST /admin/outbox/drain`, and bilateral state can be compared/repaired with `POST /admin/sessions/:id/reconcile` using `{ "repair": true }`. Session creation is persisted before contacting the peer; a lost join response can be retried with `POST /admin/sessions/:id/join/retry` without minting a new session ID.

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
  --ckb-confirmations 2 \
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

Legacy proofs retain:

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

New profiled sessions use commitment v3:

```text
EVENTMESH_V03
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
|| paymentObservationRoot
|| applicationProfileHash
|| chainContextHash
```

The verifier derives these bytes itself and accepts an anchor only after CKB reports the transaction committed and the exact output data is present. Direct per-session anchoring remains the reference implementation; batching/rolling anchors remain a later capacity optimization.

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

## Recovery / operations API

The standalone operator now exposes explicit recovery surfaces instead of requiring an administrator to guess whether retry is safe:

```text
GET  /admin/outbox
POST /admin/outbox/drain
POST /admin/sessions/:id/reconcile        { "repair": true }
POST /admin/sessions/:id/join/retry
GET  /peer/sessions/:id/head
```

`reconcile` distinguishes `IN_SYNC`, `LOCAL_AHEAD`, `REMOTE_AHEAD`, `FORK`, `ACK_DIVERGENCE`, `CLOSE_DIVERGENCE`, and `ANCHOR_DIVERGENCE`. Repair mode only replays already-signed immutable evidence; it does not manufacture replacement events or ACKs.

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

## One-project Vercel app (v0.6: Demo + Real / Testnet)

The Vercel app now exposes two intentionally different workspaces while remaining **database-free**.

- **Demo** uses deterministic preview identities derived from `DEMO_MASTER_SECRET`, supports the one-click reference flow, stores its portable signed snapshot in Local Storage, and never broadcasts a CKB transaction.
- **Real / Testnet** is disabled by default. It requires explicit Operator A/B private keys plus a separate server-side access key. Its access credential is never persisted by the browser; its signed snapshot uses Session Storage. Automatic reference execution is disabled so each Testnet state transition is explicit.

Vercel `/tmp` remains only a bounded disposable cache. The browser carries the cryptographically verified snapshot needed for cold-start recovery. The standalone operator runtime is also database-free and persists an atomic JSON state file on a persistent host.

### Generate configuration and deploy

```bash
chmod +x scripts/generate-env.sh scripts/deploy-vercel-testnet.sh
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

For Demo, only `DEMO_MASTER_SECRET` is required. To enable the connected Testnet workspace, configure `EVENTMESH_TESTNET_MODE=true`, a 32+ character `EVENTMESH_TESTNET_ACCESS_KEY`, and dedicated `OPERATOR_A_PRIVATE_KEY` / `OPERATOR_B_PRIVATE_KEY`. CKB broadcasting additionally requires `CKB_PRIVATE_KEY` and the explicit `TESTNET_ALLOW_CKB_BROADCAST=true` opt-in.

The v0.6 API also validates the service-flow state machine server-side, restricts event types and payload sizes, requires optimistic `eventCount + chainTip` preconditions for mutations, and rejects CKB anchoring from Demo. The UI adds deployment readiness, browser-tab fork protection, stale-state sync recovery, searchable evidence, richer exports, session expiry visibility, and clearer Demo/Testnet boundaries.

See `VERCEL_DEPLOYMENT.md`, `SECURITY_V06.md`, and `V06_FEATURES.md` for the deployment model, security boundary, and remaining serverless limitation.

**Important:** Real / Testnet mode is still a controlled Testnet surface, not a production custody architecture: one Vercel process can hold both demo operator keys. For real users, the canonical topology is two independently deployed standalone operators, one operator key/FNN/state store per administrative domain. The Vercel workspace should remain onboarding/reviewer UX, not the production trust boundary.

