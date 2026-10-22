# EventMesh: hardcoded disposable CKB Testnet key

This archive contains ONLY five changed files for the previously supplied `EventMesh_One_Workflow_Ready_To_Push.zip`.

Extract into the root of that EventMesh repository, preserving file paths. Then commit/push to `main`; the existing single `.github/workflows/eventmesh.yml` handles tests and funded synthetic CKB checkpoint checks. There is NO GitHub Secret to configure.

**WARNING:** The private key in `config/testnet-wallet.json` is deliberately public. Anyone with access to repository history can spend that CKB Pudge Testnet wallet's funds. This key must NEVER be used for mainnet or production. Funding this public wallet may result in the 10,000 Testnet CKB being spent by someone else before any test runs.

Local dry-run (requires Node >=22 for built-in tests):

```bash
node --test tests/testnet-autotest.node.test.mjs
node scripts/auto-testnet.mjs probe
```

To run the funded transaction locally you must install dependencies and build packages. The key defaults from config/testnet-wallet.json. GitHub runs automatically after push or on schedule; it may take time and network availability may vary.
