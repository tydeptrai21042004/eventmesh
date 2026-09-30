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
if (!health.storage?.writable) throw new Error("JSON preview storage is not writable");
if (!health.security?.masterSecretStrongEnough) throw new Error("Configured DEMO_MASTER_SECRET is invalid");

const runtime = await get("/api/demo");
if (!runtime.ok) throw new Error("Preview API reports unavailable");
console.log("demo", JSON.stringify({ ok: runtime.ok, version: runtime.version, signerMode: runtime.signerMode, storage: runtime.storage }, null, 2));

const suffix = crypto.randomUUID();
const completed = await post({
  action: "run_reference_flow",
  idempotencyKey: `deploy-reference-${suffix}`,
  requestId: `smoke-${suffix.slice(0, 8)}`,
  service: "deployment-smoke"
});
if (completed.state?.status !== "CLOSED") throw new Error("Reference flow did not close");
const sessionId = completed.sessionId;
const verified = await post({ action: "verify_evidence", sessionId });
if (!verified.ok) throw new Error(`Evidence verification failed: ${(verified.verification?.errors || []).join(", ")}`);
console.log(`PASS EventMesh reference flow + evidence verification: ${sessionId}`);
console.log(`Signer mode: ${runtime.signerMode}; storage: ${runtime.storage?.mode} (durable=${runtime.storage?.durable})`);
console.log(`CKB RPC: ${health.ckb?.reachable ? "reachable" : "not reachable"}; signer: ${health.ckb?.signerConfigured ? "configured" : "not configured"}`);
console.log(`Fiber receiver: ${health.fiber?.reachable ? "reachable" : health.fiber?.configured ? "configured but unreachable" : "not configured"}`);
