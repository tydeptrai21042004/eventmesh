# EventMesh v0.2 Wire Protocol + Commitment v3

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

The stable protocol evidence includes `SignedSession`, `SignedEvent`, `SignedAck`, `SignedClose`, and receiver-signed Fiber observations. Legacy sessions/closes remain readable as v0.2 evidence. New profiled sessions add a `commitmentVersion: 3` close layer and use the `EVENTMESH_V03` CKB commitment domain.

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

The ACCEPTing ACK operator and the observation signer must be the same session participant. For commitment v3, the PAYMENT_SETTLED ACK additionally contains the exact `evidenceHash`; the close commits a Merkle root over the complete signed observations. Removing or replacing the evidence therefore invalidates the v3 proof. Historical v0.2 exports without this binding remain verifiable for backward compatibility, but do not receive the v3 observation-commitment guarantee.

## 6. Payment claim and receiver-observation commitments

For every accepted `PAYMENT_SETTLED` claim:

```text
claimLeaf = SHA256(canonical(FiberPaymentClaim))
```

Claims are sorted by payment hash and Merkleized into the legacy-compatible `paymentEvidenceRoot`.

Commitment v3 additionally computes:

```text
observationLeaf = SHA256(canonical(SignedFiberPaymentEvidence))
paymentObservationRoot = MerkleRoot(sorted observationLeaf values)
```

Every accepted payment ACK must bind the corresponding signed observation through `ack.evidenceHash`. A v3 verifier therefore rejects a proof if signed receiver evidence is removed, substituted, signed by the wrong operator, or detached from its ACK.

## 7. Durable delivery and reconciliation

Outbound immutable evidence is assigned deterministic outbox IDs:

```text
event:<eventHash>
ack:<ackHash>
anchor:<txHash>
```

Repeated delivery is idempotent. `/peer/sessions/:id/head` exposes only reconciliation identifiers (event/ACK hashes, close hash and anchor tx hash). The admin reconciliation route can safely re-deliver local signed evidence and detects forks rather than overwriting either side.

## 8. Close

Legacy v0.2 closes commit `sessionId`, `eventCount`, `transcriptRoot`, `finalStateHash`, `fiberPayments[]`, `paymentEvidenceRoot`, and `closedAt`.

New profiled sessions produce commitment-v3 closes that additionally commit:

```text
commitmentVersion = 3
paymentObservationRoot
applicationProfileHash
chainContextHash
```

The application profile (`id`, `version`, `rulesHash`) is signed into the session. Both operators validate the transcript under that exact profile and independently derive the final application state before signing the same close body. Caller-supplied final-state JSON is not authoritative for profiled sessions.

## 9. CKB commitment and lifecycle

Legacy close output data remains:

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

Commitment-v3 output data is:

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

The v3 payload is 237 bytes, so a standard secp output needs at least 298 CKB under the adapter's capacity calculation. The adapter automatically raises the requested capacity when necessary.

Anchor lifecycle remains:

```text
prepare/sign -> persist deterministic txHash -> broadcast -> PENDING
-> COMMITTED -> CONFIRMED (when configured depth is reached)
```

A timeout after broadcast is treated as ambiguous. Recovery queries the persisted tx hash; it must not blindly create a replacement transaction.

## 10. Adapter boundary

Application-specific semantics live outside core in an `EventMeshAdapter`. New sessions sign the selected application profile and its `rulesHash`. The operator and independent verifier both enforce the profile.

The built-in paid-service profile enforces role ownership and ordering:

```text
A: SERVICE_REQUESTED
B: SERVICE_ACCEPTED
B: RESULT_COMMITTED
A: PAYMENT_SETTLED (optional, receiver-FNN verified by B)
B: SESSION_COMPLETED
```

When a payment is present it is bound to the request ID, the exact RESULT_COMMITTED event hash, and a canonical purpose hash. The final state is derived deterministically from the accepted transcript.
