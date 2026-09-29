# EventMesh v0.2 Final CKB/Fiber Merge — Patch Notes

**Baseline:** `eventmesh-main (1)(1).zip`  
**Patch type:** changed/new files only  
**Goal:** preserve the strongest parts of the uploaded baseline while merging the earlier protocol/security/reproducibility hardening and the current CKB/Fiber ecosystem direction.

## Final project identity

EventMesh is a **bilateral cross-operator application-evidence protocol** above Fiber and CKB. It is not a wallet, payment gateway, routing/LSP product, metering system, escrow platform or generic blockchain event bus.

Two independently operated applications exchange signed hash-linked events and explicit ACK/REJECT decisions. Optional Fiber-linked value is accepted only after receiver-owned verification. Both operators sign one final transcript/state commitment, and a compact commitment is published to CKB for later independent verification.

## What was retained from the uploaded baseline

- receiver-owned Fiber `get_invoice` verification;
- hash + session + amount + currency binding;
- payment-hash reuse protection;
- final-state body/hash binding;
- payment-claim/evidence persistence;
- committed-state CKB verification;
- admin token, CORS and SSRF-oriented controls.

## What was restored/merged from the stronger v0.2 hardening direction

- readable/testable `buildOperatorApp` application factory;
- canonical `/admin/*` and `/peer/*` API namespaces;
- stronger signature-domain/version separation;
- immutable session/event/ACK/close and durable conflict evidence;
- HTTP two-operator integration tests with separate SQLite stores;
- store/security/Fiber/CKB regression suites;
- independent standalone verifier modes;
- CI, environment template and reproducible reviewer documentation.

## New final changes

- protocol upgraded to `eventmesh-v0.2.0`;
- CKB commitment upgraded to `EVENTMESH_V02`;
- optional UDT claim now binds an exact CKB type script and must be observed by the receiver;
- `paymentEvidenceRoot` commits the canonical accepted payment claims, including amount/currency/session/UDT context;
- CKB output commits `SHA256(sessionId) + transcriptRoot + finalStateHash + paymentEvidenceRoot`;
- CKB lifecycle explicitly distinguishes PENDING from independently verified COMMITTED;
- CKB anchor capacity now accounts for the larger 141-byte v0.2 commitment automatically (minimum 202 CKB for the standard secp lock; 220 CKB default);
- sender payment status is corroboration only, never a substitute for receiver invoice verification;
- cross-operator same-sequence proposals are labelled `PROPOSAL_COLLISION`, not sender equivocation;
- rejected events cannot enter a normal dual-signed close;
- tiny `@eventmesh/adapter-sdk` added for future external application integration without contaminating core with game/device/business logic.

## Current ecosystem decision

Fiber v0.9 and the July 2026 infrastructure hackathon show that wallets/payment UX, routing/diagnostics, merchant infrastructure, liquidity/LSP and related Fiber infrastructure are already active areas. EventMesh therefore stays one layer higher: **what application events did two independent operators mutually accept, including independently verified value-linked events?**

The first external integration should come **after** the independent Testnet proof. A small adapter into one independently maintained CKBuilder game/device/service is sufficient; do not build another EventMesh-owned product just to demonstrate reuse.

## Funding-scope adjustment

The bundled Spark draft is reduced to a **$1,000 validation milestone**: two independent hosts/FNN nodes, one real Fiber Testnet payment, one dual-signed close, one committed CKB Testnet anchor, failure/recovery evidence, and reproducible verification. External application integration is kept as a follow-on milestone.

## Apply and verify

See `APPLY_PATCH.md` and `docs/HOW_TO_VERIFY.md`.
