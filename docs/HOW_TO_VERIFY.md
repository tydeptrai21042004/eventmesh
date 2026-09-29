# How to Verify EventMesh v0.1.1

## Local repository checks

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Evidence invariants

Check that tests cover: closed-session replay, session-ID conflict, ACK equivocation, competing sequence events, payment-hash reuse, invalid/outstanding Fiber invoice, wrong session binding, and CKB transactions that are not committed or contain the wrong data.

## Standalone transcript verification

```bash
npm run verify -- transcript.json https://testnet.ckbapp.dev/
```

The verifier independently checks signatures, participants, sequence/hash chain, ACK signers, transcript root, Fiber payment set, final-state hash, both close signatures, conflict evidence, recomputed CKB bytes, and (when RPC is supplied) committed-chain status.

## Funding milestone evidence

For the strongest proof, deploy operator A and B separately with different keys, SQLite databases and FNN nodes. Publish one sanitized transcript, Fiber payment hash, CKB Testnet transaction hash, verifier output, deployment diagram and short demo video.
