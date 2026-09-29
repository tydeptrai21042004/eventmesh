const base = String(process.argv[2] || process.env.EVENTMESH_URL || "").replace(/\/$/, "");
if (!base) {
  console.error("Usage: node scripts/verify-deployment.mjs https://your-deployment.vercel.app");
  process.exit(2);
}

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

const health = await get("/api/health?deep=1");
console.log("health", JSON.stringify(health, null, 2));
if (!health.database?.reachable) throw new Error("Neon/Postgres is not reachable");
if (!health.security?.masterSecretConfigured) throw new Error("DEMO_MASTER_SECRET is missing");

const runtime = await get("/api/demo");
console.log("demo", JSON.stringify({ ok: runtime.ok, version: runtime.version, database: runtime.database }, null, 2));

const suffix = crypto.randomUUID();
const created = await post({ action: "create_session", idempotencyKey: `deploy-smoke-${suffix}` });
const sessionId = created.sessionId;
await post({ action: "append_event", sessionId, sender: "A", type: "DEPLOYMENT_SMOKE", payload: { source: "verify-deployment" }, idempotencyKey: `${sessionId}:smoke` });
const closed = await post({ action: "close_session", sessionId, finalState: { smoke: true }, idempotencyKey: `${sessionId}:close` });
if (closed.state?.status !== "CLOSED") throw new Error("Smoke session did not close");
console.log(`PASS EventMesh signed-session smoke test: ${sessionId}`);
console.log(`CKB RPC: ${health.ckb?.reachable ? "reachable" : "not reachable"}; signer: ${health.ckb?.signerConfigured ? "configured" : "not configured"}`);
console.log(`Fiber receiver: ${health.fiber?.reachable ? "reachable" : health.fiber?.configured ? "configured but unreachable" : "not configured"}`);
