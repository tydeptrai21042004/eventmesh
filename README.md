# EventMesh for CKB/Fiber — v0.2 Independent Cross-Operator Proof

EventMesh is an application-neutral **bilateral cross-operator evidence protocol** for CKB/Fiber. Two independently keyed operators exchange signed hash-linked application events, explicitly ACK or reject each other's events, optionally bind receiver-verified Fiber value transfers into the transcript, dual-sign the final state, and publish a compact commitment to CKB for later independent verification.

> EventMesh does **not** replace Fiber payments, wallets, spending permissions, routing, metering, escrow, marketplaces, application logic or consensus.

Read [`docs/ECOSYSTEM_POSITIONING.md`](docs/ECOSYSTEM_POSITIONING.md) for the ecosystem rationale and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the exact v0.2 evidence rules.

## What changed in v0.2

- protocol/signing domain upgraded to `eventmesh-v0.2.0`;
- CKB commitment upgraded to `EVENTMESH_V02`;
- `PAYMENT_SETTLED` binds payment hash + session + amount + currency + optional exact UDT type script;
- receiver-owned `get_invoice` + `Paid` is authoritative for ACCEPT;
- sender `get_payment == Success` is only corroborating evidence;
- verified receiver evidence is persisted for audit/export;
- deterministic `paymentEvidenceRoot` is dual-signed and committed to CKB;
- payment-hash reuse remains globally blocked;
- REJECT ACKs prevent a normal close;
- same-sequence cross-operator proposals are recorded as collisions, not mislabeled equivocation;
- CKB anchors have an explicit PENDING → COMMITTED reconciliation route;
- verifier can independently re-query receiver FNN and CKB;
- tiny `@eventmesh/adapter-sdk` added for real application integration;
- CI, pinned direct dependencies, environment template and broader regression tests added.

## Architecture

```text
Application A                                      Application B
     |                                                  |
 Operator A <------ signed event / signed ACK ------> Operator B
     |                                                  |
   FNN A  ----------- optional Fiber value --------->  FNN B
                                                        |
                                           receiver-owned verification
                         \                              /
                          +------ dual-signed close ---+
                                      |
                      transcriptRoot + finalStateHash
                           + paymentEvidenceRoot
                                      |
                              EVENTMESH_V02
                                      |
                                     CKB
                                      |
                            standalone verifier
```

## Quick start

```bash
cp .env.example .env
npm install --no-audit --no-fund
npm run verify:all
docker compose up --build
node scripts/smoke.mjs
```

Local smoke mode does not require Fiber or CKB funds.

## Full independent verification

```bash
npm run verify -- transcript.json \
  --receiver-fiber-rpc http://RECEIVER_FNN:8237 \
  --ckb-rpc https://YOUR_CKB_TESTNET_RPC \
  --require-close \
  --require-fiber \
  --require-ckb
```

See [`docs/HOW_TO_VERIFY.md`](docs/HOW_TO_VERIFY.md).

## Fiber claim

```json
{
  "paymentHash": "0x...",
  "sessionId": "ses_...",
  "amount": "0x5f5e100",
  "currency": "Fibt",
  "udtTypeScript": {
    "code_hash": "0x...",
    "hash_type": "type",
    "args": "0x..."
  }
}
```

`udtTypeScript` is optional. When present, the receiver must observe and exactly match it; EventMesh does not silently claim UDT verification when the FNN response does not expose the script.

## CKB commitment

```text
EVENTMESH_V02
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
|| paymentEvidenceRoot
```

The verifier derives these bytes itself and accepts the anchor only after CKB reports the transaction as committed and the exact output data is present. The v0.2 commitment is 141 bytes; the CKB adapter therefore enforces the standard secp output occupied-capacity minimum automatically (202 CKB for this exact payload) and defaults to a 220 CKB output margin.

## Important status

**Reference implementation / Testnet validation project. Not audited. Do not use production keys or mainnet funds.**

The next strongest milestone is not another dashboard feature. It is a public proof with two genuinely independent hosts/FNN nodes followed by one small adapter into an independently maintained CKBuilder application.
