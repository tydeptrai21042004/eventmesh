# EventMesh v0.2 Threat Model

## Security statement

EventMesh proves a narrow statement: **configured operator keys signed a specific bilateral transcript and final commitment**. It does not prove an external physical/business event was objectively true.

## Protected assets and evidence

- operator private keys;
- optional CKB anchoring key;
- FNN RPC credentials;
- immutable signed session/event/ACK/close evidence;
- payment/session/amount/currency/UDT binding;
- CKB commitment integrity.

## Implemented mitigations

- domain-separated secp256k1 signatures;
- immutable first-write evidence with conflict retention;
- session-ID and cross-session checks;
- same-sequence cross-operator proposals recorded as proposal collisions;
- payment hash global reuse protection;
- receiver-owned Fiber `get_invoice` verification before ACCEPT;
- exact amount/currency/session marker checks;
- exact UDT type-script comparison when a UDT is claimed;
- deterministic `paymentEvidenceRoot` committed by both close signatures and CKB;
- independent CKB committed-state/output-data verification;
- PENDING → COMMITTED anchor reconciliation;
- admin bearer token required in public mode;
- explicit CORS allowlist;
- URL credentials/path/query rejection for peers;
- private-address/DNS checks in public mode;
- redirect refusal and request timeouts for peer calls.

## Important trust boundaries

### Fiber

A receiver's configured FNN view is the acceptance authority for `PAYMENT_SETTLED`. EventMesh does not make FNN responses cryptographically self-authenticating. Independent verification therefore queries the receiver FNN again when `--require-fiber` is used.

### CKB

A peer-supplied tx hash or `dataHex` is not trusted. The verifier reconstructs expected bytes and queries CKB RPC.

### Applications

An adapter validates application semantics only. It cannot make EventMesh prove real-world truth.

## Residual risks

- no formal security audit;
- peer/admin routes still share one HTTP listener even though admin routes are authenticated;
- DNS is checked before requests but sockets are not pinned against DNS rebinding between lookup and connect;
- no PKI/on-chain organizational identity binding for operator keys;
- no HSM/key rotation protocol;
- no built-in rate limiter;
- the v0.2 proof profile serializes outstanding proposals rather than implementing distributed consensus;
- Testnet-first; do not use production/mainnet keys until independently reviewed.
