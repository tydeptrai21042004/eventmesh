# CKBuilders reviewer validation: compare simpler solutions first

The reviewer asked whether EventMesh has a use case beyond normal Fiber invoice/order binding, idempotent APIs and simple countersigned receipts. This repository now provides TWO explicitly different types of evidence. Do not combine or inflate them in a grant proposal.

## 1. Local reproducible fault comparison (NO FUNDS)

```bash
npm install
npm run check:all
npm run compare:alternatives
npm run compare:failures > local-failure-matrix.json
```

`compare:alternatives` checks signatures and proof semantics using deterministic cryptographic fixtures. `compare:failures` additionally runs two local EventMesh Fastify operators with **separate durable state directories**, injects a lost application response, shuts down and restarts one operator while another has a pending event, and tests a conflicting result. Its two baselines are deliberately **small local reference models** (single-authoritative-JSON idempotent API, and persisted signed receipts). They **do not** have equivalent HTTP servers, resilience guarantees or complexity, and this is **not** a performance, independent-host, SIGKILL, network-partition or Fiber test. Read `executionClass`, `setup` and `limits` in the JSON output.

The comparison is falsifiable: receipts already provide portable bilateral acknowledgement. A generic EventMesh transcript does **not** enforce application-level idempotency or global uniqueness. Use the strict paid-service profile for paid results; use an application database to ensure a particular job is executed once.

## 2. Real two-FNN testnet integration (OPT-IN; MAY SPEND TESTNET CKB)

1. Provision **two independently configured FNN nodes** on *Pudge Testnet*, each with its own data directory, secret key, CKB Testnet RPC, and ready channel liquidity/route. Keep FNN JSON-RPC on loopback or behind an authenticated private interface. Follow the [upstream Fiber public-node guide](https://github.com/nervosnetwork/fiber/blob/develop/docs/public-nodes.md), matching your installed FNN release. The runner **does not** fund wallets or establish channels. Upstream documents FNN invoice creation with `payment_preimage`, `final_cltv`, and `hash_algorithm` fields.
2. Run EventMesh Operator A with `FIBER_ENABLED=true`, `FIBER_RPC_URL=http://127.0.0.1:8227`, `OPERATOR_NAME=operator-a`, `PORT=4001`, `SELF_URL=http://127.0.0.1:4001`, `DEFAULT_PEER_URL=http://127.0.0.1:4002`, `DATA_DIR=.data/operator-a` and an optional `ADMIN_TOKEN`. Run Operator B separately with FNN RPC port `8237`, EventMesh port `4002`, the reverse peer URL, and **different** operator identity/data directory/admin token. Prefer separate hosts for the eventual public evidence; local two-node setup alone does not establish independent deployment.
3. Confirm the FNN processes really point to **CKB Pudge Testnet**, not Mainnet or an isolated development network. The `/admin/fiber/node-info` preflight verifies that their FNN public identities differ but **cannot authenticate the chain network**. `Fibt` currency is a safeguard, not a sufficient network attestation.
4. Configure the runner with endpoints and tokens (do not commit actual tokens):

```bash
export OPERATOR_A_URL=http://127.0.0.1:4001
export OPERATOR_B_URL=http://127.0.0.1:4002
# If configured:
# export OPERATOR_A_TOKEN=...
# export OPERATOR_B_TOKEN=...

# Safe: preflight only. No session or payment created.
npm run testnet:two-fnn -- --preflight
```

5. **Only after verifying both Testnet FNNs, balances, fees and routing**, authorize a single payment. Default amount is 100,000,000 shannons (1 CKB) and the default cap is also 1 CKB; adjust cap consciously if required. Testnet CKB still requires liquidity.

```bash
export EVENTMESH_TESTNET_NETWORK_CONFIRM=TESTNET_ONLY
export EVENTMESH_ALLOW_FIBER_PAYMENT=YES_ONE_TESTNET_PAYMENT
export EVENTMESH_PAYMENT_SHANNONS=100000000
export EVENTMESH_MAX_PAYMENT_SHANNONS=100000000
export EVENTMESH_RUN_STATE=artifacts/reviewer-two-fnn/state.json
npm run testnet:two-fnn -- --run --allow-payment
```

On first run the script creates a strict paid-service v2 session, signs and ACKs service events, has B create an invoice bound to the session, job ID, result-event hash and recipient node public key, and sends **at most one** payment from A. It polls B's **own FNN** for `Paid`, then B verifies the same invoice before signing its `PAYMENT_SETTLED` ACK. It finally requests completion and a dual-signed close, verifies the exported transcripts and strict application semantics, and produces `artifacts/reviewer-two-fnn/evidence.json`. `syntheticComputationResult: true` identifies the fixed demonstration computation commitment; this is not evidence that an actual service was delivered.

### Ambiguous send and fault injection

You can inject a CLI-side lost response *after* `send_payment` returns (not a real network partition):

```bash
npm run testnet:two-fnn -- --run --allow-payment --inject-lost-payment-response
# After the deliberate stop, rerun WITHOUT the injection flag:
npm run testnet:two-fnn -- --run --allow-payment
```

The state journal is fsynced **before** the first payment attempt. Resume queries B's invoice status; it **never calls `send_payment` a second time** from the same journal. If the invoice is not proven `Paid`, it fails closed with `PAYMENT_OUTCOME_NOT_PROVEN_NO_RESEND`. An ambiguous invoice-creation or session-creation response also requires manual recovery (there is no safe second creation). Do not delete/change the journal or substitute different endpoints/identities to bypass these protections.

### Real integration limits

- No public Testnet payment has been executed by the patch author; you must provide valid independent FNN nodes, credentials, liquidity and verify the run yourself.
- The script does not prove node/network identity cryptographically or automatically create independent machines, nor does it submit a CKB checkpoint.
- The transcript proves commitments and signed acceptance, **not** computation correctness, arbitration, delivery or global unique agreement.
- CKB Testnet checkpoint evidence is separate from Fiber settlement proof; the existing synthetic CKB CI workflow cannot substitute for the real two-FNN flow.
- A failed/incomplete run must be reported as incomplete; never present a dry-run, stub, mock invoice or unsigned evidence as a live paid proof.

## 3. Decision gate after the evaluation

| Observation | Recommendation |
| --- | --- |
| Idempotent API plus invoices solve all observed failures | Do not extend the reconciliation protocol; maintain a simple reference integration |
| Signed receipt provides the same portable acknowledgement evidence | Favor the receipt-first SDK; retain full EventMesh as optional research tooling |
| EventMesh alone demonstrates a meaningful cross-operator failure/recovery guarantee and an adopter needs it | Document the exact guarantee, protocol overhead, failure trace and external adopter feedback |

A positive result is **not assumed**. Report any outcomes, including ones where EventMesh adds no practical value.
