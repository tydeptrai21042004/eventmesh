# EventMesh v0.1 — Two-Operator Session Proof

EventMesh v0.1 is a small CKB/Fiber-oriented reference implementation for **cross-operator application sessions**. Two independently keyed nodes maintain separate SQLite databases, exchange signed hash-linked events, explicitly acknowledge each other's events, close on a mutually signed transcript root, and can optionally attach real Fiber Testnet payments and anchor the final commitment to CKB Testnet.

## MVP boundary

Included:
- two independent operator keys and SQLite stores;
- signed ordered events with `previousHash` chaining;
- explicit ACCEPT/REJECT ACKs from the counterparty;
- replay/sequence/previous-hash checks;
- restart persistence through SQLite/WAL;
- transcript Merkle root and two close signatures;
- standalone transcript verifier;
- optional Fiber JSON-RPC adapter (`new_invoice`, `send_payment`, `get_payment`);
- optional real CKB Testnet anchor using `@ckb-ccc/shell`;
- one-page demo UI and Docker Compose.

Explicitly **not** in v0.1: discovery, marketplace, reputation, multilateral sessions, conditional payments, custom CKB scripts, mobile wallet, AI-agent framework, or mainnet automation.

## 1. Run local mode

Prerequisites: Docker + Docker Compose.

```bash
cp .env.example .env
docker compose up --build
```

Open **http://localhost:3000**.

Local mode requires no CKB and no Fiber funds. Operator A is exposed at `http://localhost:4001`; Operator B at `http://localhost:4002`.

### Fast smoke test

With the compose stack running:

```bash
node scripts/smoke.mjs
```

This creates a session, exchanges two events + ACKs, and closes the session.

## 2. Verify a transcript independently

Export from the UI, then on the host:

```bash
npm install
npm run verify -- ./ses_xxx.json
```

The verifier checks both session signatures, event signatures/hashes, ordering, previous-hash linkage, counterparty ACK signatures, transcript root, and both close signatures.

If a CKB anchor is present, pass a Testnet RPC URL to verify that the expected anchor data appears in the committed transaction:

```bash
npm run verify -- ./ses_xxx.json https://your-testnet-ckb-rpc.example
```

## 3. Enable real Fiber Testnet RPC

EventMesh does not embed or fork FNN. It calls an existing FNN JSON-RPC endpoint.

Set `.env`:

```env
FIBER_ENABLED=true
OPERATOR_A_FIBER_RPC_URL=http://host.docker.internal:8227
OPERATOR_B_FIBER_RPC_URL=http://host.docker.internal:8237
# Optional when your FNN RPC is protected by Biscuit/Bearer auth:
FIBER_RPC_TOKEN=
```

Then restart:

```bash
docker compose up --build
```

Available operator endpoints:

```text
POST /fiber/new-invoice
POST /fiber/send-payment
GET  /fiber/payments/:paymentHash
```

Example invoice request:

```bash
curl -s http://localhost:4002/fiber/new-invoice \
  -H 'content-type: application/json' \
  -d '{"amount":"0x5f5e100","currency":"Fibt","description":"EventMesh demo"}'
```

Then send the returned `invoice_address` from Operator A:

```bash
curl -s http://localhost:4001/fiber/send-payment \
  -H 'content-type: application/json' \
  -d '{"invoice":"fibt..."}'
```

After the payment succeeds, record a normal EventMesh event of type `PAYMENT_SETTLED` with payload `{ "paymentHash": "0x..." }`. EventMesh deliberately does not invent a second payment protocol.

## 4. Enable CKB Testnet final anchor

Only Operator A anchors in v0.1. Fund the Testnet key first; the anchor creates a self-owned cell containing a compact EventMesh commitment.

```env
CKB_ENABLED=true
CKB_PRIVATE_KEY=<64-hex-testnet-private-key>
# Optional; if empty CCC uses its public Testnet client defaults.
CKB_RPC_URL=
CKB_ANCHOR_CAPACITY_CKB=200
```

The anchor data contains only:

```text
EVENTMESH_V01 || SHA256(sessionId) || transcriptRoot || finalStateHash
```

It does **not** store every event on-chain and requires no custom lock/type script.

## API surface

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
```

## Protocol notes

- Only one event may be pending at a time in v0.1. This removes concurrency ambiguity and keeps the first implementation deterministic. If delivery is ambiguous, the sender retries the exact signed event with `/retry`; the receiver treats an already-seen event hash idempotently.
- The sender cannot ACK its own event.
- A new event is accepted only if its sequence and `previousHash` match the receiver's local transcript.
- `REJECT` is recorded and prevents normal close; v0.1 intentionally has no dispute protocol.
- Operator A initiates close in v0.1. Operator B independently recomputes the transcript root before signing.
- Keys are generated once and persisted under each operator data directory if `OPERATOR_PRIVATE_KEY` is not supplied.

## Development without Docker

```bash
npm install
npm run dev:a
# another terminal
npm run dev:b
# another terminal
npm run dev:demo
```

The Vite demo defaults to ports 4001 and 4002.

## Tests

```bash
npm test
```

The core suite covers signatures, tamper rejection, ACK verification, deterministic roots, transcript validation, and broken-chain rejection.

## Security status

This is an MVP/reference implementation, **not audited software**. Do not use production keys or mainnet funds. The HTTP peer transport is not mutually authenticated beyond signed application objects; production deployments should add TLS and explicit peer endpoint pinning/authentication. Fiber RPC endpoints should remain private/protected rather than exposed directly to the public internet.
