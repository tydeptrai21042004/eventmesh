# Reviewer-focused EventMesh code overlay

**Input:** `eventmesh-main(4).zip` (v0.6.0 source snapshot)

This archive contains **only added or modified files**. It is not a full
repository or an independently installable project. Overlay its root
`eventmesh-main/` directory onto the same directory in the original checkout;
allow replacement of the listed files, and retain all other original files.

## Apply

```bash
# In the original repository, after copying the overlay files into it:
npm install
npm run check:all
npm run demo:receipt -- ./receipt-example.json
npm run verify:receipt -- ./receipt-example.json --require-acceptance
npm run compare:alternatives
```

The first two commands require online/cached dependencies. The only `package.json`
changes are receipt-related scripts and a direct `zod` dependency in the SDK.
`package-lock.json` is **not included** because the supplied snapshot did not
contain one and dependencies could not be resolved reproducibly in the patch
build environment. Generate/review/commit it from the full repository, then
switch CI to `npm ci` if desired.

Read `docs/REVIEW_RESPONSE_IMPLEMENTATION.md` for scope, verification
limitations, alternatives, and the required real-FNN validation milestone.

**Compatibility:** the original v1 paid-service profile and signed transcripts
are unchanged. The opt-in `applicationProfile: "paid-service"` maps to the
existing strict v2 rules. No CKB/Fiber mainnet transaction is created by the
new receipt demo or comparison suite.
