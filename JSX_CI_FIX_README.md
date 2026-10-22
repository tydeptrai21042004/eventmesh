# EventMesh CI JSX TypeScript fix — 2026-10-22

**Cause:** root `tsconfig.json` used by `npm run typecheck` included the React TSX demo but lacked `compilerOptions.jsx`; the root `package.json` also lacked explicit React and React DOM type packages. This caused TS17004 and TS7026 errors.

## Changes
- `tsconfig.json`: set `compilerOptions.jsx` to `react-jsx` (retain `strict: true`).
- `package.json`: add `@types/react` and `@types/react-dom` at 19.3.0, compatible with the React 19 demo.
- `tests/react-toolchain.node.test.mjs`: add dependency-free regression tests for these settings.

**No workflow changes:** your existing `.github/workflows/eventmesh.yml` remains the only workflow; no change to Testnet automation or wallet configuration.

## Apply
Copy the two changed JSON files and the new test into the matching paths in your repo. Do not copy the README unless useful. Then run:

```bash
npm install --no-fund
npm run check:all
npm run test:faults
```

Commit updated `package.json`, `tsconfig.json`, the new regression test, and the generated `package-lock.json` after npm install. If `npm ci` fails with an out-of-date lockfile, regenerate the lockfile with `npm install` and commit it.

## Scope of verification
Static JSON/config and the new dependency-free tests were verified locally. The full npm+React type-check requires dependencies; the package registry was unreachable in the local environment, so GitHub Actions must verify end-to-end.
