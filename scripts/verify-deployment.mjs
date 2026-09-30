const base = String(process.argv[2] || process.env.EVENTMESH_URL || "").replace(/\/$/, "");
if (!base) {
  console.error("Usage: node scripts/verify-deployment.mjs https://your-deployment.vercel.app");
  process.exit(2);
}

const ZERO_HASH = `0x${"00".repeat(32)}`;

async function get(path) {
  const r = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${path}: non-JSON HTTP ${r.status}: ${text.slice(0, 180)}`); }
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}: ${body.error || text.slice(0, 180)}`);
  return body;
}

async function post(body) {
  const r = await fetch(`${base}/api/demo`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`/api/demo: non-JSON HTTP ${r.status}: ${text.slice(0, 180)}`); }
  if (!r.ok) throw new Error(`/api/demo: HTTP ${r.status}: ${data.error || text.slice(0, 180)}`);
  return data;
}

function precondition(snapshot) {
  const events = snapshot?.events || [];
  return {
    expectedEventCount: events.length,
    expectedChainTip: events.at(-1)?.event?.eventHash || ZERO_HASH
  };
}

async function append(snapshot, sender, type, payload, idempotencyKey) {
  return post({
    action: "append_event",
    sessionId: snapshot.sessionId,
    sender,
    type,
    payload,
    idempotencyKey,
    ...precondition(snapshot),
    snapshot
  });
}

const health = await get("/api/health?deep=1");
console.log("health", JSON.stringify(health, null, 2));
if (!health.storage?.writable) throw new Error("EventMesh preview cache is not writable");
if (!health.security?.masterSecretConfigured) throw new Error("DEMO_MASTER_SECRET is missing");

const runtime = await get("/api/demo");
console.log("demo", JSON.stringify({ ok: runtime.ok, version: runtime.version, storage: runtime.storage, workspaces: runtime.workspaces }, null, 2));
if (!runtime.workspaces?.demo?.ready) throw new Error("EventMesh Demo workspace is not ready");
if (runtime.storage?.durable) throw new Error("Database-free preview unexpectedly reports durable storage");
if (!runtime.storage?.portableRecovery) throw new Error("Portable snapshot recovery is not enabled");
if (!runtime.security?.optimisticChainPreconditions) throw new Error("Chain precondition protection is not enabled");

const suffix = crypto.randomUUID();
const requestId = `deploy-${suffix.slice(0, 10)}`;
const resultHash = `0x${"ab".repeat(32)}`;
const created = await post({ action: "create_session", mode: "demo", idempotencyKey: `deploy-smoke-${suffix}` });
const sessionId = created.sessionId;
let snapshot = created.state;

snapshot = (await append(snapshot, "A", "SERVICE_REQUESTED", { requestId, service: "deployment-smoke" }, `${sessionId}:request`)).state;
snapshot = (await append(snapshot, "B", "SERVICE_ACCEPTED", { requestId }, `${sessionId}:accept`)).state;
snapshot = (await append(snapshot, "B", "RESULT_COMMITTED", { requestId, resultHash }, `${sessionId}:result`)).state;
snapshot = (await append(snapshot, "B", "SESSION_COMPLETED", { requestId }, `${sessionId}:complete`)).state;

const verifiedActive = await post({ action: "verify_snapshot", snapshot });
if (!verifiedActive.ok || verifiedActive.eventCount !== 4) throw new Error("Active portable snapshot verification failed");

const closed = await post({
  action: "close_session",
  sessionId,
  finalState: { kind: "deployment-smoke", requestId, resultHash, completed: true },
  idempotencyKey: `${sessionId}:close`,
  ...precondition(snapshot),
  snapshot
});
snapshot = closed.state;
if (snapshot?.status !== "CLOSED") throw new Error("Smoke session did not close");

const verifiedClosed = await post({ action: "verify_snapshot", snapshot });
if (!verifiedClosed.ok || verifiedClosed.status !== "CLOSED") throw new Error("Closed portable snapshot verification failed");

console.log(`PASS EventMesh v0.6 database-free Demo smoke test: ${sessionId}`);
console.log(`Storage: ${health.storage?.mode}; portable recovery: enabled; stale-write guard: enabled`);
console.log(`CKB RPC: ${health.ckb?.reachable ? "reachable" : "not reachable"}; signer: ${health.ckb?.signerConfigured ? "configured" : "not configured"}`);
console.log(`Fiber receiver: ${health.fiber?.reachable ? "reachable" : health.fiber?.configured ? "configured but unreachable" : "not configured"}`);
console.log(`Real/Testnet workspace: ${runtime.workspaces?.testnet?.ready ? "configured" : "disabled/not fully configured"}`);
