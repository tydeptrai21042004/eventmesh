import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("one-project database-free Vercel deployment contract", () => {
  it("builds runtime workspace packages before the demo", () => {
    const root = readJson("package.json");
    expect(root.scripts["vercel-build"]).toContain("build:runtime");
    expect(root.scripts["vercel-build"]).toContain("build:demo");
    expect(root.scripts["vercel-build"].indexOf("build:runtime")).toBeLessThan(
      root.scripts["vercel-build"].indexOf("build:demo")
    );
  });

  it.each(["core", "fiber", "ckb", "adapter-sdk"])("exports compiled JS for %s", (name) => {
    const pkg = readJson(`packages/${name}/package.json`);
    expect(pkg.exports["."].default).toBe("./dist/index.js");
    expect(pkg.scripts.build).toBe("tsc -p tsconfig.json");
  });

  it("uses the runtime-first Vercel build and ships a dedicated health function", () => {
    const config = readJson("vercel.json");
    expect(config.buildCommand).toBe("npm run vercel-build");
    expect(config.functions["api/health.ts"]).toBeTruthy();
  });

  it("has no database dependency or database environment requirement", () => {
    const root = readJson("package.json");
    const operator = readJson("apps/operator/package.json");
    expect(root.dependencies?.["@neondatabase/serverless"]).toBeUndefined();
    expect(operator.dependencies?.["better-sqlite3"]).toBeUndefined();

    // Deployment environment variables live in Vercel, not in a repository .env file.
    const server = ["api/demo.ts", "api/demo-store.ts", "api/health.ts"]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const deployment = readFileSync("vercel.json", "utf8");
    expect(`${server}\n${deployment}`).not.toMatch(/\b(?:DATABASE_URL|ALLOW_EPHEMERAL_VERCEL_STATE)\b/);
    expect(server).toMatch(/process\.env\.DEMO_MASTER_SECRET/);
  });

  it("does not reference secret-prefixed VITE_ variables in frontend or deployment config", () => {
    const client = readFileSync("apps/demo/src/main.tsx", "utf8");
    const deployment = readFileSync("vercel.json", "utf8");
    expect(`${client}\n${deployment}`).not.toMatch(
      /\bVITE_[A-Z0-9_]*(?:SECRET|PRIVATE|TOKEN|PASSWORD|KEY)[A-Z0-9_]*/i
    );
  });
});
