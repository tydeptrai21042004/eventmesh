# How to Verify EventMesh v0.2

Verification is intentionally split into layers so a reviewer can tell the difference between **local signed consistency**, **receiver-owned Fiber evidence**, and **committed CKB evidence**.

## A. Repository checks

Use Node `22.16.x`:

```bash
npm install --no-audit --no-fund
npm run verify:all
```

This runs type checking, unit/integration tests, and workspace builds.

> Reproducibility note: direct dependencies are pinned. Before the final funding submission, generate and commit `package-lock.json` from a networked Node 22/npm 10 environment and switch CI/Docker to `npm ci`.

## B. Local bilateral proof

```bash
cp .env.example .env
docker compose up --build
npm run smoke
```

The smoke script:

1. creates a session between independent operator identities/stores;
2. exchanges signed paid-service-style application events;
3. explicitly ACCEPTs each event;
4. replays an ACK and requires idempotent handling;
5. dual-signs a close;
6. checks the machine-readable evidence summary;
7. exports a transcript to `/tmp`.

Local smoke intentionally skips Fiber and CKB. It must never be presented as the full funding proof.

## C. Inspect the evidence summary

```bash
curl http://localhost:4001/admin/sessions/<SESSION_ID>/evidence-summary
```

Important fields:

- `operators.bilateralSessionSigned`;
- `events.accepted` / `events.pending`;
- `payments.acceptedClaims` / `payments.receiverEvidence`;
- `conflicts.count`;
- `close.dualSigned`;
- `ckb.anchorStatus`;
- `readiness.*`.

The summary is a reviewer convenience. It is generated from one operator's durable store, so it does **not** replace the standalone verifier.

## D. Offline transcript verification

```bash
npm run verify -- /path/to/transcript.json --require-close
```

The verifier checks:

- domain-separated session signatures;
- event signatures and hashes;
- participant identities;
- contiguous sequence and `previousHash` chain;
- exact counterparty ACK signatures;
- payment-hash reuse rules;
- deterministic transcript root;
- deterministic `paymentEvidenceRoot`;
- final-state hash;
- both close signatures;
- locally reconstructed `EVENTMESH_V02` bytes;
- recorded conflict evidence.

Offline verification proves signed evidence consistency. It does **not** independently prove a live Fiber invoice or committed CKB transaction.

## E. Receiver-owned Fiber verification

For the funding-grade path, receiver B creates the invoice and later ACCEPTs `PAYMENT_SETTLED` only after querying its own FNN.

```bash
npm run verify -- transcript.json \
  --receiver-fiber-rpc http://RECEIVER_FNN:8237 \
  --require-close \
  --require-fiber
```

For every accepted `PAYMENT_SETTLED`, the verifier requires:

- receiver `get_invoice` status `Paid`;
- exact payment hash;
- exact amount;
- exact currency;
- exact `eventmesh:<sessionId>` description marker;
- exact UDT type script when one is claimed.

A sender-side `get_payment == Success` is corroboration only and is never sufficient for EventMesh acceptance.

## F. Required restart/lost-response test

This is the market-pain proof, not an optional stress test.

1. create the paid-service session;
2. receiver B creates the Fiber invoice;
3. A pays it;
4. confirm B's FNN can report `Paid`;
5. stop B **before** the application settlement ACK is completed/delivered;
6. restart B against the same durable SQLite volume;
7. retry the settlement path;
8. B re-queries its own FNN;
9. verify only one payment-linked EventMesh event becomes canonical;
10. record that no manual DB edit was needed.

Publish commands/logs and state before/after restart.

## G. CKB committed-state verification

The Docker topology passes `CKB_RPC_URL` to Operator B even though only A broadcasts. This is intentional: B must be able to independently verify the anchor.

```bash
npm run verify -- transcript.json \
  --ckb-rpc https://YOUR_CKB_TESTNET_RPC \
  --require-close \
  --require-ckb
```

The verifier derives the expected commitment locally and requires the supplied transaction to be committed and contain the exact expected output data.

## H. Full funding-grade command

```bash
npm run verify -- transcript.json \
  --adapter paid-service-reference \
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

## I. Funding evidence bundle

Copy `docs/evidence/manifest.example.json` to:

```text
artifacts/funding-evidence/manifest.json
```

Put the published transcript beside it and fill real identifiers. Then run:

```bash
npm run evidence:check -- artifacts/funding-evidence/manifest.json
```

This checks that the manifest session/payment/CKB identifiers are structurally consistent with the transcript. It does not perform live network verification; run the standalone verifier afterward.

## J. Independent-host acceptance proof

Do not call the project independently proven until public evidence shows:

- an external application/repository not owned by EventMesh;
- operator A and B on separate hosts/administrative environments;
- different private keys;
- different SQLite stores;
- different FNN nodes/credentials;
- a real Fiber Testnet payment;
- receiver-owned `Paid` verification;
- a real process restart or lost-response boundary;
- recovery without manual DB editing;
- exactly one accepted payment-linked transition;
- a dual-signed close;
- a committed CKB Testnet transaction;
- transcript + evidence manifest;
- successful fresh-machine full verifier output.

## Application-semantic verification

For the bundled paid-service reference profile, add `--adapter paid-service-reference`. The verifier then validates the exact event order/cross-event invariants and checks that a present close `finalState` equals the deterministic adapter-derived state. This is optional for generic EventMesh transcripts; external integrations should add their own adapter validation rather than putting business logic into core.
