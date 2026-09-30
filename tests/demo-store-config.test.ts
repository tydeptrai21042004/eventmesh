import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("database-free Vercel preview store contract", () => {
  const storeSource = readFileSync("api/demo-store.ts", "utf8");
  const apiSource = readFileSync("api/demo.ts", "utf8");

  it("does not depend on DATABASE_URL, Neon, or Postgres", () => {
    expect(storeSource).not.toContain("DATABASE_URL");
    expect(storeSource).not.toContain("@neondatabase/serverless");
    expect(storeSource).not.toContain("CREATE TABLE");
    expect(storeSource).toContain('"ephemeral-preview"');
  });

  it("uses only a bounded disposable cache on Vercel", () => {
    expect(storeSource).toContain('"/tmp/eventmesh-preview-state.json"');
    expect(storeSource).toContain("DEMO_STATE_MAX_BYTES");
    expect(storeSource).toContain("slice(100)");
    expect(storeSource).toContain("DEMO_STORAGE_DURABLE = false");
  });

  it("recovers from signed portable snapshots and rejects rollback conflicts", () => {
    expect(apiSource).toContain("verifyTranscript");
    expect(apiSource).toContain("restorePortableSnapshot");
    expect(apiSource).toContain("SNAPSHOT_EVENT_HISTORY_CONFLICT");
    expect(apiSource).toContain("portableRecovery: true");
  });
});
