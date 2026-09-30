import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("one-project Vercel deployment contract", () => {
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

  it("includes the Neon serverless driver and durable deployment variables", () => {
    const root = readJson("package.json");
    expect(root.dependencies["@neondatabase/serverless"]).toBe("1.1.0");
    const example = readFileSync(".env.example", "utf8");
    expect(example).toMatch(/^DATABASE_URL=/m);
    expect(example).toMatch(/^ALLOW_EPHEMERAL_VERCEL_STATE=false$/m);
  });

  it("does not expose secrets through VITE_ variables", () => {
    const example = readFileSync(".env.example", "utf8");
    expect(example).not.toMatch(/^VITE_.*(?:SECRET|PRIVATE|TOKEN)/m);
  });
});
