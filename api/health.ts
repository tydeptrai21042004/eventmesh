import type { ServerResponse } from "node:http";

const DEFAULT_CKB_TESTNET_RPC = process.env.CKB_RPC_URL || "https://testnet.ckbapp.dev/";

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

function safeMessage(error: unknown) {
  return String((error as any)?.message || error || "UNKNOWN_ERROR")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
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
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;

  const status: any = {
    ok: true,
    service: "eventmesh",
    version: "0.4.0",
    runtime: `node-${process.versions.node}`,
    timestamp: new Date().toISOString(),
    database: { configured: !!databaseUrl, reachable: false },
    fiber: { configured: !!process.env.FIBER_RECEIVER_RPC_URL, reachable: false },
    ckb: {
      rpcConfigured: !!process.env.CKB_RPC_URL,
      rpcMode: process.env.CKB_RPC_URL ? "custom" : "default-testnet",
      reachable: false,
      signerConfigured: !!process.env.CKB_PRIVATE_KEY
    },
    security: {
      masterSecretConfigured: !!process.env.DEMO_MASTER_SECRET,
      operatorAKeyConfigured: !!process.env.OPERATOR_A_PRIVATE_KEY,
      operatorBKeyConfigured: !!process.env.OPERATOR_B_PRIVATE_KEY
    }
  };

  if (!deep) {
    status.ok = status.database.configured && status.security.masterSecretConfigured;
    return json(res, 200, status);
  }

  if (databaseUrl) {
    try {
      const { default: postgres } = await import("postgres");
      const db = postgres(databaseUrl, { max: 1, connect_timeout: 8, idle_timeout: 2, prepare: false });
      await db`SELECT 1 AS ok`;
      await db.end({ timeout: 1 });
      status.database.reachable = true;
    } catch (error) {
      status.database.error = safeMessage(error);
    }
  } else {
    status.database.error = "DATABASE_URL_NOT_CONFIGURED";
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

  status.coreReady = status.database.reachable && status.security.masterSecretConfigured;
  status.testnetReady = status.coreReady && status.ckb.reachable;
  status.ok = status.coreReady;
  return json(res, 200, status);
}
