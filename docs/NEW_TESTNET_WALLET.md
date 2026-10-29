# EventMesh Testnet wallet (public address only)

CKB Pudge Testnet address (committed in `config/testnet-wallet.json`):

```
ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqfpd6vdtgrjylyz4qn8r0rzxy7dza28xhcsqmqam
```

Faucet: https://faucet.nervos.org/

## GitHub Actions signing key

1. Retrieve the private signing key from your **separate private file**, provided outside the source-code patch.
2. In the repository navigate to **Settings → Secrets and variables → Actions → New repository secret**.
3. Name: `CKB_TESTNET_PRIVATE_KEY`.
4. Value: the 32-byte hex private key (`0x` followed by 64 hexadecimal characters).
5. Never commit the key, attach it to a GitHub issue, or print it in CI logs.

The workflow probes the publicly committed address on pushes and on the schedule, **without spending funds**.
To run its **synthetic-data-only** CKB checkpoint, start **Actions → EventMesh — One CI and Funded Testnet Workflow → Run workflow** and explicitly enable `broadcast_synthetic_anchor`. The job still has `synthetic CKB anchor only` scope and does **not** demonstrate a real Fiber payment.

## Real Fiber-backed checkpoint (separate operation)

The real two-FNN test flow requires **two separately configured Fiber nodes** and operator credentials. Read `docs/CKBUILDERS_FIBER_VALIDATION.md`. Funding this wallet or enabling the synthetic workflow does not create a Fiber payment. For an actual closed-session anchor, the operator accepts a private key via `CKB_PRIVATE_KEY` (read from the environment) and must have `CKB_ENABLED=true` plus the separately controlled broadcast settings.

## Security notes

- Only send **testnet CKB** to this address, never mainnet CKB or any valuable assets.
- Older public demo wallets/keys should not be reused: keys in public Git history are compromised for custody purposes.
- This wallet was generated for Testnet experiments; for stronger security, generate a wallet locally using a trusted wallet application and commit only the resulting address/lock script.
- Testnet funds and a CKB transaction are different from verified Fiber payment evidence.
