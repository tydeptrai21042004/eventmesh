# EventMesh v0.6 feature summary

## UX

- Dedicated **Demo** and **Real / Testnet** workspace switcher.
- Different hero copy, capabilities, warnings, CTAs, and persistence semantics by workspace.
- Real/Testnet readiness dashboard for operator configuration, CKB RPC, Fiber receiver, and CKB broadcaster.
- Memory-only Testnet access credential with show/hide control.
- Session expiry, workspace, progress, event count, sync, and status in one compact session bar.
- Stale-write recovery through **Sync now**.
- Same-browser fork warning and **Take control** action.
- Searchable, expandable signed event timeline with payload inspection.
- Evidence JSON export with manifest metadata and audit-summary copy.
- Evidence import remains signature/hash-chain verified before adoption.

## Security/stability

- Testnet mutations require a server-configured access key.
- Explicit operator keys are required for Testnet; derived preview keys are used only by Demo.
- Workspace environment is signed into the session.
- Optimistic event-count + chain-tip preconditions protect mutations.
- Server-side event allow-list, event-order rules, sender rules, hash validation, and payload bounds.
- CKB broadcasting is Testnet-workspace-only and off by default.
- Stronger response/browser security headers.
- Database-free portable recovery is retained.
