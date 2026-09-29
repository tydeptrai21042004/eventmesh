# EventMesh v0.2 — Funding-Readiness Changelog

This patch intentionally improves **adoptability, validation, and reviewer evidence** without broadening EventMesh into adjacent CKB/Fiber products.

## Product / demo

- reframed project around cross-operator reconciliation after payment/application partial failures;
- replaced stale v0.1/generic JSON demo with a v0.2 guided paid-service scenario;
- added real receiver-invoice → sender-payment → receiver-FNN-verification UI path;
- added evidence-summary UI, CKB lifecycle controls, transcript export, and safe replay/retry failure lab.

## Application semantics

- added `paidServiceReferenceAdapter`;
- validates ordered event workflow and cross-event `requestId`/session invariants;
- derives deterministic final state;
- standalone verifier accepts `--adapter paid-service-reference` and checks close-state equivalence.

## Reviewer evidence

- added `/admin/sessions/:id/evidence-summary`;
- added strict grant-closure evidence manifest checker;
- requires external integration, restart/no-manual-edit/exactly-once statements, and validation-interview conclusion;
- added adopter integration guide and funding-readiness checklist.

## Operations / reproducibility

- added environment template and ignore files;
- pinned Docker runtime to Node 22.16.0;
- added CI workflow;
- gave Operator B CKB RPC verification access while keeping anchor broadcasting disabled on B;
- updated smoke script to canonical v0.2 admin routes and evidence-summary assertions.

## Funding / ecosystem positioning

- changed the proposal into a $1,000 validation milestone;
- moved one independently maintained application integration inside funded scope;
- made receiver restart/lost-response recovery the primary proof;
- documented non-overlap with Fiber, Clasp, FiberLatch Access, Myelin, and generic event buses;
- added continue/narrow/stop criteria instead of assuming demand.

## Intentionally not added

No wallet permissions, Fiber routing/LSP/liquidity, metering, generic paid HTTP, access tokens, escrow, marketplace, reputation, DID, AI-agent framework, arbitration, custom token, custom CKB script, on-chain event log, or multilateral consensus.
