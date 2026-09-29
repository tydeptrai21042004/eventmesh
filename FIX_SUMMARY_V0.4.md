# EventMesh v0.4 Vercel fix summary

## Primary failure fixed

The previous Vercel configuration explicitly ran only `npm run build:demo`. Internal workspace packages such as `@eventmesh/core` and `@eventmesh/fiber` exported raw TypeScript as runtime entry points, so `/api/demo` could fail before the handler returned JSON. The browser then blindly parsed Vercel's text error and surfaced `Unexpected token 'A'`.

v0.4 now:

- compiles runtime workspace packages to `dist/*.js`;
- makes Vercel run `npm run vercel-build`;
- adds a standalone `/api/health?deep=1` diagnostic endpoint;
- makes the UI tolerate non-JSON platform errors and explain where to look;
- lets `/api/demo` report database readiness as JSON instead of failing the whole GET path.

## Deployment improvements

- Neon/serverless Postgres uses a small pool and `prepare: false` for broad pooler compatibility.
- CKB reads default to `https://testnet.ckbapp.dev/`.
- CKB signing remains disabled until a Testnet private key is supplied.
- ambiguous CKB broadcasts preserve a recovered transaction hash when available.
- Fiber receiver readiness is probed using `node_info`.
- `PAYMENT_SETTLED` remains fail-closed and now rejects session-mismatched payment claims before contacting Fiber.
- malformed operator private keys become configuration errors instead of module-load crashes.
- state-changing public API calls require `DEMO_MASTER_SECRET`.
- request bodies are limited to 64 KiB.

## Automation added

```bash
./scripts/generate-env.sh
./scripts/deploy-vercel-testnet.sh
```

The deployment script runs install/check/build, links Vercel, uploads env vars, deploys, runs deep health checks, then performs a signed create/event/close smoke test against the deployed URL.
