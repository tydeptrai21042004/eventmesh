import type { ServerResponse } from "node:http";
import { ensureDemoStoreWritable, DEMO_STORAGE_DURABLE, DEMO_STORAGE_MODE } from "./demo-store.js";

const DEFAULT_CKB_TESTNET_RPC = process.env.CKB_RPC_URL || "https://testnet.ckbapp.dev/";

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.end(JSON.stringify(body));
}

function safeMessage(error: unknown) {
  return String((error as any)?.message || error || "UNKNOWN_ERROR")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 300);
}

async function rpc(url: string, method: string, params: unknown[] = [], token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = await response.json() as any;
  if (body?.error) throw new Error(`RPC_${body.error.code ?? "ERROR"}:${body.error.message ?? "unknown"}`);
  return body?.result;
}

export default async function handler(req: any, res: ServerResponse) {
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const deep = new URL(req.url || "/api/health", "https://eventmesh.local").searchParams.get("deep") === "1";
  const masterSecret = process.env.DEMO_MASTER_SECRET?.trim();

  const status: any = {
    ok: true,
    service: "eventmesh",
    version: "0.4.2",
    runtime: `node-${process.versions.node}`,
    timestamp: new Date().toISOString(),
    storage: {
      mode: DEMO_STORAGE_MODE,
      durable: DEMO_STORAGE_DURABLE,
      writable: false,
      warning: DEMO_STORAGE_DURABLE
        ? undefined
        : process.env.VERCEL
          ? "Durable DATABASE_URL is required on Vercel unless ALLOW_EPHEMERAL_VERCEL_STATE=true is explicitly set."
          : "Local JSON storage is intended for single-process development only."
    },
    fiber: { configured: !!process.env.FIBER_RECEIVER_RPC_URL, reachable: false },
    ckb: {
      rpcConfigured: !!process.env.CKB_RPC_URL,
      rpcMode: process.env.CKB_RPC_URL ? "custom" : "default-testnet",
      reachable: false,
      signerConfigured: !!process.env.CKB_PRIVATE_KEY,
      broadcastEnabled: process.env.DEMO_ALLOW_CKB_BROADCAST === "true"
    },
    security: {
      masterSecretConfigured: !!masterSecret && masterSecret.length >= 32,
      masterSecretStrongEnough: !!masterSecret && masterSecret.length >= 32,
      operatorAKeyConfigured: !!process.env.OPERATOR_A_PRIVATE_KEY,
      operatorBKeyConfigured: !!process.env.OPERATOR_B_PRIVATE_KEY
    }
  };

  if (!deep) {
    const ready = status.security.masterSecretConfigured && (DEMO_STORAGE_DURABLE || !process.env.VERCEL || process.env.ALLOW_EPHEMERAL_VERCEL_STATE === "true");
    return json(res, 200, {
      ok: ready,
      service: "eventmesh",
      version: "0.4.2",
      status: ready ? "ready" : "unavailable",
      network: "CKB Testnet"
    });
  }

  try {
    const storage = await ensureDemoStoreWritable();
    status.storage.writable = true;
    status.storage.sessionCount = storage.sessionCount;
    status.storage.durable = storage.durable;
    if ("schemaVersion" in storage) status.storage.schemaVersion = storage.schemaVersion;
    if ("revision" in storage) status.storage.revision = storage.revision;
  } catch (error) {
    status.storage.error = safeMessage(error);
  }

  try {
    const tip = await rpc(DEFAULT_CKB_TESTNET_RPC, "get_tip_header");
    status.ckb.reachable = !!tip;
    status.ckb.tipNumber = tip?.number;
  } catch (error) {
    status.ckb.error = safeMessage(error);
  }

  if (process.env.FIBER_RECEIVER_RPC_URL) {
    try {
      const info = await rpc(
        process.env.FIBER_RECEIVER_RPC_URL,
        "node_info",
        [],
        process.env.FIBER_RECEIVER_RPC_TOKEN || undefined
      );
      status.fiber.reachable = !!info;
      status.fiber.version = info?.version;
      status.fiber.pubkey = info?.pubkey;
    } catch (error) {
      status.fiber.error = safeMessage(error);
    }
  } else {
    status.fiber.error = "FIBER_RECEIVER_RPC_URL_NOT_CONFIGURED";
  }

  status.coreReady = status.storage.writable && status.security.masterSecretConfigured;
  status.testnetReady = status.coreReady && status.ckb.reachable;
  status.ok = status.coreReady;
  return json(res, 200, status);
}
