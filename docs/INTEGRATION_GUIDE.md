# Integrating an Independent Application

EventMesh should be integrated as a **reconciliation boundary**, not as an application runtime. The application remains responsible for deciding whether an action is valid; EventMesh records the exact event that both operators accepted and makes the resulting evidence independently verifiable.

## 1. Use EventMesh only when the boundary is real

A useful integration normally has all of these properties:

- two independently operated systems or organizations;
- no shared database is accepted as the long-term source of truth;
- retries, restarts, or lost responses can make the business state uncertain;
- a Fiber payment may need to be bound to a particular application transition;
- later third-party verification is valuable.

If one trusted backend owns both sides, normal idempotency keys and database transactions are usually simpler.

## 2. Keep the adapter small

Target **3–5 application events**. Do not mirror every internal application action.

The funded reference profile uses:

```text
SERVICE_REQUESTED
→ SERVICE_ACCEPTED
→ RESULT_COMMITTED
→ PAYMENT_SETTLED
→ SESSION_COMPLETED
```

The first, second, third, and fifth events are application semantics. `PAYMENT_SETTLED` is special: the receiver signs `ACCEPT` only after its own configured FNN confirms the invoice is `Paid` and the payment claim matches the session/hash/amount/currency/optional UDT script.

## 3. Implement an adapter

```ts
import type { EventMeshAdapter } from "@eventmesh/adapter-sdk";

export const adapter: EventMeshAdapter<MyFinalState> = {
  name: "my-application",
  eventTypes: ["REQUESTED", "RESULT", "PAYMENT_SETTLED", "COMPLETED"],

  validateEvent(event) {
    // Validate only application-specific payload semantics here.
    return { ok: true };
  },

  validateTranscript(transcript) {
    // Optional cross-event invariants: ordering, same job ID, required events, etc.
    return { ok: true };
  },

  deriveFinalState(transcript) {
    // Deterministically derive the state both operators should close over.
    return { completed: true };
  }
};
```

The adapter must **not** hold wallet credentials, route Fiber payments, implement escrow, or introduce a consensus protocol.

## 4. Map the independent application boundary

Before writing code, document this table in the external repository:

| Question | Integration answer |
| --- | --- |
| Which two operators are independent? | ... |
| What failure currently makes state uncertain? | ... |
| Which side proposes each EventMesh event? | ... |
| Which exact event is linked to Fiber value? | ... |
| What business transition must happen at most once? | ... |
| What final state can both sides derive deterministically? | ... |
| Why is one operator's database not sufficient evidence? | ... |

If these answers are vague, do not expand the protocol. Reconsider whether EventMesh is needed.

## 5. Integration sequence

1. Create/join one EventMesh session.
2. When the application reaches a cross-operator boundary, submit the small semantic event to the local operator.
3. The counterparty validates the event in its own application context and signs `ACCEPT` or `REJECT`.
4. For a value-linked transition, create the invoice on the **receiver** FNN and include the generated claim in `PAYMENT_SETTLED`.
5. Let the receiver's EventMesh operator re-query its own FNN before ACKing that event.
6. After the application state is final, both operators derive the same final state and dual-sign the close.
7. Optionally publish the compact commitment to CKB.
8. Export the transcript and verify it from a fresh environment.

## 6. Funding-grade failure test

The integration is not complete when only the happy path works. Record at least this boundary:

```text
Fiber invoice becomes Paid
→ receiver application/operator response is lost or process stops
→ receiver restarts from durable state
→ sender retries settlement
→ receiver re-checks its own FNN
→ exactly one business transition is accepted
→ no manual database edit
→ both operators close the same state
```

Publish the pre-failure state, restart command/log, retry result, final application state, transcript, payment hash, and CKB transaction hash.

## 7. Verify application semantics too

For the included reference profile:

```bash
npm run verify -- transcript.json \
  --adapter paid-service-reference \
  --receiver-fiber-rpc "$RECEIVER_FNN" \
  --ckb-rpc "$CKB_RPC" \
  --require-close \
  --require-fiber \
  --require-ckb
```

The adapter check verifies the ordered business events and that the close `finalState` equals the state derived from those events. Fiber and CKB are still verified independently by their own RPC paths.

## 8. What to measure

At minimum publish:

- integration files / LOC / setup steps;
- duplicate business transitions after retry (target: 0);
- duplicate payment-hash acceptance (target: 0);
- manual DB edits during recovery (target: 0);
- restart-to-reconciled elapsed time;
- transcript size;
- CKB occupied capacity used by the proof;
- maintainer feedback on whether normal application idempotency would have been sufficient.

The final result may be **continue**, **narrow**, or **stop**. A negative result is useful evidence; it is better than adding protocol surface without a real adopter need.
