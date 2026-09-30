# Spark Program | EventMesh for CKB/Fiber — Cross-Operator Reconciliation Validation

_Last updated: 2026-09-29._

> Draft status: technically prepared, but the applicant contact fields and the independent integration target must be filled before submission. See `FUNDING_READINESS_CHECKLIST.md`.

## 1. Project Overview

**Project name:** EventMesh for CKB/Fiber *(working name; public rebrand planned to avoid confusion with Apache EventMesh)*

**One-sentence summary:** EventMesh tests whether two independently operated Fiber applications can recover from payment/application partial failures by explicitly reconciling the exact signed business events and payment-linked state they both accepted, then checkpointing the final proof to CKB.

**Project type:** Open-source CKB/Fiber application infrastructure / validation prototype.

### Problem

Fiber can prove payment state, but it does not by itself prove which **application event** two independent operators both accepted around that payment.

Example failure:

```text
Fiber payment = Paid
Operator A = service completed
Operator B = uncertain because response/process failed
```

After a retry, teams must decide whether the business action already happened, whether a payment hash is being reused, and whose database is authoritative.

### Solution

EventMesh keeps the operators independent while creating a shared, verifiable evidence boundary:

```text
signed application event
→ exact counterparty ACCEPT / REJECT
→ optional receiver-owned Fiber payment verification
→ immutable conflict/replay evidence
→ dual-signed final state
→ compact CKB checkpoint
→ independent verifier
```

EventMesh does **not** replace Fiber payments, wallet authority, access control, application execution, routing/LSPs, escrow, arbitration, marketplaces, or consensus.

## 2. Team Profile

Fill these before submission; do not invent them in the public proposal.

- **Applicant:** [ADD PUBLIC NAME]
- **Role:** [ADD ROLE]
- **GitHub:** [ADD VERIFIED GITHUB IDENTITY]
- **Discord:** [ADD DISCORD]
- **Email:** [ADD EMAIL]
- **Repository:** [ADD FINAL PUBLIC REPOSITORY]
- **Demo/video:** [ADD IF AVAILABLE]

## 3. Why This Is a CKB/Fiber Gap Worth Testing

The August 2026 ecosystem report **"AI, machine payments, and Fiber in 2026: an opportunity map for CKB and Fiber developers"** categorizes **CGE — cross-operator game/device events** as a *frontier hypothesis*: technical examples exist, but the user/trust model still needs evidence.

That is exactly the maturity level of this proposal. The project does **not** claim a proven large market. The Spark milestone is designed to produce the missing evidence through an independent adopter, a real Fiber payment, a restart/retry boundary, and a reproducible CKB proof.

Source:
- https://talk.nervos.org/t/ai-machine-payments-and-fiber-in-2026-an-opportunity-map-for-ckb-and-fiber-developers/10665

Fiber v0.9 itself has focused heavily on durable payment recovery, reconciliation, reconnect behavior, and operational safety. EventMesh deliberately works **above** that layer: payment lifecycle remains Fiber's responsibility; application-state reconciliation remains EventMesh's experiment.

References:
- https://github.com/nervosnetwork/fiber/discussions/1610
- https://github.com/nervosnetwork/fiber/discussions/1631

## 4. Relationship With Existing Ecosystem Projects

This distinction is a funding requirement, not marketing decoration.

| Existing layer/project | What it already solves | EventMesh does not duplicate it |
| --- | --- | --- |
| Fiber | channels, invoices, routing, payment lifecycle/recovery | no payment protocol/router/LSP |
| Clasp | scoped/revocable wallet sessions, spending limits and policy | no wallet permissions or delegated spending |
| FiberLatch Access | signed access receipts after a host trusts a payment/business decision | no resource access/redemption tokens |
| Myelin | off-chain CKB-style execution/session runtime, state/finality/dispute evidence | no VM execution, court, finality or consensus |
| EventMesh experiment | exact bilateral application acceptance + payment-linked reconciliation | stays narrowly at the operator/application evidence boundary |

References:
- Clasp: https://github.com/Enoch208/Clasp
- FiberLatch Access: https://talk.nervos.org/t/dis-fiberlatch-access-open-source-access-control-for-fiber-payments/10414
- Myelin: https://talk.nervos.org/t/introducing-myelin-a-ckb-aligned-off-chain-cell-session-runtime/10498

Spark has publicly rejected proposals it considered redundant with existing ecosystem coverage, including CellKit Actions relative to CCC and a CKB NFT marketplace relative to Omiga. This proposal therefore makes the non-overlap and independent-adoption test explicit.

References:
- https://talk.nervos.org/t/spark-program-cellkit-actions-reusable-transaction-actions-for-ckb-apps/10375
- https://talk.nervos.org/t/spark-program-ckb-nft-marketplace-on-chain-digital-object-trading-platform/10544

## 5. Current State Before Funding

Already implemented in the repository:

- two separate secp256k1 operator identities and atomic JSON-file stores;
- domain-separated session/event/ACK/close signatures;
- hash-linked signed application events;
- exact counterparty ACCEPT/REJECT acknowledgements;
- idempotent duplicate handling and durable conflicts/equivocation evidence;
- proposal-collision classification;
- receiver-owned Fiber invoice verification for `PAYMENT_SETTLED`;
- session/hash/amount/currency and optional exact UDT script binding;
- global payment-hash reuse protection;
- deterministic `paymentEvidenceRoot`;
- dual-signed close over transcript/final/payment evidence roots;
- `EVENTMESH_V02` CKB commitment;
- explicit CKB PENDING → COMMITTED reconciliation;
- independent CKB `get_transaction` verification;
- standalone offline/Fiber/CKB verifier;
- machine-readable evidence-summary endpoint;
- guided paid-service demo and safe replay/failure lab;
- adapter SDK with a reference paid-service adapter;
- verifier support for optional reference application-semantic validation;
- CI/config/reviewer-evidence templates and an independent-adopter integration guide.

The grant is therefore **not** for building an idea from zero. It is for obtaining the external and operational evidence the project currently lacks.

## 6. Funded Validation Hypothesis

> Can one independently maintained CKB/Fiber application use a small EventMesh adapter so that, after a real Fiber payment and receiver restart/lost response, both operators recover to exactly one mutually accepted business transition without a shared database or manual state edit—and can a third party verify the final proof from Fiber/CKB evidence?

If the answer is no, the final report should say why. A falsified hypothesis is more useful than expanding the protocol without adoption evidence.

## 7. Expected Deliverables and Budget

**Requested funding: USD 1,000 equivalent.**

This stays at Spark's normal small-validation scale. The current Spark rules allow higher requests with justification, but this proposal does not need the exception.

Spark reference:
- https://talk.nervos.org/t/spark-program-mini-grant-initiative/8752

### Deliverable 1 — Independent application integration — $250

- choose one CKB/Fiber application/service maintained independently from EventMesh;
- integrate a small adapter (target: 3–5 event types);
- publish repository + exact PR/commit;
- measure files/LOC/setup steps;
- record maintainer feedback on whether the problem is real and whether the integration cost is acceptable.

**Acceptance:** an EventMesh-owned mock does not satisfy this deliverable.

### Deliverable 2 — Real Fiber partial-failure and recovery proof — $300

Deploy:

```text
Host A                    Host B
Operator A                Operator B
JSON state A              JSON state B
EventMesh key A           EventMesh key B
FNN A                     FNN B
```

Execute:

```text
business request/result
→ receiver-created Fiber invoice
→ real Testnet payment
→ receiver FNN = Paid
→ stop receiver before application settlement ACK completes
→ restart from same durable store
→ retry settlement
→ receiver re-queries own FNN
→ exactly one accepted payment-linked transition
```

Publish logs and state before/after restart. **No manual database edit.**

### Deliverable 3 — CKB checkpoint + independent verifier — $250

- dual-signed close with transcript/final/payment-evidence roots;
- publish `EVENTMESH_V02` commitment to CKB Testnet;
- reconcile PENDING → COMMITTED;
- make the peer independently verify exact output data from CKB RPC;
- publish transaction hash + transcript;
- reproduce `RESULT: VERIFIED` on a fresh environment using independent receiver FNN + CKB RPC.

### Deliverable 4 — Problem validation and reproducible closure package — $200

- 3–5 structured interviews/use-tests with relevant CKB/Fiber builders;
- record positive and negative responses;
- report whether normal idempotency/webhooks would already solve their problem;
- publish measured operational metrics;
- publish the funding evidence manifest, transcript, commands, failure log, external integration reference, and final conclusions.

## 8. Four-Week To-Do List

### Week 1 — Independent adopter and adapter

- select/confirm independent integration target;
- agree on one concrete state-mismatch failure;
- map 3–5 application events;
- integrate adapter;
- record baseline behavior without EventMesh.

**Milestone:** external repository contains working adapter path.

### Week 2 — Fiber and restart recovery

- deploy independent operator/FNN environments;
- execute real Testnet invoice/payment;
- reproduce receiver restart/lost-response boundary;
- verify exactly-once accepted application transition after retry;
- publish measured recovery results.

**Milestone:** real payment + failure/recovery evidence.

### Week 3 — CKB proof and fresh-machine verification

- dual-sign final state;
- broadcast CKB commitment;
- reconcile committed state;
- independently verify from peer and standalone verifier;
- assemble evidence manifest/transcript/commands.

**Milestone:** public Testnet proof returning `RESULT: VERIFIED`.

### Week 4 — User validation and closure report

- complete 3–5 structured builder interviews/use-tests;
- publish integration cost + operational metrics;
- document objections/negative feedback;
- decide continue / narrow / stop according to the criteria in `MARKET_GAP_AND_VALIDATION.md`;
- publish final Spark report and evidence package.

**Milestone:** evidence-based conclusion, not only code completion.

## 9. How the Committee Can Verify It

Repository checks:

```bash
cp .env.example .env
npm install --no-audit --no-fund
npm run verify:all
docker compose up --build
npm run smoke
```

Funding evidence consistency:

```bash
npm run evidence:check -- artifacts/funding-evidence/manifest.json
```

Independent proof:

```bash
npm run verify -- artifacts/funding-evidence/transcript.json \
  --adapter paid-service-reference \
  --receiver-fiber-rpc <RECEIVER_FNN_RPC> \
  --ckb-rpc <CKB_TESTNET_RPC> \
  --require-close \
  --require-fiber \
  --require-ckb
```

Expected final output:

```text
Funding evidence package: STRUCTURE PASS
RESULT: VERIFIED
```

Screenshots alone are not acceptance evidence.

## 10. Relevance to CKB

EventMesh uses CKB/Fiber properties as an integrated verification loop:

```text
CKB/UDT value
→ Fiber payment
→ receiver-owned payment verification
→ mutually accepted application event
→ dual-signed transcript/final state
→ compact CKB checkpoint
→ independent verification
```

CKB is not used as a decorative hash store. It provides the durable public checkpoint for a proof formed by independently operated parties, while high-frequency application interaction stays off-chain.

The experiment is especially relevant because the ecosystem opportunity map already identifies cross-operator game/device events as a Fiber/CKB-linked frontier where user/trust-model evidence is missing.

## 11. User Testing / Evaluation Criteria

The project succeeds only if the final report can answer:

1. Did an external builder recognize the stated partial-failure problem?
2. Could the adapter remain small?
3. Did the restart/retry proof remove ambiguity without a shared DB?
4. Did it prevent duplicate payment-linked acceptance?
5. Was third-party verification useful?
6. Did the CKB checkpoint add value beyond the dual-signed transcript?
7. What should **not** be built next?

Negative feedback must be preserved.

## 12. Open Source Commitment

- license: MIT;
- all funded code, docs, tests, and verification scripts published openly;
- evidence package excludes secrets/private keys;
- public final report includes exact commits, test commands, Fiber payment hash, CKB transaction hash, and limitations.

## 13. Scope Exclusions

No:

- wallet/spending authority;
- Fiber routing/LSP/liquidity manager;
- generic x402/paid-HTTP gateway;
- access receipt/redemption system;
- generic usage metering;
- escrow/milestones/arbitration;
- provider marketplace/reputation/DID;
- AI agent framework;
- application VM/runtime/finality court;
- custom token;
- multilateral consensus;
- per-event on-chain storage.

Those exclusions are part of the differentiation strategy.

## 14. Risks and Honest Limitations

- the market need is not yet proven;
- the current code is a Testnet reference implementation and is not audited;
- one external integration cannot establish broad market demand;
- CKB per-session commitment capacity may be too expensive for high-volume production; batching is a future optimization only if adoption justifies it;
- the current working name conflicts with Apache EventMesh and should be changed before broad launch;
- a transitive dependency lockfile still needs to be generated/committed from a networked npm environment before the final reproducibility claim is complete.

## 15. Primary Public References

- Spark Program rules/template: https://talk.nervos.org/t/spark-program-mini-grant-initiative/8752
- Spark Q2 2026 verification/budget observations: https://talk.nervos.org/t/spark-program-q2-2026-what-the-ecosystem-is-building/10396
- CKB/Fiber opportunity map: https://talk.nervos.org/t/ai-machine-payments-and-fiber-in-2026-an-opportunity-map-for-ckb-and-fiber-developers/10665
- Fiber v0.9 reliability/recovery: https://github.com/nervosnetwork/fiber/discussions/1610
- Fiber post-v0.9 direction: https://github.com/nervosnetwork/fiber/discussions/1631
- Fiber public-node invoice/payment examples: https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md
- Clasp: https://github.com/Enoch208/Clasp
- FiberLatch Access: https://talk.nervos.org/t/dis-fiberlatch-access-open-source-access-control-for-fiber-payments/10414
- Myelin: https://talk.nervos.org/t/introducing-myelin-a-ckb-aligned-off-chain-cell-session-runtime/10498
- CellKit Actions rejection/differentiation example: https://talk.nervos.org/t/spark-program-cellkit-actions-reusable-transaction-actions-for-ckb-apps/10375
- CKB NFT Marketplace rejection/coverage example: https://talk.nervos.org/t/spark-program-ckb-nft-marketplace-on-chain-digital-object-trading-platform/10544
