# Threat Model

EventMesh proves a narrow statement: configured operator keys signed a specific bilateral transcript and final commitment. It does not prove external-world truth.

Protected assets: operator keys, CKB key, FNN token, immutable transcript evidence and payment/session binding.

Mitigations implemented in v0.1.1: domain-separated signatures, immutable first-write evidence, equivocation retention, cross-session checks, receiver-owned Fiber invoice verification, CKB committed-state verification, admin bearer auth in public mode, CORS allowlist, HTTPS/public-mode rule, SSRF-oriented peer URL filtering, redirect refusal and request timeouts.

Residual risks: no formal audit; admin/peer routes still share one listener; DNS resolution is checked but not socket-pinned against rebinding; no PKI/on-chain organizational identity; no HSM; no rate limiter; Fiber proof depends on the configured FNN's view; Testnet-first only.
