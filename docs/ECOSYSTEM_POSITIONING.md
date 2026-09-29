# EventMesh v0.2 — CKB/Fiber Ecosystem Positioning

_Last reviewed: 2026-09-29._

## Final project boundary

EventMesh is **not** a Fiber payment SDK and **not** a generic event bus anchored to a blockchain.

It is an application-neutral **bilateral cross-operator evidence layer**:

1. two independently operated applications exchange signed, hash-linked events;
2. the counterparty explicitly ACCEPTs or REJECTs each exact event hash;
3. a `PAYMENT_SETTLED` event can be accepted only after the receiver independently queries its own Fiber node and verifies the invoice;
4. both operators sign one final transcript/state commitment;
5. a compact commitment is published to CKB and can be independently reconstructed and verified.

```text
application A                                      application B
     |                                                  |
operator A  <---- signed event / signed ACK ---->  operator B
     |                                                  |
   FNN A  -------- optional Fiber value --------->    FNN B
                                                        |
                                      receiver get_invoice verification
                         \                              /
                          +---- dual-signed close -----+
                                      |
                           compact EVENTMESH_V02
                                      |
                                     CKB
                                      |
                            standalone verifier
```

## Why this boundary fits the current ecosystem

Fiber v0.9 is already a serious payment network. Its current development direction includes payment reliability/recovery, hosted-LSP/mobile architecture, browser/WASM integration, liquidity work and programmable conditional payments. EventMesh should consume Fiber rather than reimplement those areas.

The July 2026 "Gone in 60ms" infrastructure hackathon reported 66 submissions across wallet/payment UX, node/routing/diagnostics and merchant/liquidity/LSP tooling. That makes another generic payment wrapper, router, wallet policy engine or metering product a weak differentiation strategy.

CKB itself describes L1 as a Universal Verification Layer: computation can remain above L1 while durable verification/common knowledge is committed to CKB. EventMesh follows that shape: application interaction and payment verification happen off-chain; CKB receives one compact final commitment.

The CKBuilder tracker also contains real applications such as CKB Arcade, Dragon Rush and CKB Geo-Wars. The strongest external validation for EventMesh is therefore one small adapter into an independently maintained game/device/service application, not another EventMesh-owned toy product.

## What EventMesh deliberately does not own

Do not add these to the core project:

- wallet/spending permission policy;
- Fiber routing, LSP or liquidity management;
- generic x402 or paid-HTTP gateway;
- generic usage metering;
- escrow, milestones or arbitration;
- marketplace/reputation/DID;
- AI-agent framework;
- token issuance;
- multilateral consensus;
- per-event on-chain storage.

Those can be applications or neighboring components. EventMesh should remain the evidence boundary between independently operated applications.

## CKB-native economic/evidence loop

The important CKB/Fiber-specific story is the full loop, not "we anchor a hash":

```text
CKB / UDT value
      |
      v
Fiber invoice/payment
      |
      v
receiver-owned verification
      |
      v
PAYMENT_SETTLED application event
      |
      v
signed counterparty ACK
      |
      v
paymentEvidenceRoot + transcriptRoot + finalStateHash
      |
      v
EVENTMESH_V02 CKB commitment
```

## v0.2 proof target

A funding-grade proof should demonstrate all of the following at once:

```text
different operator organizations/owners
+ different machines
+ different private keys
+ different SQLite databases
+ different FNN nodes
+ real Fiber Testnet value
+ receiver-owned invoice verification
+ one mutually accepted transcript
+ one dual-signed close
+ one committed CKB Testnet transaction
+ one standalone verifier reproducing the result
```

## Suggested first external adapter

Prefer one existing CKBuilder game/device project because cross-operator game/device events naturally demonstrate bilateral application evidence. Keep the integration intentionally small: 3–5 application event types are enough.

The new `@eventmesh/adapter-sdk` package therefore exposes only two responsibilities:

- validate application events;
- deterministically derive final application state.

It does not expose payment authority, wallets, routing, escrow or consensus.

## Primary public references

- Fiber repository / roadmap: https://github.com/nervosnetwork/fiber
- Fiber v0.9 dev log: https://github.com/nervosnetwork/fiber/discussions/1631
- Fiber invoice specification: https://github.com/nervosnetwork/fiber/blob/develop/docs/specs/payment-invoice.md
- Fiber public-node payment examples: https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md
- Gone in 60ms results: https://talk.nervos.org/t/gone-in-60ms-fiber-network-infrastructure-hackathon-results/10671
- CKBuilder tracker: https://github.com/Nervos-Community-Catalyst/CKBuilder-projects
- CKB repository / Universal Verification Layer description: https://github.com/nervosnetwork/ckb
