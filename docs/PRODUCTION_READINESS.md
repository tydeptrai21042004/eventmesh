# Production-readiness notes

EventMesh is now a stronger Testnet/beta operator, but it is still **not an audited mainnet service**. The canonical production direction is two independently administered operator deployments; the one-project Vercel workspace remains a reviewer/onboarding surface.

## Hardened in this production-beta patch

### Crash and retry safety

- Session creation is persisted as `CREATING` **before** contacting the peer. A lost join response can retry the same signed session through `POST /admin/sessions/:id/join/retry` instead of silently creating a second session.
- Outbound signed events, ACKs, and anchor notices use a persistent idempotent outbox.
- `POST /admin/outbox/drain` retries pending deliveries without generating replacement protocol objects.
- `POST /admin/sessions/:id/reconcile` compares both operators' immutable heads and detects `FORK`, `ACK_DIVERGENCE`, close divergence, anchor divergence, and one-sided progress.
- `repair:true` can reconstruct missing outbox work from already-persisted local signed evidence. This covers the crash window where the evidence reached disk but the delivery queue entry did not.

### Fiber evidence

- `PAYMENT_SETTLED` can optionally bind a payment to `obligationId`, `settlesEventHash`, a deterministic `purposeHash`, and an expected Fiber payee key.
- Receiver-owned FNN observations are signed by the EventMesh operator that performed receiver verification.
- New operator exports include receiver-signed observations, and transcript verification rejects missing/tampered observations when an evidence section is present. Legacy v0.2 exports without that section remain readable but do not gain the signed-observation guarantee.
- Payment-hash reuse protection remains global across local sessions.

The v0.2 CKB commitment remains backward compatible: `paymentEvidenceRoot` commits the canonical accepted **payment claims**. The newly signed receiver observation is exported and signature-checked but is not added to `EVENTMESH_V02`; changing the anchor bytes requires a future wire/anchor version.

### CKB anchoring

- The CKB adapter exposes `prepareAnchor()` and `broadcastPrepared()`.
- The operator prepares/signs the CKB transaction, persists its deterministic tx hash, and only then broadcasts it.
- Broadcast timeout/error leaves the known tx hash in `PENDING`; reconciliation queries that hash rather than blindly producing a second transaction.
- CKB verification supports configurable confirmation depth with `CKB_MIN_CONFIRMATIONS`.
- The standalone verifier supports `--ckb-confirmations <n>`.

### Public-surface hardening

- Configurable Fastify request-body ceiling (`MAX_BODY_BYTES`).
- Basic per-source peer request rate limiting (`PEER_RATE_LIMIT_MAX`, `PEER_RATE_LIMIT_WINDOW_MS`).
- Admin and peer APIs remain separated by route namespace and public-mode admin token policy.

## Canonical real-user topology

```text
Application A                 Application B
     |                              |
EventMesh A <--- signed protocol ---> EventMesh B
 key A / FNN A / state A        key B / FNN B / state B
     \                              /
      +---------- Fiber -----------+
                    |
             optional CKB audit
```

Do **not** deploy both operator private keys into one service and call that an independent bilateral production deployment.

## Still blocking a mainnet/general-availability claim

1. **Storage engine:** the standalone JSON store is atomic and single-process, but it is still a full-document single-writer store. For sustained multi-user load, migrate the same Store contract to SQLite WAL or PostgreSQL with real transactions and schema migrations.
2. **Key custody:** production keys should move from files/environment variables to KMS/HSM/Vault/external signers, with key versioning and rotation proofs.
3. **Peer authentication:** peer payload signatures protect protocol evidence, but the HTTP peer surface does not yet use mTLS/signed request envelopes. Add authenticated peer transport before exposing sensitive application payloads broadly.
4. **Distributed rate limiting:** the included limiter is process-local. Multi-instance deployments need a shared gateway/limiter.
5. **Background delivery worker:** the outbox is durable, but retries are currently request/admin driven. A persistent host should run a bounded worker with exponential backoff and dead-letter alerting.
6. **Recovery from remote-ahead state:** local signed evidence can be safely re-delivered. Automatic import of full remote evidence is intentionally not implemented until peer-authenticated evidence-sync is added.
7. **CKB prepared transaction recovery:** the tx hash is persisted before broadcast. A process crash after prepare but before broadcast preserves identity but not a portable serialized signed transaction; a future CKB adapter should persist the signed transaction bytes for exact post-restart broadcast.
8. **Observability:** add metrics/traces/alerts for pending outbox age, dispute counts, Fiber verification failures, anchor latency, and reconciliation drift.
9. **Abuse controls:** add organization/project quotas, scoped API keys, audit logs, payload retention/redaction policy, and incident tooling.
10. **Independent security review and load/fault testing** before mainnet funds or production secrets.

## Minimum go-live gate for a controlled beta

A controlled beta should not start until all of these are true:

- two independently deployed operators with separate keys, storage and FNNs;
- HTTPS and admin authentication enabled;
- backups and restore drill completed;
- restart at every protocol transition tested;
- lost event response and lost ACK response recover through reconciliation/outbox;
- wrong amount/asset/UDT/payee/obligation/payment reuse are rejected;
- Fiber receiver RPC outage leaves settlement unaccepted rather than fabricated;
- CKB timeout recovery queries the persisted tx hash;
- configured confirmation depth is reached before presenting the anchor as confirmed;
- a third machine verifies the exported transcript from independent RPC endpoints.

See `docs/GO_LIVE_CHECKLIST.md` for the operational checklist.
