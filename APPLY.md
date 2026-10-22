# EventMesh CI fix: Vercel-only environment variables

Replace `tests/vercel-config.test.ts` with the file in this patch. Do not create or commit any `.env` or `.env.example` file. Leave `.github/workflows/eventmesh.yml` unchanged.

The two affected Vitest checks now inspect the actual server, client and Vercel configuration. They can run in CI without deployment secrets. They cannot validate values stored in the Vercel dashboard, and a deployed application still needs its actual Vercel environment variables.

Run `npm run check:all` and push the change. The single GitHub Actions workflow will run automatically.
