# EventMesh v0.6 hardening patch — 22 October 2026

This is a **changed-files-only** patch against the user-provided `eventmesh-main(1).zip` (archive revision `38ffa3d97ea1643d91f6011e44ec883230f457aa`). It is not a replacement repository and does not contain `node_modules` or private operator keys.

## Apply

1. Copy the directory entries in `EventMesh_Code_Changes.zip` into the **root** of your existing `eventmesh` repository, preserving paths. The original files not present in the ZIP should remain unchanged.
2. Ensure Node 22/npm 10. Run `npm install --no-audit --no-fund`. **Commit the generated `package-lock.json`** after reviewing its dependency resolution. On later clean installs use `npm ci`.
3. Run `npm run check:all` and `npm run test:faults` before merging. The full dependency-backed test suite was **not executable in the authoring container** because fetching npm dependencies timed out. Six dependency-free Node tests and TypeScript syntax checks passed locally.
4. Commit `.github/workflows/`, the scripts, new tests and source changes. Enable GitHub Actions in the repository, protect `main` with the `EventMesh CI` check, and inspect the run artifacts.
5. No secret keys, access keys or Fiber tokens should be committed or attached to Actions artifacts.

## Actual code changes

- Adds **paid-service v2** with a new signed application profile/rules hash, requiring exactly one PAYMENT_SETTLED before completion. Legacy v1 remains unchanged; callers must explicitly opt into `applicationProfile: "paid-service-v2"`.
- Operator identity endpoint advertises v2, validates the v2 flow, and derives the signed final state using strict semantics. A payment is still not proven solely because an event exists: receiver-owned FNN verification remains a separate trust boundary.
- Standalone verifier accepts a v2 signed profile, supports `--expected-operator-a`, `--expected-operator-b` and `--json-report`, and prints the scope of independent offline/Fiber/CKB checks.
- CKB reconciliation now avoids downgrading last-known CKB status solely because of `RPC_EXCEPTION`, and supplies an explicit recovery action for TX_NOT_FOUND. It does **not** pretend to implement safe rebroadcast without retaining signed transaction bytes.
- Evidence preflight accepts COMMITTED or CONFIRMED CKB status, rejects escaping transcript paths/symlinks and dishonest optional SHA-256 declarations, caps evidence JSON size and labels structural-only checks accurately.
- Adds strict-profile negative tests, independent two-operator closing test, simulated hard-crash recovery test, and CKB RPC-failure tests.
- Five GitHub Actions workflows: CI, CodeQL, dependency audit, manual offline evidence checking with both operator keys pinned, and nightly deterministic fault matrix. Their reports explicitly disclaim live Testnet proof.
- Adds Node built-in tests for evidence and CI report scripts, plus machine-readable hash manifests and log uploads.

## Example: strict paid-service session

```bash
# Operator A should first advertise 'paid-service' version 2.0.0 in GET /identity.
curl -sS -X POST http://127.0.0.1:4001/admin/sessions \
  -H 'Content-Type: application/json' \
  -d '{"applicationProfile":"paid-service-v2"}'
```

Do not reuse an old `paid-service-v1` signature as a v2 signature. The two rules hashes are intentionally different, so existing v1 evidence remains verifiable on its original terms.

## Portable transcript verification

```bash
npm run build:runtime
npm run verify -- path/to/transcript.json \
  --require-close \
  --expected-operator-a 0x<66_hex_chars> \
  --expected-operator-b 0x<66_hex_chars> \
  --json-report /tmp/eventmesh-assurance.json

# For actual independent payment/anchor verification, also supply:
# --require-fiber --receiver-fiber-rpc <RECEIVER_FNN_RPC>
# --require-ckb --ckb-rpc <CKB_RPC> --ckb-confirmations 2
```

A standalone verifier success without these live RPC flags means **only the requested checks passed**, not that payment settlement or a CKB checkpoint was independently confirmed.

## Test and evidence matrix

| Check | Command or workflow | What it shows |
| --- | --- | --- |
| Build/typecheck/Vitest/demo | `npm run check` | Compilation and current unit/integration tests |
| Evidence-script regression | `npm run test:evidence` | Honest evidence labels, failure-safe reports and traversal prevention |
| Complete checks | `npm run check:all` | Both suites above |
| Hard crash/recovery, conflicts, CKB RPC | `npm run test:faults` | Deterministic local regression, no live funds |
| CI workflow | `EventMesh CI` | Run SHA, status, hashed log, whether dependency installation was locked |
| Security scan | `EventMesh CodeQL` | Static findings, not a comprehensive audit |
| Supply chain | `EventMesh Dependency Audit` | Known dependency vulnerabilities at execution time |
| Offline proof | `EventMesh Offline Transcript Check` | Signed offline proof + pinned keys only |
| Scheduled fault matrix | `EventMesh Crash and Fault Matrix` | Test results, test log SHA, workflow URL |

## Remaining scope / warnings

- Actual Testnet Fiber payment and CKB transaction confirmation **require externally operated nodes and credentials**. They have not been run by this patch.
- The prepared signed CKB transaction is still not persisted across process restarts. The current recovery path retains the transaction hash for read-only reconciliation. Re-broadcasting a newly constructed transaction blindly is unsafe. Implement and test durable exact signed transaction encoding before enabling automatic retries.
- The single-writer JSON store is for single-instance deployment. Do not treat it as multi-replica consensus.
- No production security certification, economic enforcement, escrow or arbitration is claimed. The v2 profile does not make EventMesh a substitute for Fiber.
- The user-supplied ZIP did not include `package-lock.json`, so first-run CI necessarily uses `npm install` and sets `reproducibleInstall: false` until a lockfile is checked in.
