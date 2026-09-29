import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
export const DEMO_STATE_PATH = configuredPath
  ? resolve(configuredPath)
  : isVercel
    ? "/tmp/eventmesh-demo-state.json"
    : resolve(process.cwd(), ".data/eventmesh-demo-state.json");

export const DEMO_STORAGE_MODE = isVercel ? "ephemeral-json" : "local-json";
export const DEMO_STORAGE_DURABLE = false;

const requestedMaxBytes = Number(process.env.DEMO_STATE_MAX_BYTES || 4 * 1024 * 1024);
const MAX_STORE_BYTES = Number.isFinite(requestedMaxBytes)
  ? Math.min(Math.max(Math.floor(requestedMaxBytes), 256 * 1024), 32 * 1024 * 1024)
  : 4 * 1024 * 1024;
let queue: Promise<unknown> = Promise.resolve();

function validateStore(value: any): DemoStore {
  if (!value || value.version !== 1 || typeof value.sessions !== "object" || typeof value.events !== "object") {
    throw new Error("DEMO_STATE_FILE_INVALID");
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

async function readStoreUnsafe(): Promise<DemoStore> {
  try {
    const raw = await readFile(DEMO_STATE_PATH, "utf8");
    if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error("DEMO_STATE_FILE_TOO_LARGE");
    return validateStore(JSON.parse(raw));
  } catch (error: any) {
    if (error?.code === "ENOENT") return EMPTY_STORE();
    if (error instanceof SyntaxError) throw new Error("DEMO_STATE_FILE_CORRUPT");
    throw error;
  }
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

async function writeStoreUnsafe(store: DemoStore) {
  prune(store);
  const body = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_STORE_BYTES) throw new Error("DEMO_STATE_LIMIT_REACHED");
  await mkdir(dirname(DEMO_STATE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${DEMO_STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, DEMO_STATE_PATH);
  await chmod(DEMO_STATE_PATH, 0o600).catch(() => undefined);
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

export async function readDemoStore<T>(fn: (store: DemoStore) => T | Promise<T>): Promise<T> {
  return serialized(async () => fn(await readStoreUnsafe()));
}

export async function mutateDemoStore<T>(fn: (store: DemoStore) => T | Promise<T>): Promise<T> {
  return serialized(async () => {
    const store = await readStoreUnsafe();
    const result = await fn(store);
    await writeStoreUnsafe(store);
    return result;
  });
}

export async function ensureDemoStoreWritable() {
  return mutateDemoStore((store) => ({
    mode: DEMO_STORAGE_MODE,
    durable: DEMO_STORAGE_DURABLE,
    path: isVercel ? "/tmp/eventmesh-demo-state.json" : DEMO_STATE_PATH,
    sessionCount: Object.keys(store.sessions).length
  }));
}
