import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../apps/operator/src/store.js";
import { loadIdentity } from "../apps/operator/src/identity.js";
import { pinnedPeerFetch } from "../apps/operator/src/peer-http.js";
import { resolvePeerUrl } from "../apps/operator/src/security.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function newDir() { const dir = mkdtempSync(join(tmpdir(), "eventmesh-hardening-")); dirs.push(dir); return dir; }

describe("crash safety, privacy and single-writer operation", () => {
  it("rejects simultaneous writers, releases the lock on close and allows reopening", () => {
    const path = join(newDir(), "state.json");
    const first = new Store(path);
    expect(() => new Store(path)).toThrow("EVENTMESH_STORE_ALREADY_LOCKED");
    first.close();
    expect(existsSync(`${path}.lock`)).toBe(false);
    const second = new Store(path);
    expect(second.listSessions()).toEqual([]);
    second.close();
  });

  it("does not erase unreadable/corrupt state and releases its lock on failure", () => {
    const path = join(newDir(), "state.json");
    writeFileSync(path, "{broken-json");
    expect(() => new Store(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{broken-json");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("returns undefined for inherited object keys (prototype-pollution regression)", () => {
    const store = new Store(join(newDir(), "state.json"));
    expect(store.getSession("__proto__")).toBeUndefined();
    expect(store.getEvent("constructor")).toBeUndefined();
    expect(store.getOutbox("toString")).toBeUndefined();
    store.close();
  });

  it("does not generate an unannounced new operator identity in public mode", () => {
    const dir = newDir();
    expect(() => loadIdentity(dir, undefined, true)).toThrow("PUBLIC_MODE_REQUIRES_EXISTING_OPERATOR_IDENTITY");
    expect(existsSync(join(dir, "operator.key"))).toBe(false);
    const generated = loadIdentity(dir);
    expect(loadIdentity(dir, undefined, true).publicKey).toBe(generated.publicKey);
    rmSync(join(dir, "operator.key"));
    expect(() => loadIdentity(dir)).toThrow("OPERATOR_IDENTITY_KEY_MISSING_RESTORE_REQUIRED");
  });
});

describe("pinned peer transport", () => {
  it("uses the same checked IP for socket establishment", async () => {
    const checked = await resolvePeerUrl("http://127.0.0.1:4010", { publicMode: false, allowPrivatePeerUrls: true });
    expect(checked.address).toBe("127.0.0.1");
    expect(checked.family).toBe(4);
  });

  it("caps peer responses without allowing an unbounded JSON download", async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end("x".repeat(2000)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const info = server.address();
      if (!info || typeof info === "string") throw new Error("No port");
      await expect(pinnedPeerFetch(`http://127.0.0.1:${info.port}/identity`, {
        publicMode: false, allowPrivatePeerUrls: true, timeoutMs: 1000, maxResponseBytes: 1024
      })).rejects.toThrow("PEER_RESPONSE_TOO_LARGE");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
