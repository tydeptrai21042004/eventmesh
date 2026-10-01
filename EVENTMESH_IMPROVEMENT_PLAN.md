# EventMesh Improvement Plan

## 1. Product Positioning

### One-line purpose
**EventMesh is a bilateral reconciliation protocol for proving which application state two independent operators both accepted, especially around Fiber-paid workflows.**

### Core question
> A payment may have succeeded, but after a timeout, retry, crash, or lost response, what exact application event or result did both operators agree that the payment settled?

### EventMesh must own
- signed bilateral sessions;
- signed application events;
- explicit ACK / REJECT of exact events;
- hash-linked event transcripts;
- stale-write and fork detection;
- receiver-side payment evidence binding;
- dual-signed final commitments;
- portable evidence export and verification;
- optional compact anchoring of a final commitment.

### EventMesh must not own
- CKB transaction recovery logic;
- CKB wallet signing;
- CKB ownership / entitlement state;
- Fiber routing or channel management;
- payment retries;
- quota, warranty, or application business databases;
- DID / reputation / credential systems;
- generic event-bus functionality.

This boundary prevents overlap with CellFlow, SkillPass, SkillPass Care, Fiber, and ordinary application databases.

---

## 2. Recommended Flagship Scenario

### Scenario: paid remote service result reconciliation

Use a concrete service where payment and application result can become inconsistent.

Example:

1. Operator A requests a remote service from Operator B.
2. A signs `SERVICE_REQUEST`.
3. B verifies and signs `REQUEST_ACCEPTED`.
4. A pays through Fiber.
5. B independently verifies the payment from the receiver side.
6. B signs a `RESULT_COMMITMENT`.
7. B delivers the result.
8. A signs `DELIVERY_ACCEPTED`.
9. Both operators sign the same final transcript commitment.
10. The final commitment may optionally be checkpointed to CKB.

```text
Operator A                                  Operator B
    |                                           |
    |---- signed SERVICE_REQUEST ------------->|
    |<--- signed REQUEST_ACCEPTED --------------|
    |                                           |
    |------------ Fiber payment -------------->|
    |                                           |
    |                         receiver verifies |
    |                         payment locally   |
    |                                           |
    |<--- signed RESULT_COMMITMENT -------------|
    |<--- result delivery ----------------------|
    |---- signed DELIVERY_ACCEPTED ------------>|
    |                                           |
    |---- final commitment signature ---------->|
    |<--- final commitment signature -----------|
    |                                           |
    +--------- same transcript root ------------+
```

This scenario is better than reusing the SkillPass transfer demo because it makes EventMesh's unique problem immediately obvious.

---

## 3. Protocol Simplification

### Keep the protocol core small

The core protocol should understand only:

```text
Session
OperatorIdentity
SignedEvent
Acknowledgement
TranscriptTip
FinalCommitment
VerificationResult
```

### Suggested event types

Keep a strict allow-list for the flagship service flow:

```text
SERVICE_REQUEST
REQUEST_ACCEPTED
PAYMENT_REFERENCE
PAYMENT_VERIFIED
RESULT_COMMITMENT
DELIVERY_COMPLETED
DELIVERY_ACCEPTED
FINALIZE
```

Avoid adding generic arbitrary event types until an external integration proves they are necessary.

---

## 4. Strong Invariant

Place this prominently in the README and protocol documentation:

> **A business state is mutually finalized only when both operators sign the same final transcript commitment.**

The protocol should never interpret:
- sender payment success;
- one operator's local database;
- a single signature;
- or a CKB anchor

as equivalent to bilateral agreement.

---

## 5. Separate Fiber Responsibility

EventMesh should not become a payment protocol.

Create a narrow adapter:

```ts
export interface PaymentVerifier {
  verify(
    reference: PaymentReference,
    expected: ExpectedPayment
  ): Promise<PaymentEvidence>;
}
```

Recommended implementation:

```text
FiberPaymentVerifier
```

The verifier returns evidence such as:

```json
{
  "paymentHash": "...",
  "receiver": "...",
  "amount": "...",
  "asset": "...",
  "verifiedByReceiver": true,
  "verifiedAt": "..."
}
```

EventMesh stores and signs this evidence but does not:
- route Fiber payments;
- manage channels;
- retry payments;
- become an invoice server.

---

## 6. Remove CellFlow Overlap

### Current risk
EventMesh currently contains CKB transaction-identity and ambiguous-broadcast recovery behavior. That is useful but overlaps with CellFlow.

### Target architecture

```text
EventMesh
    |
    v
CommitmentAnchor
    |
    +--> NoopAnchor
    |
    +--> DirectCkbAnchor       # demo/reference only
    |
    +--> CellFlowAnchor        # durable production-oriented path
```

Suggested interface:

```ts
export interface CommitmentAnchor {
  submit(commitment: FinalCommitment): Promise<AnchorReference>;
  getStatus(reference: AnchorReference): Promise<AnchorStatus>;
}
```

### Rule
EventMesh should care only about:
- which commitment should be anchored;
- the resulting anchor reference;
- whether the anchor is observed as settled.

It should not implement:
- multi-attempt CKB transaction state;
- RBF handling;
- input conflict analysis;
- RPC failover;
- reorg recovery state machines.

Those belong to CellFlow.

---

## 7. Production Architecture

### Public demo
The current database-free Vercel preview can remain as a reference implementation.

Use it only for:
- protocol walkthrough;
- signed evidence creation;
- export/import verification;
- stale-write/fork demonstrations;
- UI onboarding.

### Production validation
Run two truly independent operator deployments.

```text
Operator A
- own private key
- own durable storage
- own service process
- own Fiber node / receiver view where applicable

Operator B
- own private key
- own durable storage
- own service process
- own Fiber node
```

Do not call two identities in one server process "independent operators" in final validation evidence.

---

## 8. Durable State Model

For production validation, each operator should persist:

```text
sessions
events
acknowledgements
transcript_tips
payment_evidence
final_commitments
anchor_references
verification_results
```

Recommended guarantees:
- unique `(session_id, sequence_no)`;
- optimistic concurrency with expected tip;
- idempotent event submission;
- append-only event history;
- explicit fork detection;
- crash-safe finalization;
- evidence export independent of the server database.

---

## 9. Adversarial / Failure Scenarios

Add dedicated tests for:

### Protocol
- replayed event;
- event signed by wrong operator;
- event with wrong domain separator;
- modified payload;
- invalid previous hash;
- duplicate sequence number;
- stale expected event count;
- stale transcript tip;
- conflicting children from the same tip;
- ACK for a different event hash;
- invalid final commitment;
- one-sided finalization.

### Fiber boundary
- sender says paid but receiver cannot verify;
- wrong amount;
- wrong receiver;
- wrong payment reference;
- duplicate payment reference;
- payment evidence from the wrong Fiber node;
- payment succeeds after request expiry.

### Recovery
- Operator A crashes after signing request;
- Operator B crashes after payment verification;
- lost ACK;
- duplicate result delivery;
- delayed result;
- cold restart;
- divergent local state followed by evidence exchange.

### CKB anchor adapter
- anchor submission timeout;
- anchor pending;
- anchor committed;
- anchor reorg;
- anchor transaction superseded or rebuilt;
- CellFlow unavailable while protocol finalization remains valid.

---

## 10. Evidence Package

Publish one machine-readable evidence directory:

```text
evidence/
  paid-service-testnet/
    session.json
    operator-a-public-key.json
    operator-b-public-key.json
    transcript.json
    payment-evidence.json
    final-commitment.json
    signatures.json
    verifier-output.json
    ckb-anchor.json
    reproduction.md
```

A reviewer should be able to verify the transcript without trusting the hosted EventMesh server.

---

## 11. UI Plan

### Landing message
> **Prove what two independent services agreed happened.**

### Main workflow
1. Start session
2. Send signed request
3. Accept request
4. Attach / verify Fiber payment
5. Commit result
6. Confirm delivery
7. Dual-sign final state
8. Verify exported evidence
9. Optional CKB checkpoint

### Avoid on the front page
Do not prominently present:
- SkillPass ownership;
- warranty quota;
- generic CKB transaction recovery;
- wallet management.

Those make the scope look broader than it is.

---

## 12. Repository Structure

Recommended structure:

```text
src/
  protocol/
  transcript/
  crypto/
  state-machine/
  verifier/

adapters/
  fiber/
  anchor/
    noop/
    direct-ckb/
    cellflow/

apps/
  demo/
  operator-service/

examples/
  paid-compute/
  paid-api-result/

tests/
  protocol/
  adversarial/
  crash-recovery/
  integration/

evidence/
docs/
  protocol-boundary.md
  threat-model.md
  fiber-boundary.md
  ckb-anchor-boundary.md
```

---

## 13. Versioning Cleanup

Separate three concepts explicitly:

```text
Software release: EventMesh v0.6.x
Wire protocol: eventmesh-v0.2.0
CKB anchor format: EVENTMESH_V02
```

Do not call all three simply "EventMesh v0.2".

---

## 14. Milestone Plan

### P0 — Boundary cleanup
- Extract `PaymentVerifier`.
- Extract `CommitmentAnchor`.
- Move direct CKB recovery out of protocol core.
- Document Fiber / EventMesh / CKB responsibility split.
- Normalize software/protocol/anchor version terminology.

### P0 — Independent deployment
- Run Operator A and Operator B independently.
- Give them separate signing keys and durable storage.
- Add independent transcript verification.

### P1 — Real Fiber validation
- Execute receiver-verified Fiber Testnet payment.
- Bind payment evidence to an exact session/event.
- Demonstrate rejection of unverified sender claims.

### P1 — CKB checkpoint
- Anchor the final commitment.
- Prefer CellFlow-backed anchor handling for durable recovery.
- Publish transaction and block evidence.

### P1 — External integration
- Integrate one external CKB/Fiber application through the adapter SDK.

### P2 — Scale features only after validation
- commitment batching;
- multi-session aggregation;
- additional service flow templates;
- operator observability.

---

## 15. Final Scope Test

Before adding a feature, ask:

> Does this feature help two operators agree on and prove the same application state?

If **yes**, it may belong in EventMesh.

If it primarily:
- recovers a CKB transaction -> CellFlow;
- determines ownership -> SkillPass;
- manages coverage/history -> SkillPass Care;
- sends/verifies network payment mechanics -> Fiber.

That rule should prevent future overlap.
