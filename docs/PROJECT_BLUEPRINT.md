# EventMesh v0.2 — Funding-Ready Blueprint

## Product identity

EventMesh is a **bilateral application reconciliation layer** for independently operated CKB/Fiber applications.

```text
Application A                         Application B
      |                                     |
      +------ EventMesh reconciliation -----+
                    |              |
                    |              +-- Fiber: value/payment evidence
                    |
                    +----------------- CKB: durable final checkpoint
```

The project should not be marketed as a generic event bus. Its narrow product question is whether two independent operators can recover and prove the same payment-linked application state after retries, crashes, or partial failures.

## Core protocol responsibilities

Keep in core:

- `SignedSession`;
- `SignedEvent`;
- `SignedAck`;
- `SignedClose`;
- deterministic hash chain/transcript root;
- durable conflict evidence;
- deterministic Fiber claim root;
- standalone verification.

## Adapter responsibilities

Keep as adapters:

- Fiber JSON-RPC;
- CKB/CCC anchoring;
- application semantic validation/final-state derivation through `@eventmesh/adapter-sdk`.

The reference paid-service adapter additionally proves that transcript-level invariants can be checked without moving application execution into EventMesh.

## Keep outside EventMesh

- wallet permissions and spending policy;
- x402 gateways and generic paid HTTP;
- access receipts/redemption;
- generic usage metering;
- routing/LSP/liquidity operations;
- escrow, marketplace, reputation, DID;
- AI-agent orchestration;
- application VM/runtime/finality/court;
- token issuance;
- multilateral consensus.

## Evidence model

```text
A proposes signed business event
        |
        v
B validates application semantics
        |
        +-- if PAYMENT_SETTLED:
        |      B -> own FNN -> get_invoice
        |      require Paid/hash/amount/currency/session/UDT
        |
        v
B signs ACCEPT ACK
        |
        v
both durable stores converge on same final event + ACK
        |
        v
both sign same close
```

Sender-side payment status may be retained for debugging but is not an acceptance authority.

## Reviewer evidence model

The operator exposes:

```text
GET /admin/sessions/:id/evidence-summary
```

which summarizes:

- bilateral session signatures;
- event/final/accepted/rejected/pending counts;
- accepted Fiber claims and receiver evidence;
- conflict count/kinds;
- close roots and dual-signature state;
- CKB anchor state;
- readiness flags.

This makes demonstrations legible while keeping trust-minimized verification in the standalone verifier.

## CKB commitment

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

No custom CKB script is required for the validation milestone. CKB is the durable verification/checkpoint layer, not the execution layer.

For production-scale traffic, evaluate batching session commitments into a higher-level root only after real demand appears.

## Repository structure

```text
apps/
  operator/
  verifier/
  demo/                 # guided reconciliation + failure lab
packages/
  core/
  fiber/
  ckb/
  adapter-sdk/
    src/paid-service.ts # reference semantics only
tests/
  core.test.ts
  fiber.test.ts
  ckb.test.ts
  store.test.ts
  security.test.ts
  operator.integration.test.ts
  adapter.test.ts
scripts/
  smoke.mjs
  evidence-check.mjs
docs/
  PROTOCOL.md
  THREAT_MODEL.md
  HOW_TO_VERIFY.md
  ECOSYSTEM_POSITIONING.md
  MARKET_GAP_AND_VALIDATION.md
  FUNDING_PROPOSAL_DRAFT.md
  FUNDING_READINESS_CHECKLIST.md
  evidence/manifest.example.json
```

## Funded milestone sequence

### M1 — independent adopter

Integrate a 3–5-event adapter into one independently maintained CKB/Fiber application/service and record the baseline pain.

### M2 — real Fiber partial failure

Two independent operator/FNN environments execute a payment; receiver crashes or loses the response before application settlement completes; restart and recover without DB edits or duplicate accepted state.

### M3 — CKB committed proof

Dual-sign the close, publish `EVENTMESH_V02`, reconcile to COMMITTED, and let the peer + standalone verifier independently reconstruct the proof.

### M4 — user validation

Interview/use-test 3–5 relevant builders, preserve negative feedback, measure integration/recovery overhead, and decide continue/narrow/stop.

## The funding demo should emphasize failure

The strongest demo is not:

```text
request → payment → close
```

It is:

```text
payment succeeds
→ receiver state/response becomes uncertain
→ receiver restarts
→ payment is re-verified
→ duplicate/replay does not create a second business transition
→ both operators converge
→ third party verifies final proof
```

That is the market pain the protocol is designed to test.
