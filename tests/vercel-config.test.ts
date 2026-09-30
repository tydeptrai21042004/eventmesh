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
    const example = readFileSync(".env.example", "utf8");
    expect(example).not.toMatch(/^DATABASE_URL=/m);
    expect(example).not.toMatch(/^ALLOW_EPHEMERAL_VERCEL_STATE=/m);
    expect(example).toMatch(/^DEMO_MASTER_SECRET=/m);
  });

  it("does not expose secrets through VITE_ variables", () => {
    const example = readFileSync(".env.example", "utf8");
    expect(example).not.toMatch(/^VITE_.*(?:SECRET|PRIVATE|TOKEN)/m);
  });
});
