# How to Verify EventMesh v0.2

## A. Repository checks

Use Node 22:

```bash
npm install --no-audit --no-fund
npm run verify:all
```

This runs type checking, unit/regression tests and the demo build.

## B. Local two-operator proof

```bash
cp .env.example .env
docker compose up --build
node scripts/smoke.mjs
```

The smoke script creates a bilateral session, exchanges application events and ACKs, closes the transcript and writes a transcript JSON path.

## C. Offline transcript verification

```bash
npm run verify -- /path/to/transcript.json --require-close
```

The verifier checks:

- domain-separated session signatures;
- event signatures and hashes;
- participant identities;
- contiguous sequence and `previousHash` chain;
- counterparty ACK signatures;
- payment-hash reuse;
- deterministic transcript root;
- deterministic `paymentEvidenceRoot`;
- final-state hash;
- both close signatures;
- locally reconstructed `EVENTMESH_V02` bytes;
- recorded conflict evidence.

Offline verification proves signed evidence consistency. It does **not** independently prove a live Fiber invoice or committed CKB transaction.

## D. Receiver-owned Fiber verification

For the strongest proof, point the verifier at the receiver's independent FNN:

```bash
npm run verify -- transcript.json \
  --receiver-fiber-rpc http://RECEIVER_FNN:8237 \
  --require-close \
  --require-fiber
```

For every accepted `PAYMENT_SETTLED`, it queries `get_invoice` and requires `Paid`, exact hash, amount, currency, `eventmesh:<sessionId>` binding, and exact UDT script when one is claimed.

A sender-side `get_payment == Success` is not sufficient.

## E. CKB committed-state verification

```bash
npm run verify -- transcript.json \
  --ckb-rpc https://YOUR_CKB_TESTNET_RPC \
  --require-close \
  --require-ckb
```

The verifier derives the expected commitment locally and requires the supplied transaction to be committed and contain that exact output data.

## F. Full funding-grade command

```bash
npm run verify -- transcript.json \
  --receiver-fiber-rpc http://RECEIVER_FNN:8237 \
  --ckb-rpc https://YOUR_CKB_TESTNET_RPC \
  --require-close \
  --require-fiber \
  --require-ckb
```

Expected high-level result:

```text
EventMesh v0.2 Independent Verification
[PASS] offline transcript invariants
[PASS] close present and covered by offline signature/root checks
[PASS] Fiber receiver evidence 0x...
[PASS] CKB commitment bytes locally derived
[PASS] CKB RPC COMMITTED
RESULT: VERIFIED
```

## G. Independent-host acceptance proof

Do not call the project independently proven until the public evidence shows:

- operator A and B on separate hosts;
- different private keys;
- different SQLite files;
- different FNN nodes;
- a real Fiber Testnet invoice/payment;
- receiver-owned `Paid` verification;
- a dual-signed close;
- a committed CKB Testnet transaction;
- transcript JSON;
- successful full verifier output.
