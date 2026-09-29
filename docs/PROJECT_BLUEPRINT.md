# EventMesh Project Blueprint

**Status:** architecture target for v0.2+ while preserving the current v0.1 MVP.

**Repository:** `tydeptrai21042004/eventmesh`

## 1. Project definition

EventMesh is a CKB/Fiber-oriented **two-operator session layer**. Two independently keyed operators keep separate durable stores, exchange signed and hash-linked application events, explicitly acknowledge each event, and produce a mutually signed transcript commitment. Fiber can be attached as an existing value-transfer rail; CKB can be used as a compact durable commitment layer.

The project should remain narrow:

> EventMesh records what two independent operators mutually accepted during a session. It does not replace Fiber payments, wallets, marketplaces, discovery, consensus, or application-specific game/device logic.

This positioning is important because the current CKB/Fiber opportunity map already identifies **cross-operator game/device events (CGE)** as a frontier hypothesis. EventMesh should therefore present itself as a deployable, application-neutral implementation of that emerging direction, not as the invention of the underlying idea.

## 2. Core non-overlap boundary

EventMesh must own only this layer:

```text
Operator A                         Operator B
    │                                  │
    │ signed application event         │
    ├─────────────────────────────────►│
    │                                  │
    │        signed ACK/REJECT          │
    │◄─────────────────────────────────┤
    │                                  │
    │ optional Fiber value transfer    │
    ├═════════════════════════════════►│
    │                                  │
    └──── mutually signed close ───────┘
                       │
                       ▼
                 CKB commitment
```

EventMesh does **not** own:

- provider discovery or routing;
- spending authorization policies;
- conditional-payment primitives;
- wallet/key UX;
- payment-channel recovery internals;
- game rules or anti-cheat;
- marketplace/reputation systems;
- generic metering;
- multilateral clearing.

That keeps the project distinct from FiberPass, routed machine-payment sessions, Fiber Weir, wallets/mobile clients, Fiber reliability tooling, and game-specific frameworks.

## 3. Current v0.1 layout

The repository is intentionally small today:

```text
eventmesh/
├── apps/
│   ├── demo/
│   ├── operator/
│   └── verifier/
├── packages/
│   ├── core/
│   ├── fiber/
│   └── ckb/
├── scripts/
├── tests/
├── docker-compose.yml
├── Dockerfile.demo
├── Dockerfile.operator
└── README.md
```

This is acceptable for v0.1, but `apps/operator/src/index.ts` already owns routing, peer transport, session lifecycle, Fiber administration, and CKB anchor notification. The next release should separate those responsibilities **without changing the protocol semantics first**.

## 4. Ideal target structure

Recommended v0.2+ structure:

```text
eventmesh/
├── apps/
│   ├── operator/
│   │   ├── src/
│   │   │   ├── main.ts                 # process entry point only
│   │   │   ├── config.ts               # typed env/config parsing
│   │   │   ├── server.ts               # Fastify construction/plugins
│   │   │   │
│   │   │   ├── routes/
│   │   │   │   ├── public-read.ts      # health, identity, read-only transcript
│   │   │   │   ├── peer/
│   │   │   │   │   ├── sessions.ts     # peer join/handshake
│   │   │   │   │   ├── events.ts       # receive signed events
│   │   │   │   │   ├── acks.ts         # receive ACKs/equivocation evidence
│   │   │   │   │   └── close.ts        # receive/sign close
│   │   │   │   └── admin/
│   │   │   │       ├── sessions.ts     # create/send/retry/close
│   │   │   │       ├── fiber.ts        # spend/create invoice/status
│   │   │   │       └── anchor.ts       # anchor/reconcile CKB commitment
│   │   │   │
│   │   │   ├── services/
│   │   │   │   ├── session-service.ts
│   │   │   │   ├── event-service.ts
│   │   │   │   ├── ack-service.ts
│   │   │   │   ├── delivery-service.ts
│   │   │   │   ├── close-service.ts
│   │   │   │   ├── payment-service.ts
│   │   │   │   └── anchor-service.ts
│   │   │   │
│   │   │   ├── security/
│   │   │   │   ├── admin-auth.ts
│   │   │   │   ├── cors.ts
│   │   │   │   ├── peer-url-policy.ts
│   │   │   │   └── peer-pinning.ts
│   │   │   │
│   │   │   └── storage/
│   │   │       ├── store.ts
│   │   │       ├── schema.ts
│   │   │       └── migrations/
│   │   └── package.json
│   │
│   ├── demo/
│   └── verifier/
│
├── packages/
│   ├── protocol/                        # rename/evolve @eventmesh/core
│   │   ├── src/
│   │   │   ├── canonical.ts             # deterministic serialization
│   │   │   ├── domains.ts               # signature domain separation
│   │   │   ├── session.ts
│   │   │   ├── event.ts
│   │   │   ├── ack.ts
│   │   │   ├── close.ts
│   │   │   ├── transcript.ts
│   │   │   └── verifier.ts
│   │   └── package.json
│   │
│   ├── transport-http/
│   │   └── src/index.ts                 # peer HTTP delivery/retry only
│   │
│   ├── integration-fiber/
│   │   └── src/
│   │       ├── rpc-client.ts
│   │       ├── invoice.ts
│   │       └── payment-proof.ts
│   │
│   ├── integration-ckb/
│   │   └── src/
│   │       ├── anchor-client.ts
│   │       ├── commitment.ts
│   │       └── verifier.ts
│   │
│   └── testkit/
│       └── src/
│           ├── operators.ts
│           ├── fake-peer.ts
│           └── fixtures.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   │   ├── two-operator-session.test.ts
│   │   ├── retry-after-lost-response.test.ts
│   │   ├── restart-recovery.test.ts
│   │   ├── ack-equivocation.test.ts
│   │   ├── session-conflict.test.ts
│   │   └── peer-url-policy.test.ts
│   └── testnet/
│       ├── fiber-payment.test.ts
│       └── ckb-anchor.test.ts
│
├── docs/
│   ├── PROJECT_BLUEPRINT.md
│   ├── PROTOCOL.md
│   ├── THREAT_MODEL.md
│   └── HOW_TO_VERIFY.md
│
├── scripts/
│   ├── smoke.mjs
│   ├── test-two-process.mjs
│   └── export-transcript.mjs
│
├── .github/workflows/
│   └── ci.yml
│
├── .env.example
├── .gitignore
├── .dockerignore
├── SECURITY.md
├── docker-compose.yml
├── package-lock.json
├── package.json
└── README.md
```

### Why this structure

The structure follows five boundaries:

1. **Protocol** must be pure and deterministic.
2. **Operator runtime** orchestrates protocol state but does not define cryptography.
3. **Peer transport** is replaceable and isolated from business state.
4. **Fiber/CKB integrations** are adapters, not protocol dependencies.
5. **Admin/spending operations** are not part of the public peer surface.

This lets EventMesh evolve without becoming a monolithic operator server or another generic payment SDK.

## 5. Protocol objects that should remain stable

Keep the protocol deliberately small:

```text
SignedSession
SignedEvent
SignedAck
SignedClose
```

### Session

Defines participants, endpoints, lifetime, protocol version, and max events.

### Event

Must include at minimum:

```text
sessionId
sequence
previousHash
type
payload
sender
createdAt
signature
```

### ACK

ACK is the counterparty's explicit acceptance/rejection of one exact event hash.

### Close

Close commits to the final transcript and optional application-defined state hash.

Do not add generic discovery, pricing, reputation, clearing, or policy objects to the protocol package.

## 6. Protocol invariants

These should become executable tests.

### I1 — Session immutability

For one `sessionId`:

```text
same signed session     -> idempotent success
different signed session -> SESSION_ID_CONFLICT
```

Never overwrite an existing session definition.

### I2 — Ordered transcript

For event `n`:

```text
sequence(n) = sequence(n-1) + 1
previousHash(n) = eventHash(n-1)
```

### I3 — Single pending event in v0.x

At most one `PROPOSED` event exists at any point.

This intentionally avoids concurrency ambiguity in the first protocol generation.

### I4 — ACK immutability

For an event:

```text
no ACK           -> accept first valid ACK
same ACK hash    -> idempotent success
different ACK    -> ACK_EQUIVOCATION / session DISPUTED
```

Never silently replace one valid ACK with another.

### I5 — Counterparty ACK

The event sender cannot ACK its own event.

### I6 — Close integrity

Before signing close, each operator independently verifies:

```text
close.sessionId == local sessionId
all transcript events FINAL
transcript root matches local transcript
event count matches
```

### I7 — Payment evidence is optional but verified when claimed

A `PAYMENT_SETTLED` event should not become accepted merely because it contains a string called `paymentHash`.

Target flow:

```text
payer sends payment
    ↓
payer proposes PAYMENT_SETTLED
    ↓
receiver independently queries its Fiber/invoice state
    ↓
receiver verifies expected asset/amount/session binding
    ↓
receiver signs ACK
```

### I8 — CKB anchor is advisory until independently verified

A peer notification containing `txHash` is not evidence by itself.

The receiving operator must derive the expected commitment locally and verify by CKB RPC that:

- the transaction exists;
- it is committed;
- the exact expected commitment data is present.

## 7. Signature domain separation

v0.2 should stop signing generic canonical objects without an explicit message domain.

Recommended domains:

```text
EVENTMESH_SESSION_V01
EVENTMESH_EVENT_V01
EVENTMESH_ACK_V01
EVENTMESH_CLOSE_V01
```

Conceptually:

```text
signature = Sign(
  H(domain || canonical(object))
)
```

This prevents a valid signature from one EventMesh object class being ambiguously reused as authorization for another class or application context.

## 8. API boundary

### Public/read-only

Safe for normal UI/read access:

```text
GET /health
GET /identity
GET /sessions/:id
GET /sessions/:id/transcript
```

### Peer-to-peer API

Only accepts signed EventMesh protocol objects:

```text
POST /peer/sessions/:id/join
POST /peer/sessions/:id/events
POST /peer/sessions/:id/acks
POST /peer/sessions/:id/close
POST /peer/sessions/:id/anchor-notice
```

These routes should validate the configured peer identity/session participant before mutating state.

### Local/admin API

Must require a local trust boundary or explicit admin authentication:

```text
POST /admin/sessions
POST /admin/sessions/:id/events
POST /admin/sessions/:id/events/:hash/retry
POST /admin/sessions/:id/events/:hash/ack
POST /admin/sessions/:id/close
POST /admin/fiber/new-invoice
POST /admin/fiber/send-payment
GET  /admin/fiber/payments/:hash
POST /admin/sessions/:id/anchor
```

**Never expose `send-payment` as an unauthenticated public route.**

## 9. Peer URL / SSRF policy

`peerUrl` is a network destination and must not be treated as harmless application text.

For local demo mode:

```text
ALLOW_PRIVATE_PEER_URLS=true
```

allows Docker/private addresses.

For public mode:

- permit only `https:` unless explicitly configured otherwise;
- resolve hostnames and reject loopback/link-local/private IP ranges;
- reject credentials embedded in URLs;
- optionally pin the peer hostname/public key established during session creation;
- do not follow redirects to a different host for peer protocol delivery.

## 10. Storage model

SQLite remains an excellent MVP choice because each operator has an obviously independent durable store.

Recommended tables:

```text
operators / local_identity
sessions
events
acks
closes
anchors
payment_evidence
equivocations
```

Important rule: protocol evidence should be append-oriented. Do not overwrite conflicting signed objects; retain them as dispute/equivocation evidence.

## 11. Fiber integration boundary

EventMesh should **not** embed or fork FNN.

Use:

```text
EventMesh -> FNN JSON-RPC
```

The integration package should eventually expose semantic methods such as:

```ts
createInvoice(...)
sendInvoicePayment(...)
verifyIncomingPayment(...)
getPaymentEvidence(...)
```

rather than leaking raw JSON-RPC response shapes throughout the operator application.

Fiber remains the value-transfer rail. EventMesh remains the session/transcript layer.

## 12. CKB integration boundary

CKB should store one compact final commitment, not every event.

Recommended commitment concept:

```text
EVENTMESH_V01
|| SHA256(sessionId)
|| transcriptRoot
|| finalStateHash
```

The CKB adapter should own:

- construction;
- submission;
- verification/reconciliation of committed status.

Longer term, transaction lifecycle ambiguity should be delegated to a durable transaction-operations layer rather than duplicated inside EventMesh.

## 13. Final-state semantics

v0.1 currently proves agreement on an opaque `finalStateHash`; it does not prove that both operators independently derived the same application state.

Use accurate wording for v0.1:

> mutually signed transcript commitment with an optional application-defined final-state hash.

A future application adapter can introduce:

```ts
interface StateReducer<State> {
  initial(session): State;
  apply(state, acceptedEvent): State;
}
```

Then both operators can independently calculate and compare the final state hash before close. Keep this out of the core until a real application needs it.

## 14. Testing strategy

### Unit

Protocol-only deterministic tests:

- canonical serialization;
- session/event/ACK/close signatures;
- tamper rejection;
- transcript root;
- hash-chain validation;
- domain separation.

### Integration

Required before calling the operator layer hardened:

1. complete two-process session;
2. lost event response then exact retry;
3. lost ACK response then idempotent resend;
4. restart either operator mid-session;
5. duplicate signed session;
6. conflicting signed session ID;
7. ACK equivocation;
8. forged sender/ACK;
9. peer URL rejection;
10. close with wrong session ID/root/count.

### Testnet

Optional/slow suite:

- real Fiber Testnet payment evidence;
- real CKB Testnet commitment;
- anchor verification after committed transaction;
- ambiguous RPC response/reconciliation test when a durable transaction adapter exists.

## 15. Deployment profiles

### Profile A — local proof

```text
UI + Operator A + Operator B
Fiber disabled
CKB disabled
```

One command:

```bash
cp .env.example .env
docker compose up --build
```

### Profile B — Fiber Testnet

Same stack plus two existing FNN JSON-RPC endpoints.

Do not expose FNN RPC publicly.

### Profile C — independent operators

Run A and B on separate hosts with TLS and pinned peer configuration.

This is the first deployment that demonstrates the project's cross-operator claim credibly.

## 16. Release roadmap

### v0.1 — Two-Operator Session Proof

Keep current scope:

- signed session;
- ordered hash-linked events;
- explicit ACK/REJECT;
- SQLite persistence;
- deterministic transcript root;
- two-party close;
- verifier;
- optional Fiber/CKB adapters.

### v0.1.1 — P0 hardening

Before public Testnet exposure:

- restore deployment template/ignore files;
- admin authentication;
- CORS allowlist;
- SSRF-safe peer policy;
- immutable sessions;
- immutable ACK/equivocation detection;
- close session-ID validation;
- Fiber-backed payment evidence;
- committed CKB anchor verification;
- integration tests.

### v0.2 — Independent-host proof

- peer/admin route split;
- TLS/pinned peer deployment;
- signature domain separation;
- full two-process test harness;
- first external/second-host integration;
- `HOW_TO_VERIFY.md` reproducibility guide.

### v0.3 — One real application adapter

Choose **one** application class, not several. A tiny two-server game/device demo is sufficient to prove an application can deterministically consume EventMesh transcripts.

Do not add marketplaces, discovery, reputation, or multilateral consensus unless an actual integration demonstrates the need.

## 17. Repository naming note

There is already a major unrelated open-source project named **Apache EventMesh**. To reduce search/branding confusion, public materials should consistently use a qualifier such as:

```text
EventMesh for CKB/Fiber
CKB EventMesh
EventMesh Sessions
```

The repository does not need to be renamed immediately, but package names and documentation should make the CKB/Fiber context explicit.

## 18. Project success criteria

A strong v0.2 demonstration should satisfy all of these:

1. Operator A and B run with different keys and databases.
2. They can run on different hosts.
3. A session survives process restart.
4. Lost HTTP responses do not duplicate events/ACKs.
5. Conflicting sessions or ACKs are detected rather than overwritten.
6. A claimed Fiber payment is independently verified before ACK.
7. Both sides calculate the same transcript root.
8. Both sign one close object.
9. A standalone verifier validates the exported transcript without either operator running.
10. The final CKB commitment is independently confirmed as committed and matching the close.

If those ten criteria pass, EventMesh has moved from a code sketch to a credible cross-operator CKB/Fiber reference implementation.
