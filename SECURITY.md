# EventMesh Security Policy and MVP Threat Model

EventMesh v0.1 is a **reference implementation for CKB/Fiber Testnet experimentation**. It is not audited software and must not be used with mainnet keys or production funds.

## Security boundary

EventMesh is intended to prove one narrow property:

> Two independently keyed operators can maintain separate durable stores, exchange an ordered stream of signed application events, explicitly acknowledge those events, and produce a mutually signed transcript commitment.

EventMesh does **not** claim to prove that an external physical/digital event was objectively true. It proves only what the two configured operators signed and accepted.

## Current v0.1 risks

The current operator application combines peer-facing and local administrative endpoints in one Fastify process. Until the v0.2 hardening refactor is complete:

- do not expose the operator ports directly to the public Internet;
- do not expose `/fiber/send-payment` to untrusted clients;
- keep FNN RPC endpoints private or token-protected;
- use only Testnet keys/funds;
- run behind a trusted local reverse proxy or firewall when Fiber is enabled;
- treat `peerUrl` as trusted configuration rather than arbitrary user input;
- do not treat a received CKB anchor notification as verified until independently checked by RPC.

## Required hardening before public Testnet service

P0 items:

1. Split peer and admin API surfaces.
2. Require admin authentication for payment-spending operations.
3. Replace wildcard CORS with an explicit allowlist.
4. Validate/pin peer URLs and prevent SSRF in public mode.
5. Make session creation immutable/idempotent by `sessionId`.
6. Make ACKs immutable and detect ACK equivocation.
7. Bind payment events to independently verified Fiber state.
8. Verify CKB anchor transaction status and exact commitment before accepting it.
9. Add integration tests covering restart, retry, duplicate delivery, and equivocation.

See [`docs/PROJECT_BLUEPRINT.md`](docs/PROJECT_BLUEPRINT.md) for the target structure and implementation sequence.

## Secret handling

Never commit:

- `CKB_PRIVATE_KEY`;
- FNN bearer/Biscuit tokens;
- production operator private keys;
- local SQLite databases containing private material.

The repository `.gitignore` excludes local `.env` files and `.data/`.

## Reporting a vulnerability

For now, please report security issues privately to the repository maintainer instead of opening a public exploit-details issue. Once the project has a stable release process, replace this section with a dedicated security contact/process.
