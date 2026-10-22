# EventMesh TS2322 build fix

Replace only `api/demo.ts` in the root of your existing eventmesh repository with the included file.

Changed: one line (`const session` is explicitly typed as `SignedSession["session"]`).

This change does not modify `.github/workflows/eventmesh.yml`, package files, or wallet configuration.

To check and commit:

```bash
npm run check:all
git add api/demo.ts
git commit -m "fix: preserve typed session protocol literal"
git push origin main
```

If new errors arise, use the next CI log to identify the next failing check.
