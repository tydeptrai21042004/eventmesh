import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Vercel durable demo-store contract", () => {
  const source = readFileSync("api/demo-store.ts", "utf8");

  it("uses DATABASE_URL and namespaced automatic migrations", () => {
    expect(source).toContain("process.env.DATABASE_URL");
    expect(source).toContain("eventmesh_schema_migrations");
    expect(source).toContain("eventmesh_demo_state");
    expect(source).toContain("ON CONFLICT (version) DO NOTHING");
  });

  it("uses optimistic revision checks for concurrent serverless mutations", () => {
    expect(source).toContain("revision = revision + 1");
    expect(source).toContain("WHERE id = 'main' AND revision = ${revision}");
    expect(source).toContain("DEMO_STATE_CONCURRENT_UPDATE_RETRY_EXHAUSTED");
  });

  it("fails closed on Vercel unless ephemeral state is explicitly opted in", () => {
    expect(source).toContain("ALLOW_EPHEMERAL_VERCEL_STATE");
    expect(source).toContain("DATABASE_URL_REQUIRED_ON_VERCEL");
  });
});
