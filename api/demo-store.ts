import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type DemoStore = {
  version: 1;
  sessions: Record<string, any>;
  events: Record<string, any[]>;
  paymentClaims: Record<string, any>;
  paymentEvidence: Record<string, any>;
  idempotency: Record<string, { requestHash: string; response: any; createdAt: string }>;
  anchorOps: Record<string, any>;
  rateLimits: Record<string, { count: number; updatedAt: string }>;
};

const EMPTY_STORE = (): DemoStore => ({
  version: 1,
  sessions: {},
  events: {},
  paymentClaims: {},
  paymentEvidence: {},
  idempotency: {},
  anchorOps: {},
  rateLimits: {}
});

const isVercel = !!process.env.VERCEL;
const configuredPath = process.env.DEMO_STATE_FILE?.trim();

/**
 * The Vercel demo intentionally does not require a database. /tmp is only a
 * process-local cache; signed snapshots carried by the browser are the recovery
 * mechanism across cold starts/instances. Production operators should use the
 * standalone operator service with their own durable storage.
 */
export const DEMO_STATE_PATH = configuredPath
  ? resolve(configuredPath)
  : isVercel
    ? "/tmp/eventmesh-preview-state.json"
    : resolve(process.cwd(), ".data/eventmesh-demo-state.json");

export const DEMO_STORAGE_MODE = isVercel ? "ephemeral-preview" : "local-json";
export const DEMO_STORAGE_DURABLE = false;

const requestedMaxBytes = Number(process.env.DEMO_STATE_MAX_BYTES || 4 * 1024 * 1024);
const MAX_STORE_BYTES = Number.isFinite(requestedMaxBytes)
  ? Math.min(Math.max(Math.floor(requestedMaxBytes), 256 * 1024), 32 * 1024 * 1024)
  : 4 * 1024 * 1024;
let localQueue: Promise<unknown> = Promise.resolve();

function validateStore(value: any): DemoStore {
  if (!value || value.version !== 1 || typeof value.sessions !== "object" || typeof value.events !== "object") {
    throw new Error("DEMO_STATE_INVALID");
  }
  return {
    ...EMPTY_STORE(),
    ...value,
    sessions: value.sessions || {},
    events: value.events || {},
    paymentClaims: value.paymentClaims || {},
    paymentEvidence: value.paymentEvidence || {},
    idempotency: value.idempotency || {},
    anchorOps: value.anchorOps || {},
    rateLimits: value.rateLimits || {}
  };
}

function prune(store: DemoStore) {
  const now = Date.now();
  const idemCutoff = now - 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(store.idempotency)) {
    if (Date.parse(value.createdAt) < idemCutoff) delete store.idempotency[key];
  }

  const rateCutoff = now - 2 * 60 * 1000;
  for (const [key, value] of Object.entries(store.rateLimits)) {
    if (Date.parse(value.updatedAt) < rateCutoff) delete store.rateLimits[key];
  }

  const sessions = Object.entries(store.sessions)
    .sort((a: any, b: any) => Date.parse(b[1]?.createdAt || 0) - Date.parse(a[1]?.createdAt || 0));
  for (const [sessionId] of sessions.slice(100)) {
    delete store.sessions[sessionId];
    delete store.events[sessionId];
    delete store.anchorOps[sessionId];
    for (const [hash, value] of Object.entries(store.paymentClaims) as any) {
      if (value?.sessionId === sessionId) delete store.paymentClaims[hash];
    }
    for (const [hash, value] of Object.entries(store.paymentEvidence) as any) {
      if (value?.sessionId === sessionId) delete store.paymentEvidence[hash];
    }
  }
}

function serializedLocal<T>(work: () => Promise<T>): Promise<T> {
  const next = localQueue.then(work, work);
  localQueue = next.then(() => undefined, () => undefined);
  return next;
}

function assertStoreSize(store: DemoStore) {
  const body = JSON.stringify(store);
  if (Buffer.byteLength(body) > MAX_STORE_BYTES) throw new Error("DEMO_STATE_LIMIT_REACHED");
  return body;
}

async function readLocalStoreUnsafe(): Promise<DemoStore> {
  try {
    const raw = await readFile(DEMO_STATE_PATH, "utf8");
    if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error("DEMO_STATE_FILE_TOO_LARGE");
    return validateStore(JSON.parse(raw));
  } catch (error: any) {
    if (error?.code === "ENOENT") return EMPTY_STORE();
    if (error instanceof SyntaxError) {
      // A disposable preview should recover from a torn/old cache rather than
      // becoming permanently unavailable. Signed client snapshots can rebuild it.
      await unlink(DEMO_STATE_PATH).catch(() => undefined);
      return EMPTY_STORE();
    }
    throw error;
  }
}

async function writeLocalStoreUnsafe(store: DemoStore) {
  prune(store);
  const body = `${assertStoreSize(store)}\n`;
  await mkdir(dirname(DEMO_STATE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${DEMO_STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, DEMO_STATE_PATH);
  await chmod(DEMO_STATE_PATH, 0o600).catch(() => undefined);
}

export async function readDemoStore<T>(fn: (store: DemoStore) => T | Promise<T>): Promise<T> {
  return serializedLocal(async () => fn(await readLocalStoreUnsafe()));
}

export async function mutateDemoStore<T>(fn: (store: DemoStore) => T | Promise<T>): Promise<T> {
  return serializedLocal(async () => {
    const store = await readLocalStoreUnsafe();
    const result = await fn(store);
    await writeLocalStoreUnsafe(store);
    return result;
  });
}

export async function clearDemoSession(sessionId: string) {
  return mutateDemoStore((store) => {
    delete store.sessions[sessionId];
    delete store.events[sessionId];
    delete store.anchorOps[sessionId];
    for (const [hash, value] of Object.entries(store.paymentClaims) as any) {
      if (value?.sessionId === sessionId) delete store.paymentClaims[hash];
    }
    for (const [hash, value] of Object.entries(store.paymentEvidence) as any) {
      if (value?.sessionId === sessionId) delete store.paymentEvidence[hash];
    }
    for (const key of Object.keys(store.idempotency)) {
      if (key.includes(sessionId)) delete store.idempotency[key];
    }
    return { ok: true };
  });
}

export async function ensureDemoStoreWritable() {
  return mutateDemoStore((store) => ({
    mode: DEMO_STORAGE_MODE,
    durable: false,
    path: isVercel ? "/tmp/eventmesh-preview-state.json" : DEMO_STATE_PATH,
    sessionCount: Object.keys(store.sessions).length
  }));
}
