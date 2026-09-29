# EventMesh v0.2 Final Blueprint

## Product identity

EventMesh is a reusable bilateral evidence layer between independent application operators on CKB/Fiber.

```text
applications
    |
EventMesh
    |\
    | \-- Fiber: optional value transfer + receiver verification
    |
    \---- CKB: compact durable final commitment
```

The project is intentionally application-neutral and deliberately avoids duplicating wallet/payment/routing/escrow infrastructure.

## v0.2 architecture decisions

### Keep in core

- `SignedSession`;
- `SignedEvent`;
- `SignedAck`;
- `SignedClose`;
- deterministic hash chain and transcript root;
- deterministic Fiber claim root;
- standalone verification.

### Keep as adapters

- Fiber JSON-RPC;
- CKB/CCC anchoring;
- application semantics (`@eventmesh/adapter-sdk`).

### Keep outside EventMesh

Wallet permissions, x402 gateways, generic metering, routing/LSP/liquidity, escrow, marketplaces, reputation, DID, AI-agent orchestration, token issuance and multilateral consensus.

## Evidence model

```text
A proposes signed event
        |
        v
B validates application semantics
        |
        +-- if PAYMENT_SETTLED:
        |      B -> own FNN -> get_invoice
        |      verify Paid/hash/amount/currency/session/UDT
        |
        v
B signs ACCEPT ACK
        |
        v
both stores contain same final event + ACK
```

Payment claims are then Merkleized into `paymentEvidenceRoot`, so the CKB commitment covers the complete claimed economic context rather than only payment hashes.

## CKB commitment

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

No custom CKB script is required for this validation milestone. A custom script should be considered only if a later application requires on-chain enforcement rather than evidence anchoring.

## Repository direction

```text
apps/
  operator/
  verifier/
  demo/
packages/
  core/
  fiber/
  ckb/
  adapter-sdk/
tests/
  core.test.ts
  fiber.test.ts
  ckb.test.ts
  store.test.ts
  security.test.ts
  operator.integration.test.ts
docs/
  PROTOCOL.md
  THREAT_MODEL.md
  HOW_TO_VERIFY.md
  ECOSYSTEM_POSITIONING.md
```

The operator now exposes a `buildOperatorApp` application factory, so HTTP-level bilateral integration tests can run with ephemeral ports and separate SQLite stores without spawning shell processes. The next structural work should be operational rather than architectural: independent-host deployment, real FNN evidence, and CKB reconciliation measurements.

## Milestones

### M1 — protocol/evidence hardening (implemented in this patch)

- v0.2 domain and commitment;
- rich Fiber claim;
- receiver-owned verification;
- exact optional UDT verification;
- payment reuse protection;
- payment evidence persistence/root;
- rejected-event close prevention;
- independent CKB verification/reconciliation;
- stronger verifier/tests/CI.

### M2 — real Fiber Testnet proof

Publish invoice/payment hash and a sanitized transcript showing receiver-owned `Paid` verification.

### M3 — real CKB Testnet proof

Publish committed tx hash and standalone verifier output.

### M4 — independent hosts

A and B must use separate machines, keys, stores and FNN nodes.

### M5 — one external CKBuilder application adapter

Integrate only 3–5 meaningful game/device/service event types. Avoid creating another EventMesh-owned application solely for the demo.

### M6 — reliability measurements

Measure delivery retry, process restart, temporary FNN failure, temporary CKB RPC failure and anchor-notification recovery. Publish the failures and recovery behavior rather than only screenshots.
