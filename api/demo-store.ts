import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

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
const databaseUrl = process.env.DATABASE_URL?.trim();
const allowEphemeralVercel = process.env.ALLOW_EPHEMERAL_VERCEL_STATE === "true";
const configuredPath = process.env.DEMO_STATE_FILE?.trim();

export const DEMO_STATE_PATH = configuredPath
  ? resolve(configuredPath)
  : isVercel
    ? "/tmp/eventmesh-demo-state.json"
    : resolve(process.cwd(), ".data/eventmesh-demo-state.json");

export const DEMO_STORAGE_MODE = databaseUrl
  ? "postgres-jsonb"
  : isVercel
    ? allowEphemeralVercel ? "ephemeral-json" : "unconfigured"
    : "local-json";
export const DEMO_STORAGE_DURABLE = !!databaseUrl;

const requestedMaxBytes = Number(process.env.DEMO_STATE_MAX_BYTES || 4 * 1024 * 1024);
const MAX_STORE_BYTES = Number.isFinite(requestedMaxBytes)
  ? Math.min(Math.max(Math.floor(requestedMaxBytes), 256 * 1024), 32 * 1024 * 1024)
  : 4 * 1024 * 1024;
const CAS_RETRIES = 8;
const sql = databaseUrl ? neon(databaseUrl) : undefined;
let schemaReady: Promise<void> | undefined;
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

function assertStorageConfigured() {
  if (isVercel && !databaseUrl && !allowEphemeralVercel) {
    throw new Error("DATABASE_URL_REQUIRED_ON_VERCEL");
  }
}

function assertStoreSize(store: DemoStore) {
  const body = JSON.stringify(store);
  if (Buffer.byteLength(body) > MAX_STORE_BYTES) throw new Error("DEMO_STATE_LIMIT_REACHED");
  return body;
}

async function ensurePostgresSchema() {
  if (!sql) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS eventmesh_schema_migrations (
          version integer PRIMARY KEY,
          name text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS eventmesh_demo_state (
          id text PRIMARY KEY,
          revision bigint NOT NULL DEFAULT 0,
          state jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT eventmesh_demo_state_singleton CHECK (id = 'main')
        )
      `;
      await sql`
        INSERT INTO eventmesh_demo_state (id, revision, state)
        VALUES ('main', 0, ${JSON.stringify(EMPTY_STORE())}::jsonb)
        ON CONFLICT (id) DO NOTHING
      `;
      await sql`
        INSERT INTO eventmesh_schema_migrations (version, name)
        VALUES (1, 'durable_demo_state')
        ON CONFLICT (version) DO NOTHING
      `;
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

async function readPostgresSnapshot() {
  await ensurePostgresSchema();
  if (!sql) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  const rows = await sql`
    SELECT revision, state
    FROM eventmesh_demo_state
    WHERE id = 'main'
  ` as any[];
  const row = rows[0];
  if (!row) throw new Error("DEMO_STATE_ROW_MISSING");
  return {
    revision: Number(row.revision),
    store: validateStore(row.state)
  };
}

async function readLocalStoreUnsafe(): Promise<DemoStore> {
  assertStorageConfigured();
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

async function writeLocalStoreUnsafe(store: DemoStore) {
  prune(store);
  const body = `${assertStoreSize(store)}\n`;
  await mkdir(dirname(DEMO_STATE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${DEMO_STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, DEMO_STATE_PATH);
  await chmod(DEMO_STATE_PATH, 0o600).catch(() => undefined);
}

async function mutatePostgres<T>(fn: (store: DemoStore) => T | Promise<T>): Promise<T> {
  if (!sql) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { revision, store } = await readPostgresSnapshot();
    const result = await fn(store);
    prune(store);
    const body = assertStoreSize(store);
    const updated = await sql`
      UPDATE eventmesh_demo_state
      SET revision = revision + 1,
          state = ${body}::jsonb,
          updated_at = now()
      WHERE id = 'main' AND revision = ${revision}
      RETURNING revision
    ` as any[];
    if (updated.length === 1) return result;
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20) * (attempt + 1)));
  }
  throw new Error("DEMO_STATE_CONCURRENT_UPDATE_RETRY_EXHAUSTED");
}

export async function readDemoStore<T>(fn: (store: DemoStore) => T | Promise<T>): Promise<T> {
  if (sql) {
    const { store } = await readPostgresSnapshot();
    return fn(store);
  }
  return serializedLocal(async () => fn(await readLocalStoreUnsafe()));
}

export async function mutateDemoStore<T>(fn: (store: DemoStore) => T | Promise<T>): Promise<T> {
  if (sql) return mutatePostgres(fn);
  return serializedLocal(async () => {
    const store = await readLocalStoreUnsafe();
    const result = await fn(store);
    await writeLocalStoreUnsafe(store);
    return result;
  });
}

export async function ensureDemoStoreWritable() {
  if (sql) {
    const { revision, store } = await readPostgresSnapshot();
    return {
      mode: DEMO_STORAGE_MODE,
      durable: true,
      schemaVersion: 1,
      revision,
      sessionCount: Object.keys(store.sessions).length
    };
  }

  assertStorageConfigured();
  return mutateDemoStore((store) => ({
    mode: DEMO_STORAGE_MODE,
    durable: false,
    path: isVercel ? "/tmp/eventmesh-demo-state.json" : DEMO_STATE_PATH,
    sessionCount: Object.keys(store.sessions).length
  }));
}
