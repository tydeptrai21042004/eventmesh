# EventMesh v0.4.2 preview changes

This patch intentionally keeps the zero-database JSON-file deployment model.

## UX

- removes the misleading `Service unavailable` state when no database or master secret is configured;
- adds a clear file-backed/ephemeral preview-state notice;
- adds one-click **Run full reference demo**;
- resumes the most recent browser session when the backing `/tmp` file still exists;
- adds copy actions for session and commitment identifiers;
- adds progress visualization and richer event inspection;
- fixes CKB anchor transaction rendering to use `txHash`;
- adds transcript/final/payment commitment summary cards;
- exports a verifier-friendly evidence JSON bundle;
- avoids the copied-text `EEventMesh` brand artifact by making the mark graphical.

## Protocol/demo features

- zero-config deterministic demo-only bilateral signing identities;
- optional `DEMO_MASTER_SECRET` for deployment-specific identities;
- server-side `run_reference_flow` action to produce a complete closed reference flow in one request;
- server-side `verify_evidence` action using the existing independent transcript verifier;
- deployment smoke test now runs and verifies the complete reference flow.

## Important limitation

Vercel state is still `/tmp/eventmesh-demo-state.json`. It is intentionally ephemeral and instance-local. This patch improves reviewer usability without making a false durability claim.
