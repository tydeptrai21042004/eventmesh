# EventMesh one-workflow funded CKB Testnet verification

There is exactly one GitHub Actions YAML file: `.github/workflows/eventmesh.yml`.
The disposable CKB Pudge Testnet private key is deliberately hardcoded in `config/testnet-wallet.json` and included in the repository ZIP. **Everyone who can read the repository can spend this wallet’s Testnet CKB. Never use it on Mainnet or for valuable funds.**

## Wallet receiving 10,000 Testnet CKB

- Network: **CKB Pudge Testnet**, not Mainnet.
- Address: `ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqvf44j50synupy06eclnthv0qfj7nf5zasheddzv`
- Faucet: https://faucet.nervos.org/
- Target funding: **10,000 testnet CKB**. Script needs at least **500 confirmed CKB** before it attempts a transaction.

## One-time setup — no GitHub Secrets

1. Upload/merge the repository into GitHub. Delete the five older workflows (`ci.yml`, `codeql.yml`, `dependency-audit.yml`, `fault-matrix.yml`, `offline-evidence.yml`); keep only `.github/workflows/eventmesh.yml`.
2. Send disposable **Pudge Testnet CKB** to the address above, if you accept that the public key may be spent by anyone who sees the repository.
3. Push to `main` or select **Actions → EventMesh — One CI and Funded Testnet Workflow → Run workflow**. A scheduled check runs approximately every six hours, depending on GitHub availability.

**No secret configuration is required.** The Testnet runner reads `privateKey` from `config/testnet-wallet.json`. Do not add a Mainnet private key. A public repository makes this Testnet wallet unsuitable for holding funds, including the 10,000 CKB requested from the faucet.

The workflow tests TypeScript, Vitest, failure/recovery, built artifacts, dependencies and CodeQL in one YAML file. The Testnet job queries the exact-lock-script balance using the public CKB indexer RPC and attempts a deterministic synthetic checkpoint once the funding threshold is met.

## Real network action and evidence

When wallet capacity is at least 500 CKB **and** the checked-in Testnet key matches the configured address, the workflow signs **one synthetic deterministic EventMesh checkpoint** and broadcasts it to CKB Pudge Testnet. The checkpoint creates a ~220 CKB output controlled by the same test wallet, plus normal network fees. This is not a transfer to another person.

A testnet transaction can be committed while not yet having two confirmations. The runner waits briefly, records the hash, and checks again on future scheduled runs. The workflow caches the prepared transaction identity and never automatically rebroadcasts if it cannot establish whether the first broadcast succeeded. The on-chain checkpoint data is deterministic and the runner scans for an existing matching live cell before constructing another transaction.

Download the workflow artifact `eventmesh-testnet-<run_id>` for a machine-readable `report.json`. Results include `WAITING_FOR_FUNDS`, `MISSING_TESTNET_KEY`, `FUNDED_READY_TO_TEST`, `CONFIRMED`, `AWAITING_CONFIRMATIONS`, `PENDING_REQUIRES_FOLLOWUP`, `RPC_UNAVAILABLE`, or an explicit error/recovery state.

The source is `scripts/auto-testnet.mjs`; a local read-only probe is `node scripts/auto-testnet.mjs probe`. The script does not print the private key, but the key is **public in Git history and downloadable artifacts**. The funded Testnet job does not execute on pull requests.

**Scope limitation:** This proves a real CKB transaction carried a deterministic EventMesh-formatted checkpoint. It does NOT prove the hash was derived from a dual-signed live session, nor that a real Fiber payment occurred. A complete Fiber end-to-end test additionally requires separately provisioned funded Fiber nodes, invoices and receiver-side verification.

**Reliability limitation:** GitHub's cache is not permanent. Chain-state scanning provides an additional duplicate check, but a prepared/unknown transaction with a lost cache can require manual reconciliation. The workflow does not promise absolute exactly-once broadcasting across all outages or indefinitely unavailable indexer data.

## Optional GitHub variable

Use **Settings → Secrets and variables → Actions → Variables** to set `CKB_RPC_URL` if you have a CKB Testnet RPC with the integrated indexer enabled. Default: `https://testnet.ckbapp.dev/`.

## Re-run and review

Check `report.json` and the corresponding Testnet transaction hash before resetting the checkpoint test version or deleting the cache. A new test version can spend more Testnet transaction fees. Never use a Mainnet key/address with this workflow.
