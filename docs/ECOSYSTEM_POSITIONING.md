# EventMesh v0.2 — CKB/Fiber Ecosystem Positioning

_Last reviewed: 2026-09-29._

## Product boundary

EventMesh should be described as **cross-operator application reconciliation**, not a generic event protocol.

```text
Fiber:      payment state
EventMesh:  mutually accepted application state around that payment
CKB:        durable public checkpoint of the final bilateral proof
```

The concrete question is:

> After a payment, retry, timeout, or restart, can two independently operated applications prove which exact business event and final state they both accepted without treating either local database as unilateral truth?

## Why this boundary fits the current ecosystem

Fiber v0.9 is already focused on payment/channel reliability, recovery, reconnect behavior, mobile/hosted-LSP architecture, routing and broader payment infrastructure. Reimplementing those layers would create overlap rather than ecosystem value.

The August 2026 ecosystem opportunity map explicitly places generic metering and paid-access receipts in **reuse existing components** territory, while **cross-operator game/device events** remain a frontier hypothesis whose user/trust model needs evidence.

EventMesh should therefore validate that frontier instead of adding another wallet, metering, paid-HTTP, or receipt product.

## Neighbor boundaries

### Fiber

Owns payment/channel/network state. EventMesh consumes invoice/payment evidence; it never becomes a payment rail or router.

### Clasp

Clasp provides scoped, revocable application authority over Fiber wallets with permission/spending policy. EventMesh must not add wallet session permissions, budgets, delegation, or revocation.

### FiberLatch Access

FiberLatch Access takes a payment/business decision the host already trusts and issues/redeems signed access receipts. EventMesh must not add paid-resource receipts or access-token redemption.

### Myelin

Myelin is an off-chain CKB-aligned state-execution/session runtime with finality/dispute evidence. EventMesh must not execute arbitrary application state, implement a court/challenge system, or claim consensus/finality.

### Generic event middleware

EventMesh is not pub/sub, routing, fan-out, consumer groups, or event storage infrastructure. It is intentionally bilateral and evidence-oriented.

## The CKB/Fiber-native loop

```text
application event
      |
      v
signed exact counterparty ACK
      |
      v
optional Fiber payment claim
      |
      v
receiver independently queries own FNN
      |
      v
PAYMENT_SETTLED accepted
      |
      v
paymentEvidenceRoot + transcriptRoot + finalStateHash
      |
      v
dual-signed close
      |
      v
EVENTMESH_V02 checkpoint on CKB
      |
      v
third-party standalone verification
```

The story is the complete loop, not merely "store a hash on CKB."

## What funding should validate

The strongest evidence is not another EventMesh-owned application. It is:

```text
one independently maintained CKB/Fiber application
+ tiny 3–5-event adapter
+ two separately operated EventMesh/FNN environments
+ real Fiber payment
+ real restart/lost-response failure
+ recovery without manual DB edit
+ one dual-signed close
+ one committed CKB Testnet checkpoint
+ one fresh-machine verifier run
+ adopter feedback
```

## Do not add to core

- wallet/spending policy;
- Fiber routing, LSP, liquidity management;
- x402/paid HTTP gateway;
- access receipts/redemption;
- usage metering;
- escrow, milestone or arbitration logic;
- marketplace, provider discovery or reputation;
- DID/agent framework;
- application VM or off-chain consensus;
- custom token;
- per-event CKB storage.

## When EventMesh is not needed

EventMesh is probably unnecessary when:

- one backend is already trusted as authoritative;
- ordinary database idempotency and webhook retry semantics are sufficient;
- no independent operator needs to sign acceptance;
- no later third-party verification matters;
- the interaction is a simple one-shot checkout with no cross-operator application state.

Publishing this negative boundary strengthens the funding case because it prevents the project from pretending to be universal infrastructure.

## Public references

- Opportunity map: https://talk.nervos.org/t/ai-machine-payments-and-fiber-in-2026-an-opportunity-map-for-ckb-and-fiber-developers/10665
- Fiber: https://github.com/nervosnetwork/fiber
- Fiber v0.9 recovery: https://github.com/nervosnetwork/fiber/discussions/1610
- Fiber post-v0.9 direction: https://github.com/nervosnetwork/fiber/discussions/1631
- Fiber invoice/payment examples: https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md
- Clasp: https://github.com/Enoch208/Clasp
- FiberLatch Access: https://talk.nervos.org/t/dis-fiberlatch-access-open-source-access-control-for-fiber-payments/10414
- Myelin: https://talk.nervos.org/t/introducing-myelin-a-ckb-aligned-off-chain-cell-session-runtime/10498
