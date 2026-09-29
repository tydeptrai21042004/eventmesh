# EventMesh v0.2 Protocol

## 1. Scope

EventMesh records what two configured operator keys explicitly accepted in one bilateral session. It does not prove an external-world fact is true and is not a consensus protocol.

## 2. Signed objects

Every signature is domain-separated by protocol version and object class:

```text
EventMesh/eventmesh-v0.2.0/session
EventMesh/eventmesh-v0.2.0/event
EventMesh/eventmesh-v0.2.0/ack
EventMesh/eventmesh-v0.2.0/close
```

The stable signed objects are `SignedSession`, `SignedEvent`, `SignedAck`, and `SignedClose`.

## 3. Session/event rules

- A session has exactly two distinct secp256k1 operator public keys.
- Events are contiguous and hash-linked with `previousHash`.
- v0.2 proof profile permits only one unresolved event at a time. This intentionally avoids pretending to implement multilateral ordering/consensus.
- The event sender cannot ACK its own event.
- The counterparty signs ACCEPT or REJECT over the exact event hash.
- First valid evidence is immutable. Conflicting session/event/ACK/close/anchor/payment material is retained and marks the session `DISPUTED`.
- A same-sequence event from the other operator is recorded as `PROPOSAL_COLLISION`, not falsely labelled sender equivocation.

A normal close is blocked when any event has a REJECT ACK.

## 4. Fiber payment event

`PAYMENT_SETTLED` payload:

```ts
{
  paymentHash: Hex32,
  sessionId: string,
  amount: string,              // decimal or 0x quantity
  currency: "Fibb" | "Fibt" | "Fibd",
  udtTypeScript?: {
    code_hash: Hex32,
    hash_type: "data" | "type" | "data1" | "data2",
    args: Hex
  }
}
```

The receiver MUST independently call `get_invoice(paymentHash)` on its own configured FNN before ACCEPT.

Required checks:

1. invoice status is `Paid`;
2. payment hash matches exactly;
3. amount matches numerically;
4. currency matches;
5. invoice description includes exact `eventmesh:<sessionId>` marker;
6. if a UDT script is claimed, the receiver must observe and exactly match the same script;
7. if no UDT is claimed but the invoice exposes a UDT script, reject the claim;
8. a payment hash cannot satisfy multiple EventMesh sessions/events.

Sender-side `get_payment == Success` can be useful corroboration but MUST NOT replace receiver-owned verification.

## 5. Payment evidence commitment

For every accepted `PAYMENT_SETTLED` claim:

```text
leaf = SHA256(canonical(FiberPaymentClaim))
```

Claims are sorted by payment hash and Merkleized into:

```text
paymentEvidenceRoot
```

This means amount, currency, session binding and optional exact UDT type script are committed—not only the payment hash.

## 6. Close

The close commits to:

```text
sessionId
eventCount
transcriptRoot
finalStateHash
fiberPayments[]
paymentEvidenceRoot
closedAt
```

Both A and B independently recompute the transcript and payment-evidence roots before signing the same close body.

## 7. CKB commitment

Canonical output data:

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

The peer/verifier never trusts supplied `dataHex` alone. It derives expected bytes locally, queries CKB `get_transaction(txHash)`, requires committed status, and requires one output-data item to exactly match the expected commitment. `EVENTMESH_V02` is 141 output-data bytes; with the standard secp lock the adapter enforces at least 202 CKB occupied capacity and uses 220 CKB by default.

## 8. Anchor lifecycle

Broadcast returns `PENDING`. Proof quality is achieved only after independent reconciliation returns `COMMITTED`.

Operator A can call:

```text
POST /admin/sessions/:id/anchor/reconcile
```

The route rechecks CKB and retries notifying B when the transaction is committed.

## 9. Adapter boundary

Application-specific semantics live outside core in an `EventMeshAdapter`:

```ts
validateEvent(event)
deriveFinalState(transcript)
```

The adapter cannot change the cryptographic transcript, Fiber verification rules or CKB commitment format.
