# EventMesh for CKB/Fiber — v0.1 Two-Operator Session Proof

EventMesh is a small CKB/Fiber-oriented reference implementation for **cross-operator application sessions**. Two independently keyed nodes maintain separate SQLite databases, exchange signed hash-linked events, explicitly acknowledge each other's events, close on a mutually signed transcript commitment, and can optionally attach Fiber Testnet payments and anchor the final commitment to CKB Testnet.

> **Scope:** EventMesh records what two independent operators explicitly accepted during a session. It is not a consensus protocol, game engine, payment router, wallet, marketplace, or proof that an external physical event was objectively true.

## Architecture and next-step plan

Read **[`docs/PROJECT_BLUEPRINT.md`](docs/PROJECT_BLUEPRINT.md)** before extending the protocol. It defines:

- the project's non-overlap boundary;
- the ideal v0.2 repository structure;
- peer API vs admin API separation;
- session/ACK immutability rules;
- Fiber payment evidence verification;
- CKB anchor verification;
- SSRF/CORS/admin-auth hardening;
- integration-test requirements;
- the v0.1 → v0.2 roadmap.

Security limitations are documented in **[`SECURITY.md`](SECURITY.md)**.

## MVP boundary

Included:

- two independent operator keys and SQLite stores;
- signed ordered events with `previousHash` chaining;
- explicit ACCEPT/REJECT ACKs from the counterparty;
- replay/sequence/previous-hash checks;
- restart persistence through SQLite/WAL;
- transcript root and two close signatures;
- standalone transcript verifier;
- optional Fiber JSON-RPC adapter;
- optional CKB Testnet anchor;
- one-page demo UI and Docker Compose.

Explicitly **not** in v0.1: discovery, marketplace, reputation, multilateral sessions, conditional payments, custom CKB scripts, mobile wallet, AI-agent framework, or mainnet automation.

## Quick start — local mode

Prerequisites: Docker + Docker Compose.

```bash
cp .env.example .env
docker compose up --build
```

Open **http://localhost:3000**.

Local mode requires no CKB and no Fiber funds. Operator A is exposed at `http://localhost:4001`; Operator B at `http://localhost:4002`.

### Smoke test

```bash
node scripts/smoke.mjs
```

This creates a session, exchanges two events + ACKs, and closes the session.

## Independent transcript verification

```bash
npm install
npm run verify -- ./ses_xxx.json
```

With a CKB Testnet RPC URL:

```bash
npm run verify -- ./ses_xxx.json https://your-testnet-ckb-rpc.example
```

## Optional Fiber Testnet integration

EventMesh does not embed or fork FNN. It calls an existing FNN JSON-RPC endpoint.

```env
FIBER_ENABLED=true
OPERATOR_A_FIBER_RPC_URL=http://host.docker.internal:8227
OPERATOR_B_FIBER_RPC_URL=http://host.docker.internal:8237
FIBER_RPC_TOKEN=
```

Then restart:

```bash
docker compose up --build
```

### Important v0.1 security note

The current v0.1 operator still places peer-facing routes and Fiber administrative routes in the same HTTP process. **Do not expose Fiber spending endpoints to untrusted networks.** Keep operator/FNN endpoints behind a trusted firewall or local environment until the v0.1.1 admin-auth/API split in the blueprint is complete.

## Optional CKB Testnet anchor

Only Operator A anchors in v0.1.

```env
CKB_ENABLED=true
CKB_PRIVATE_KEY=<64-hex-testnet-private-key>
CKB_RPC_URL=
CKB_ANCHOR_CAPACITY_CKB=200
```

Use only a Testnet key.

The compact commitment contains:

```text
EVENTMESH_V01 || SHA256(sessionId) || transcriptRoot || finalStateHash
```

No custom lock/type script is required.

## Current API surface

```text
GET  /health
GET  /identity
GET  /sessions
GET  /sessions/:id
GET  /sessions/:id/transcript
POST /sessions
POST /sessions/:id/join
POST /sessions/:id/events
POST /sessions/:id/events/receive
POST /sessions/:id/events/:eventHash/retry
POST /sessions/:id/events/:eventHash/ack
POST /sessions/:id/acks/receive
POST /sessions/:id/close
POST /sessions/:id/close/receive
POST /sessions/:id/anchor/receive

# v0.1 administrative Fiber endpoints — keep private
POST /fiber/new-invoice
POST /fiber/send-payment
GET  /fiber/payments/:paymentHash
```

The target v0.2 API separation is documented in the project blueprint.

## Protocol notes

- Only one event may be pending at a time in v0.1.
- The sender cannot ACK its own event.
- Sequence and `previousHash` must match the local transcript.
- REJECT prevents normal close; v0.1 has no dispute protocol.
- Operator A initiates close in v0.1.
- Operator B independently recomputes the transcript root before signing.
- Keys persist under each operator data directory if no explicit key is supplied.

## Development without Docker

```bash
npm install
npm run dev:a
npm run dev:b
npm run dev:demo
```

## Tests

```bash
npm test
```

The current suite is a protocol-core baseline. The required integration-test matrix for v0.1.1/v0.2 is listed in [`docs/PROJECT_BLUEPRINT.md`](docs/PROJECT_BLUEPRINT.md).

## Project status

**Reference implementation / Testnet-oriented MVP. Not audited. Do not use production keys or mainnet funds.**

## v0.1.1 funding-readiness notes

The hardened patch adds immutable conflict evidence, signature-domain separation, receiver-side Fiber settlement checks, CKB committed-state verification, public-mode/admin controls, and reviewer/funding docs. See `docs/FUNDING_PROPOSAL_DRAFT.md`, `docs/HOW_TO_VERIFY.md`, `docs/THREAT_MODEL.md`, and `CHANGELOG_FUNDING_PATCH.md`.

Do not claim a public independent-host Fiber/CKB proof until a real Testnet payment, committed CKB tx, transcript, and standalone-verifier output have been published.
