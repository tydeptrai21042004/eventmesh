# EventMesh v0.2 Security Policy and Threat Model

EventMesh v0.2 is a **reference implementation for CKB/Fiber Testnet validation**. It is not audited software and must not be used with production keys or mainnet funds.

## Security boundary

EventMesh proves a narrow bilateral statement:

> Two configured operator keys maintained an immutable signed event/ACK transcript, accepted the same close, optionally bound receiver-verified Fiber payment claims to it, and can later verify the compact CKB commitment.

It does **not** prove that an external game, device, API or physical-world statement was objectively true. Application-specific validation belongs in an adapter or the application itself.

## Implemented v0.2 controls

- domain-separated signatures for session/event/ACK/close objects;
- immutable/idempotent evidence with durable conflict records;
- cross-session and previous-hash checks;
- separate `/admin/*` and `/peer/*` API namespaces;
- admin-token requirement in public mode;
- explicit CORS allowlist;
- peer URL scheme/credential/path validation;
- DNS/private-address SSRF blocking in public mode, redirect blocking and request timeouts;
- receiver-owned Fiber `get_invoice` verification before an accepted `PAYMENT_SETTLED`;
- payment hash + session + amount + currency + optional exact UDT type-script binding;
- global payment-hash reuse protection;
- `paymentEvidenceRoot` committed by both close signatures and CKB;
- independent CKB RPC verification requiring `committed` and exact locally-derived output data;
- standalone verifier that can independently re-query receiver FNN and CKB.

## Remaining operational risks

The peer/admin namespaces still run in one Fastify process/listener. Production deployment should place them behind network policy or separate ingress rules. Rate limiting, production key management, structured audit export, peer-key pinning/rotation, TLS termination and operational monitoring remain deployment responsibilities.

The protocol serializes each bilateral session to one unresolved event at a time. Same-sequence proposals from different operators are retained as `PROPOSAL_COLLISION`; EventMesh does not claim to provide general distributed consensus or automatic conflict resolution.

## Testnet deployment rules

- use separate operator keys, stores and FNN nodes;
- keep FNN RPC tokens private;
- use HTTPS and `PUBLIC_MODE=true` for Internet-facing operators;
- set an `ADMIN_TOKEN` and explicit `CORS_ORIGINS`;
- leave `ALLOW_PRIVATE_PEER_URLS=false` in public mode;
- optionally pin `PEER_HOST_ALLOWLIST`;
- do not treat `PENDING` CKB anchors as final evidence;
- verify real proof artifacts with the standalone verifier rather than screenshots.

## Secret handling

Never commit operator private keys, `CKB_PRIVATE_KEY`, FNN tokens, `.env`, or local SQLite databases. The supplied `.gitignore` excludes the expected local secret/state paths.

## Vulnerability reporting

Report security issues privately to the repository maintainer rather than opening a public exploit-details issue. Replace this section with a dedicated security contact/process before any production deployment.

## Vercel durable-state boundary

Production Vercel deployments should configure `DATABASE_URL`. EventMesh auto-initializes namespaced Postgres tables and uses revision-based compare-and-swap updates to prevent lost updates between concurrent serverless invocations. Vercel `/tmp` is not treated as durable storage and is refused unless `ALLOW_EPHEMERAL_VERCEL_STATE=true` is explicitly enabled for a disposable preview.

The public demo mutation API is intentionally unauthenticated at the end-user layer; same-origin browser checks and rate limits are abuse controls, not identity. A real operator service must put the endpoint behind application authentication and authorization.
