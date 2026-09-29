# Spark Program | EventMesh for CKB/Fiber

## Project overview

**EventMesh for CKB/Fiber** is an application-neutral bilateral session-evidence layer. Two independently keyed operators keep separate durable stores, exchange signed/hash-linked events, record explicit ACCEPT/REJECT decisions, and close on one mutually signed transcript commitment. Fiber remains the payment rail; CKB remains the durable commitment layer.

The gap EventMesh addresses is not payment routing: applications that use Fiber may still need a portable answer to **which application events were exchanged, which were accepted/rejected, and which accepted payment event belongs to the session**.

## Current implementation

Already implemented in this repository:

- separate operator keys and SQLite/WAL stores;
- domain-separated session/event/ACK/close signatures;
- immutable/idempotent session, event, ACK and close evidence;
- conflict/equivocation retention with `DISPUTED` state;
- strict cross-session checks;
- receiver-side Fiber invoice verification for `PAYMENT_SETTLED`;
- one payment hash bound to one exact event/session;
- compact CKB Testnet commitment;
- independent CKB `get_transaction` verification requiring `committed` + exact output data;
- standalone transcript verifier;
- admin-token/public-mode and peer-URL hardening;
- CI/config/reviewer documentation.

## Funding target

**Request: USD 2,000 equivalent under Spark.** The March 2026 clarification keeps the overall Spark ceiling at $2,000 and asks requests above $1,000 to justify their added structural complexity. EventMesh's next milestone needs two independent operators, two FNN endpoints, a real payment, CKB commitment verification, failure evidence, and a reusable proof package.

### Milestone 1 — independent-host Testnet proof — $700

- deploy A and B independently with TLS, separate keys/DBs/FNN endpoints;
- execute one real Fiber Testnet payment bound to an EventMesh session;
- publish payment hash, transcript and receiver-side `Paid` invoice evidence;
- publish committed CKB Testnet anchor and standalone verifier output.

### Milestone 2 — failure/reconciliation proof — $450

- publish replay, conflicting ACK, same-sequence event, wrong-session and false-anchor tests;
- demonstrate restart/retry without regenerating signed evidence;
- clean-clone reproduction instructions.

### Milestone 3 — public operator hardening — $450

- split/administer public vs operator-facing surfaces more strictly;
- rate limiting and structured conflict/audit logs;
- deployment/runbook and peer-key pinning guidance.

### Milestone 4 — reusable integration example + community review — $400

- small client/testkit and one application adapter;
- CKBuilder review with proof artifacts;
- tagged release, changelog and final report.

## Verification

Reviewers should be able to verify deliverables without trusting screenshots:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run verify -- transcript.json <CKB_TESTNET_RPC>
```

For the funded milestone, publish the exact transcript JSON, Fiber payment hash, CKB tx hash, deployment evidence and verifier output.

## Scope boundaries

Not included: custom token, marketplace, discovery, wallet, Fiber routing replacement, multilateral consensus, mainnet custody, or proof that an external sensor/application statement is objectively true.

## Team

Project owner: **Dang Ba Ty / @tydeptrai21042004**

Repository: `https://github.com/tydeptrai21042004/eventmesh`

## 2026 Spark submission route

Post the final proposal on **Nervos Talk** with the `Spark-Program` tag and title format `Spark Program | EventMesh for CKB/Fiber`. Add Discord/email contact details and public Testnet links when available. Do not claim the independent-host milestone until the artifacts are public.
