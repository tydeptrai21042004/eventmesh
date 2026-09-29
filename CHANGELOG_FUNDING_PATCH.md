# EventMesh v0.2 — CKB/Fiber ecosystem merge patch

This patch is intentionally a **validation/hardening release**, not a product-scope expansion.

## Protocol and evidence

- upgraded the protocol to `eventmesh-v0.2.0` and CKB domain to `EVENTMESH_V02`;
- retained immutable session/event/ACK/close behavior and durable conflict evidence;
- distinguishes cross-operator same-sequence `PROPOSAL_COLLISION` from same-sender equivocation;
- blocks normal close when an event is rejected;
- binds the supplied final state to `finalStateHash`;
- adds deterministic `paymentEvidenceRoot` over accepted canonical Fiber payment claims.

## Fiber

- keeps receiver-owned `get_invoice` + `Paid` as the acceptance authority;
- verifies exact payment hash, session marker, amount and currency;
- verifies the exact UDT type script when one is claimed, rather than carrying an unverified asset field;
- keeps sender `get_payment == Success` only as optional corroboration;
- persists receiver verification evidence and prevents one payment hash from satisfying multiple EventMesh sessions/events.

## CKB

- CKB commitment now covers `SHA256(sessionId)`, `transcriptRoot`, `finalStateHash` and `paymentEvidenceRoot`;
- peer/verifier reconstructs expected commitment bytes locally;
- committed status and exact output data are required;
- adds explicit PENDING -> COMMITTED reconciliation and peer-notification retry.

## Engineering and reviewability

- restores a testable Fastify `buildOperatorApp` application factory;
- separates canonical `/admin/*`, `/peer/*` and minimal public APIs while keeping v0.1 compatibility aliases;
- adds stronger peer URL/SSRF, timeout, redirect, CORS and admin-token controls;
- adds a small `@eventmesh/adapter-sdk` boundary instead of embedding game/device/business semantics in core;
- expands core, Fiber, CKB, store, security and two-operator integration regression tests;
- adds CI, `.env.example`, ecosystem positioning, protocol, threat-model and verification docs.

## Ecosystem scope decision

EventMesh remains a bilateral application-evidence layer above Fiber and CKB. It deliberately does not add wallet permissions, routing/LSP/liquidity, generic paid HTTP, metering, escrow, reputation, marketplace, AI-agent orchestration, token issuance, multilateral consensus or per-event on-chain storage.

## Validation note

The patch is designed for Node 22. In the artifact-generation environment, registry access returned DNS `EAI_AGAIN`, so dependency-backed Vitest/typecheck/build execution could not be completed. Syntax-level TypeScript transpilation, JSON/YAML parsing and archive integrity are checked before packaging. Run `npm install --no-audit --no-fund && npm run verify:all` on a networked machine before tagging or publishing Testnet evidence.
