# EventMesh controlled-beta go-live checklist

This checklist is intentionally stricter than the Vercel preview. “Pass” means demonstrated on the exact deployment intended for real beta users.

## 1. Trust boundary

- [ ] Operator A and B run in separate administrative domains.
- [ ] Each process contains only its own EventMesh private key.
- [ ] Each receiver verifies Fiber through its own trusted FNN endpoint.
- [ ] Vercel preview credentials are not reused as production operator credentials.
- [ ] HTTPS is enforced; admin API is not public/anonymous.

## 2. Persistence and recovery

- [ ] Persistent volume survives process/container replacement.
- [ ] State backup is automated and one restore has been tested.
- [ ] `CREATING` session survives a lost join response and succeeds through `/join/retry`.
- [ ] Event delivery loss leaves a `PENDING` outbox entry and retry is idempotent.
- [ ] ACK delivery loss leaves/reconstructs retryable signed evidence.
- [ ] `/reconcile` returns `IN_SYNC` after repair.
- [ ] Deliberate same-sequence fork returns `FORK`/`DISPUTED`, never silent overwrite.

## 3. Fiber correctness

- [ ] `Pending/Open` invoice cannot produce ACCEPT.
- [ ] Wrong payment hash is rejected.
- [ ] Wrong amount/currency is rejected.
- [ ] Wrong/missing UDT script is rejected where applicable.
- [ ] Wrong expected payee is rejected.
- [ ] Wrong obligation/result/purpose binding is rejected.
- [ ] Reusing one payment hash across sessions is rejected and recorded as conflict.
- [ ] Exported receiver observation signature verifies independently.

## 4. CKB anchor

- [ ] Prepared tx hash is persisted before broadcast.
- [ ] Simulated broadcast timeout recovers by querying the same tx hash.
- [ ] Wrong commitment bytes are rejected.
- [ ] `CKB_MIN_CONFIRMATIONS` is set for the beta environment.
- [ ] UI/API distinguishes `PENDING`, `COMMITTED` and `CONFIRMED`.
- [ ] Third-party verifier reaches `RESULT: VERIFIED` using an independent RPC.

## 5. Abuse and operations

- [ ] `PUBLIC_MODE=true` refuses startup without admin token and HTTPS self URL.
- [ ] Body limit is appropriate for application payloads.
- [ ] Peer request rate limit tested with 429 response.
- [ ] Peer host allowlist/private-host policy matches deployment network.
- [ ] Secrets are absent from logs and exported evidence.
- [ ] Alert exists for old pending outbox entries, disputes, Fiber verification failure and anchor lag.
- [ ] Incident procedure names who can freeze an operator, rotate credentials and communicate to peers.

## 6. Load/fault test

At minimum run a scripted campaign with process termination injected after each persistence/network boundary:

```text
create local session -> peer join -> event persist -> event send -> peer persist
-> ACK/evidence persist -> ACK send -> close proposal -> peer close
-> CKB prepare -> local txHash persist -> broadcast -> commit/confirm
```

The invariant is: restart/retry may duplicate transport attempts, but must never create a second logical event, accept unverified payment evidence, silently replace conflicting signed evidence, or blindly rebroadcast an unknown CKB transaction.
