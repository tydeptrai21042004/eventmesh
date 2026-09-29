# Spark Program | EventMesh for CKB/Fiber — Independent Cross-Operator Proof

_Last updated: 2026-09-29._

## Project overview

**EventMesh for CKB/Fiber** is an application-neutral bilateral evidence layer. Two independently operated systems keep separate keys/stores, exchange signed hash-linked events, explicitly ACCEPT/REJECT the exact event hashes, optionally bind receiver-verified Fiber value transfers to those events, dual-sign one final state, and publish a compact commitment to CKB for later independent verification.

EventMesh does not replace Fiber payments, wallets, routing, LSP/liquidity, metering, escrow or application logic.

## Why this is the current ecosystem gap

Fiber v0.9 is already focused on production payment reliability, recovery, hosted/mobile LSP architecture and deeper payment infrastructure. The July 2026 Fiber infrastructure hackathon also produced 66 projects across wallet/payment UX, node/routing/diagnostics and merchant/liquidity/LSP tooling. EventMesh therefore consumes Fiber instead of building another payment-infrastructure layer.

The project asks a different question: **what exact application interactions and value-linked events did two independently operated applications mutually accept, and can a third party later verify that evidence without trusting their shared database?**

## Current implementation

Already implemented in the repository:

- separate operator secp256k1 identities and SQLite/WAL stores;
- domain-separated session/event/ACK/close signatures;
- immutable/idempotent evidence and durable conflict records;
- cross-session and hash-chain checks;
- explicit ACCEPT/REJECT ACKs;
- receiver-owned Fiber invoice verification for `PAYMENT_SETTLED`;
- hash/session/amount/currency and optional exact UDT type-script binding;
- payment-hash replay/reuse protection;
- deterministic `paymentEvidenceRoot` included in the dual-signed close;
- compact `EVENTMESH_V02` CKB commitment;
- independent CKB `get_transaction` verification requiring committed status + exact output data;
- standalone offline/Fiber/CKB verifier;
- admin/public-mode/peer-URL hardening;
- testable operator application factory and regression suite;
- tiny adapter SDK for future independent application integration.

## Proposed Spark milestone

**Request: USD 1,000 equivalent.** This intentionally targets the Spark program's normal small-experiment scope rather than using the $2,000 overall exception.

### Deliverable 1 — independent two-host Fiber proof — $350

- operator A and B deployed on separate hosts with separate keys, SQLite stores and FNN nodes;
- one real Fiber Testnet invoice/payment;
- receiver independently verifies `Paid`, payment hash, amount, currency and session marker;
- public exported transcript and reproducible command log.

### Deliverable 2 — committed CKB proof — $250

- dual-signed close containing transcript/final-state/payment-evidence roots;
- `EVENTMESH_V02` commitment published to CKB Testnet;
- independent verifier reconstructs bytes locally and confirms `committed` + exact output data.

### Deliverable 3 — failure/recovery evidence — $250

- replay/idempotency proof;
- conflicting ACK/equivocation proof;
- proposal-collision proof;
- payment-hash reuse rejection;
- false/uncommitted CKB anchor rejection;
- FNN/CKB temporary-failure and retry/reconciliation evidence.

### Deliverable 4 — reproducible reviewer package — $150

- clean-clone instructions;
- one-command regression suite;
- exported transcript, Fiber hash and CKB tx hash;
- `HOW_TO_VERIFY.md` and final report.

## How to verify

```bash
npm install --no-audit --no-fund
npm run verify:all
npm run verify -- transcript.json \
  --receiver-fiber-rpc <RECEIVER_FNN_RPC> \
  --ckb-rpc <CKB_TESTNET_RPC> \
  --require-close \
  --require-fiber \
  --require-ckb
```

A successful funded proof must be independently reproducible from the published transcript and public Testnet identifiers. Screenshots alone are not acceptance evidence.

## Follow-on milestone, outside this Spark request

After the independent proof is complete, integrate the tiny adapter boundary into **one independently maintained CKBuilder application**. A game/device application is a natural first target; the current CKBuilder tracker includes CKB Arcade, Dragon Rush and CKB Geo-Wars, and Geo-Wars already lists Fiber micropayments in its planned architecture.

The integration should remain small (roughly 3–5 application event types). It is evidence that EventMesh is reusable outside its own demo—not a reason to turn EventMesh into a game SDK.

## Scope exclusions

No wallet, spending policy, routing/LSP, liquidity manager, generic x402/paid-HTTP gateway, usage meter, escrow, arbitration, reputation/DID, AI-agent framework, token issuance, multilateral consensus or on-chain storage of every event.

## Public references used for positioning

- Spark 2026 amount clarification: https://talk.nervos.org/t/spark-program-mini-grant-initiative/8752
- Spark scope clarification (Aug 2026): https://talk.nervos.org/t/spark-spark/10576
- Fiber repository: https://github.com/nervosnetwork/fiber
- Fiber v0.9 dev log: https://github.com/nervosnetwork/fiber/discussions/1631
- Gone in 60ms results: https://talk.nervos.org/t/gone-in-60ms-fiber-network-infrastructure-hackathon-results/10671
- CKBuilder project tracker: https://github.com/Nervos-Community-Catalyst/CKBuilder-projects
- CKB Geo-Wars review: https://github.com/Nervos-Community-Catalyst/CKBuilder-projects/issues/23
