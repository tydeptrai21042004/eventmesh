# GitHub Actions: genuine two-FNN payment -> genuine CKB Testnet anchor

This is **not** the legacy `funded-testnet` job. That job monitors a public CKB wallet and can opt in to broadcasting **synthetic** commitment data. Its `FUNDED_READY_TO_TEST` status does not establish a paid Fiber transaction.

The separate `real-fiber-testnet` job runs the existing paid-service v2 integration and then anchors the **actual dual-signed session commitment** through Operator A's `/admin/sessions/:id/anchor` endpoint. The service-result hash remains a deterministic demonstration fixture (`syntheticComputationResult: true`), but the Fiber payment, signed EventMesh evidence, and CKB anchor are intended to be real Testnet operations.

## 1. Prerequisites (cannot be auto-provisioned by Actions)

- **Two real Fiber Network Nodes (FNNs)** independently configured for Nervos CKB Pudge Testnet, with different FNN public keys, reachable channel liquidity and payment routing. Their RPC endpoints should stay private, reachable by their respective EventMesh operators.
- **Two persistent EventMesh operator services**, with separate durable `DATA_DIR`, distinct operator signing keys and `ADMIN_TOKEN` values, `FIBER_ENABLED=true` and different `FIBER_RPC_URL` settings. Expose their admin APIs only on an authenticated private network or correctly configured HTTPS endpoint. Do not expose FNN JSON-RPC directly to the public Internet.
- **Operator A must also have CKB anchoring enabled**, configured with `CKB_ENABLED=true`, `CKB_PRIVATE_KEY` (private server secret, not Git-committed), `CKB_RPC_URL=https://testnet.ckbapp.dev/` (or another working Testnet endpoint), `CKB_MIN_CONFIRMATIONS=2`, `CKB_AUTO_ANCHOR_ON_CLOSE=false`. Operator A's CKB signing wallet must itself be funded; the separately monitored wallet in `config/testnet-wallet.json` does not fund Operator A unless its key/address is actually configured there.
- Verify **both FNNs use Pudge Testnet** independently from their deployment configs. The EventMesh node-info preflight only checks identities, not chain genesis/network identity. Confirm the payment amount and actual channel capacity.
- A **persistent, trusted self-hosted GitHub Actions runner** with labels `self-hosted`, `linux`, `x64`, `eventmesh-testnet`. Do not run real paid workflows on disposable GitHub-hosted machines: the payment-intent journal must survive crashes and subsequent runs. Secure and maintain this runner; do not allow untrusted pull-request code to execute on it.

**Security:** Previously disclosed wallet keys should be replaced before funding. Never put an operator private key, FNN key, CI token or invoice preimage in `config/`, workflow YAML, Actions variables, or artifacts. Rotate any compromised keys.

## 2. Configure a durable journal

On your self-hosted runner (as an administrator), create an out-of-workspace persistent directory owned exclusively by the runner service account. Example:

```bash
sudo install -d -m 0700 -o <RUNNER_USER> -g <RUNNER_GROUP> /srv/eventmesh-testnet-state
```

Replace the placeholders with the real runner user/group; do not include brackets literally. Directory must already exist, be absolute and 0700, and must not be inside `/tmp`, `RUNNER_TEMP`, or `GITHUB_WORKSPACE`. **Never delete `two-fnn-state.json` to bypass a failed/ambiguous payment.** Re-running the same workflow from an intact journal resumes without sending a second payment.

## 3. Configure GitHub Environment and secrets

Create GitHub repository **Settings → Environments → `fiber-testnet-live`**. Configure required reviewers for live payments. Use environment **variables**:

| Variable | Value |
|---|---|
| `OPERATOR_A_URL` | HTTPS base URL of operator A, or loopback origin when on same host |
| `OPERATOR_B_URL` | HTTPS base URL of operator B, or loopback origin when on same host |
| `EVENTMESH_DURABLE_STATE_DIR` | `/srv/eventmesh-testnet-state` |
| `EVENTMESH_PAYMENT_SHANNONS` | `100000000` (1 CKB) |
| `EVENTMESH_MAX_PAYMENT_SHANNONS` | `100000000` (default cap) |
| `EVENTMESH_CKB_RECONCILE_POLLS` | `6` (10-second gaps) |

Use **environment secrets** (never variables): `OPERATOR_A_TOKEN` and `OPERATOR_B_TOKEN`, matching the separate operator services' `ADMIN_TOKEN`s. The runner **does not need** the CKB private key: Operator A signs and broadcasts the on-chain checkpoint from its own secure server configuration. The synthetic monitor's `CKB_TESTNET_PRIVATE_KEY` is **not** used by this live job.

Optional public repository variable `CKB_RPC_URL` controls the read-only wallet diagnostics job.

## 4. Launch from GitHub Actions

In **Actions → EventMesh — One CI and Funded Testnet Workflow → Run workflow**:

1. Select `live_fiber_mode: preflight` with an empty approval. This calls only GET endpoints and creates no new session, payment, or anchor.
2. If the two independent FNNs, channel balances, operator storage, and the operator-A signing wallet are ready, select `live_fiber_mode: payment-and-anchor` and type the exact phrase `RUN_ONE_TESTNET_PAYMENT_AND_ANCHOR` in `live_approval`.
3. Review any required GitHub Environment approval. The run can then initiate **one** Fiber Testnet payment from a persistent journal, close the application session and broadcast a real CKB checkpoint of that session.
4. For a completed session whose CKB confirmation was delayed, select `live_fiber_mode: reconcile`. It requires a journal already at `CLOSED` and **never initiates a new payment**. A partially completed payment requires the original manual `payment-and-anchor` mode with the same journal; this code already prevents a second `send_payment` after the first attempt.

**Do not** select `broadcast_synthetic_anchor` when you want the genuine Fiber milestone. It is a separate legacy synthetic test.

## 5. Debugging table

| Logged stage / status | Meaning | First place to inspect |
|---|---|---|
| `RPC_UNAVAILABLE` | Read-only CKB wallet probe cannot complete | `artifacts/testnet/diagnostics.json`: DNS, chain and indexer results |
| `FUNDED_READY_TO_TEST` | Public monitoring address funded; not a broadcast | `artifacts/testnet/report.json` |
| `MISSING_TESTNET_KEY` | Legacy *synthetic* broadcast missing its secret | It is unrelated to Operator A's live anchoring key |
| `OPERATOR_URLS_MISSING` | Live operator URLs not configured | Environment variables |
| `OPERATOR_ADMIN_TOKENS_MISSING` | Missing operator authorization secrets | Environment secrets |
| `OPERATOR_A_CKB_ANCHOR_NOT_CONFIGURED` | Operator A does not report CKB anchoring and CKB verification enabled | Its server environment and `/health` |
| `FNN_MUST_BE_TWO_DISTINCT_NODE_PUBKEYS` | Both endpoints resolve to same Fiber node or invalid identity | Both operator `/admin/fiber/node-info` |
| `PAYMENT_OUTCOME_NOT_PROVEN_NO_RESEND` | Payment response ambiguous; receiver has not proven invoice Paid | Persisted journal + B's invoice status, **no second send** |
| `INVOICE_CREATE_AMBIGUOUS_INSPECT_B_FNN` | Can't safely repeat invoice creation | B's durable store/FNN; manually reconcile |
| `CKB_PENDING_CONFIRMATIONS` | Real transaction identity exists, not yet confirmed | `artifacts/real-fiber-testnet/status.json`, on-chain tx hash |
| `CKB_CONFIRMATION_PENDING_OR_UNVERIFIED` | CKB verification incomplete after configured polling window | `reconcile` after checking chain RPC |
| `LIVE_FIBER_AND_CKB_CONFIRMED` | Full operator evidence and on-chain checkpoint reported confirmed | Verify both published transcript and CKB transaction hash independently |

The live evidence ZIP artifact contains `artifacts/real-fiber-testnet/status.json`, `trace.ndjson`, and (after successful signed payment) `evidence.json` with signed transcripts. Logs use redacted error codes and public transaction hashes. They never contain signing keys or authorization headers.

## 6. Scope of claims

- A real Fiber payment requires operational FNN channels and live infrastructure: **merging these files cannot itself create them**.
- Test mode has **real Fiber and CKB Testnet interactions**, but the computation payload is a synthetic application-result hash. Do not claim a real computation was performed.
- `testnetIndependentlyVerified: false` remains until a separate verified network-attestation mechanism exists.
- Two operator service URLs are not proof of independent ownership. Document hosting and durable storage separately.
- A confirmed CKB transaction proves inclusion of the transcript commitment, not external correctness or legal enforceability.
- First perform `preflight` and inspect the results; never reconfigure the runner to force a green status without the chain evidence.
