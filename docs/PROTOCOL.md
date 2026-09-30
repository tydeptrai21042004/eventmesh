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
EventMesh/eventmesh-v0.2.0/payment-evidence
```

The stable protocol evidence includes `SignedSession`, `SignedEvent`, `SignedAck`, `SignedClose`, and receiver-signed Fiber observations. The CKB anchor domain remains `EVENTMESH_V02` for compatibility.

## 3. Session/event rules

- A session has exactly two distinct secp256k1 operator public keys.
- Operator A persists a partially signed session in `CREATING` before contacting B; retry completes the same session ID/signature instead of generating a replacement session.
- Events are contiguous and hash-linked with `previousHash`.
- v0.2 permits only one unresolved event at a time.
- The event sender cannot ACK its own event.
- The counterparty signs ACCEPT or REJECT over the exact event hash.
- First valid evidence is immutable. Conflicting session/event/ACK/close/anchor/payment material is retained and marks the session `DISPUTED`.
- A same-sequence event from the other operator is `PROPOSAL_COLLISION`, not same-sender equivocation.
- A normal close is blocked when any event has a REJECT ACK.

## 4. Fiber payment event

`PAYMENT_SETTLED` payload:

```ts
{
  paymentHash: Hex32,
  sessionId: string,
  amount: string,
  currency: "Fibb" | "Fibt" | "Fibd",
  udtTypeScript?: CkbScript,
  obligationId?: string,
  settlesEventHash?: Hex32,
  purposeHash?: Hex32,
  expectedPayeePublicKey?: string
}
```

The receiver MUST independently call `get_invoice(paymentHash)` on its own configured FNN before ACCEPT.

Required checks:

1. invoice status is `Paid`;
2. payment hash, numerical amount and currency match;
3. invoice description includes exact `eventmesh:<sessionId>`;
4. claimed obligation/result/purpose markers match when present;
5. `purposeHash`, when present, recomputes from the canonical purpose fields;
6. expected payee key matches the invoice observation when claimed;
7. claimed UDT script must be observed and exactly equal; unexpected observed UDT is rejected;
8. one payment hash cannot satisfy multiple EventMesh sessions/events.

Sender-side `get_payment == Success` remains corroboration only.

## 5. Receiver-owned signed observation

After receiver FNN verification, the receiving EventMesh operator signs:

```ts
{
  evidence: {
    claim,
    verifier: "RECEIVER_FNN",
    verifiedAt,
    invoiceStatus: "Paid",
    payeePublicKey?,
    observedUdtTypeScript?
  },
  observer,
  evidenceHash,
  signature
}
```

The ACCEPTing ACK operator and the observation signer must be the same session participant. New exports include this signed observation and verification rejects missing, mismatched, or tampered evidence when the evidence section is present. Historical v0.2 exports without an evidence section remain verifiable for backward compatibility, but do not receive this stronger observation-authentication guarantee.

## 6. v0.2 payment claim commitment

For every accepted `PAYMENT_SETTLED` claim:

```text
leaf = SHA256(canonical(FiberPaymentClaim))
```

Claims are sorted by payment hash and Merkleized into `paymentEvidenceRoot`. This commits amount, currency, session, UDT and any obligation/result/purpose/payee claim fields.

For wire compatibility, `EVENTMESH_V02` does **not** additionally commit the receiver-observation signature. That signed observation travels in the transcript and is independently verified. A future anchor version can add a dedicated signed-observation root.

## 7. Durable delivery and reconciliation

Outbound immutable evidence is assigned deterministic outbox IDs:

```text
event:<eventHash>
ack:<ackHash>
anchor:<txHash>
```

Repeated delivery is idempotent. `/peer/sessions/:id/head` exposes only reconciliation identifiers (event/ACK hashes, close hash and anchor tx hash). The admin reconciliation route can safely re-deliver local signed evidence and detects forks rather than overwriting either side.

## 8. Close

The close commits to `sessionId`, `eventCount`, `transcriptRoot`, `finalStateHash`, `fiberPayments[]`, `paymentEvidenceRoot`, and `closedAt`. Both A and B independently recompute roots before signing the same close body.

## 9. CKB commitment and lifecycle

Canonical output data remains:

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

Anchor lifecycle:

```text
prepare/sign -> persist deterministic txHash -> broadcast -> PENDING
-> COMMITTED -> CONFIRMED (when configured depth is reached)
```

A timeout after broadcast is treated as ambiguous. Recovery queries the persisted tx hash; it must not blindly create a replacement transaction.

## 10. Adapter boundary

Application-specific semantics live outside core in an `EventMeshAdapter`. An adapter may validate event ordering/payloads and derive a final application state, but cannot weaken session signatures, ACK rules, Fiber receiver verification, or CKB commitment verification.
