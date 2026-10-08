# EventMesh hardening patch (changed files only)

This patch preserves the existing npm workspaces, protocol wire format, operator HTTP routes, Fiber / CKB API integrations, and JSON state format. **No database, new third-party package, or additional service is required.** It is intended for the existing single-host, single-writer operator deployment.

## Apply

Extract the patch ZIP **over the root of your existing EventMesh repository**, retaining the included relative directories. Then use your existing start/deploy command. Rebuilding the operator image is required if you deploy with Docker Compose (`docker compose up --build -d`). Existing local operator state should remain in place.

## What changed

- JSON state writes now use exclusive writer locks, temp-file fsync, atomic rename, parent-directory fsync on POSIX, and rollback of in-memory mutations when a write fails before rename.
- Corrupt state fails closed. Top-level records, signature-shaped session/event/ACK records, and outbox structure receive startup checks. Internal objects are returned as defensive copies.
- Operator identity file reads distinguish missing keys from I/O errors; the identity public key is pinned on disk. Production mode does not silently generate a new key.
- Session mutations are serialized across asynchronous verification and delivery. Duplicate concurrent ACKs reuse one signed ACK.
- Peer requests connect only to the IP address vetted by the DNS/SSRF validator, while TLS hostname verification is preserved. Response sizes, overall deadlines, and allowed API paths are bounded.
- Outbox delivery attempts are singleflight and automatically retried with capped exponential backoff and deterministic jitter; old delivered bookkeeping entries are pruned after a retention interval.
- Input-validation errors are sanitized; unexpected internal errors are no longer returned verbatim to clients.
- Docker runtime now receives compiled workspace packages, drops to the non-root node user after automatically migrating old root-owned named-volume permissions, includes a health check, and has lifecycle limits in Compose.
- Direct developer-run operators bind to loopback by default. Docker Compose explicitly binds the operator to all container interfaces.

## Compatibility and limitations

- Preserve `/data/operator.key`, `/data/operator.public`, and `/data/eventmesh-state.json` together in backups. The public-key pin is created automatically on the first startup with this patch.
- If the key is lost and the public-key pin exists, startup intentionally refuses to generate a replacement. Restore the matching private key.
- In `PUBLIC_MODE=true`, use an existing `operator.key` or the **already supported** `OPERATOR_PRIVATE_KEY` setting.
- Do **not** run two operators against one state file or place the JSON store on a multi-host shared filesystem. Use a transactional database for multi-replica production.
- Vercel's demo state remains instance-local; this patch does not turn the demo API into a globally durable service.
- CKB anchor reconciliation retains the prepared transaction hash, but an interrupted broadcast is **not automatically rebuilt/rebroadcast**. Confirm/reconcile by its original hash and do not create a replacement anchor transaction blindly.
- Normal tests and package type checking were not executable in the packaging environment because npm dependencies could not be fetched. Dependency-free transport and storage smoke checks and TypeScript syntax transpilation were executed; run `npm run check` in your usual development/CI environment.

## New optional tuning (all have defaults)

- `MAX_PEER_RESPONSE_BYTES`: default `4194304` (4 MiB).
- `OUTBOX_RETRY_INTERVAL_MS`: default `15000` (15 seconds).
- Existing peer request timeout, max body size, and allowed-host settings continue working as before.
