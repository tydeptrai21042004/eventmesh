# EventMesh review response — smaller scope, falsifiable comparison

This change set responds to the CKBuilders criticism that a universal bilateral
reconciliation SDK risks reimplementing difficult consensus/recovery behavior
without demonstrated demand. It does not claim to solve Fiber channel-state
reestablishment, enforce promises, or resolve an adversarial dispute.

## What has been added

- **Receipt-first path:** `@eventmesh/adapter-sdk` exports
  `createProviderReceipt`, `acknowledgeApplicationReceipt`, and
  `verifyApplicationReceipt`. It requires neither EventMesh operators nor CKB.
- **Unmodified legacy evidence:** the signed v0.2 transcript format, v1 paid
  service rules hash, existing key/signature domains, and exported events are
  not migrated or reinterpreted.
- **New paid-service requests:** choose `applicationProfile: "paid-service"`
  for the existing strict v2 rules (a receiver-verified `PAYMENT_SETTLED` is
  required before close). Explicit `paid-service-v1` still selects legacy v1;
  `paid-service-v2` still works. No change to default `generic-bilateral-v1`.
- **Stricter standalone application assurance:** the independent CLI verifier
  rejects a v2 closed transcript whose committed final application state is
  omitted or does not match the deterministic state derived from accepted
  events. Historical v1 closes without embedded finalState remain compatible.
- **Executable alternatives check:** local proof semantics are measured for a
  one-database idempotent API, countersigned receipts, and EventMesh events.
  This is not a performance, network-failure, real-FNN, adoption, or production
  benchmark. It deliberately shows that both receipt and transcript formats
  can contain conflicting mutually signed evidence.

## Commands

From a full checkout with these files overlaid:

```sh
npm install
npm run check:all
npm run demo:receipt -- ./receipt-example.json
npm run verify:receipt -- ./receipt-example.json --require-acceptance
npm run compare:alternatives
```

To pin keys, add `--expected-provider 0x... --expected-consumer 0x...` to the
`verify:receipt` command. An unpinned signature proves control of the embedded
public key, **not** which person/organization owns that key.

Use a secure key store for real integrations. The example generates disposable
keys for testing, does not operate a Fiber node, and does not move value.

## Explicit proof and threat boundaries

| Output | What it actually establishes | What it does not establish |
| --- | --- | --- |
| Provider-only receipt | Provider key signed a particular request/result commitment | Consumer agreement |
| Consumer `ACCEPT` countersignature | Both specified keys signed the exact same provider statement | Result correctness, physical delivery, actual Fiber settlement |
| Consumer `REJECT` countersignature | Consumer key rejected that signed statement | Mutual acceptance |
| Full signed event transcript | Ordered bilateral signed events and ACKs | Global uniqueness, enforcement, non-disclosure of unseen forks |
| Fiber `paymentHash` in receipt | A claimed reference to a payment | Paid status; receiver-side FNN verification is still required |
| CKB checkpoint | On-chain commitment when independently checked | Truth of off-chain events; dispute arbitration |

Offline receipt verification deliberately returns `fiberPaymentVerified: false`
and `uniqueGlobalStateProven: false` even when a payment reference exists.
Receipts do not de-duplicate requests across hosts: use a durable application
idempotency store. Signed timestamps are self-asserted and cannot prove when an
external event actually happened; verifying a historical receipt does not use
wall-clock expiry as an authenticity check. Avoid building a global protocol
around these receipts unless an independent use case demonstrates a need.

## Comparison scope and next required evidence

The `compare:alternatives` command uses **deterministic local cryptographic
fixtures**, not external operators. The single-DB API prevents a replayed
business transition; the receipt format already suffices for a simple mutually
acknowledged result. EventMesh additionally retains ordered cross-event proofs,
but neither system resolves two independently signed contradictory outcomes.

Before claiming practical differentiation, run identical injected-failure tests
with separate durable operator stores and independently operated FNNs. Capture
lost responses, restart/replay, conflicting result hashes, exactly-once
application transitions, independent evidence exports, and verifier output.
Then recruit at least one external application to evaluate whether signed
receipts or a conventional idempotent API already meet its requirements.

Related work to assess before introducing more format surface:
- https://github.com/StelarDigital/x402-receipts
- https://www.rfc-editor.org/rfc/rfc9421.html
- https://datatracker.ietf.org/doc/rfc9943/
- https://github.com/nervosnetwork/fiber/pull/1677

If ordinary signed receipts satisfy the real use case, prefer the lighter SDK
and postpone generic reconciliation features.
