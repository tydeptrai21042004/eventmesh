import { mkdirSync } from "node:fs";
import { FiberRpcClient } from "@eventmesh/fiber";
import { CkbAnchorClient } from "@eventmesh/ckb";
import { buildOperatorApp } from "./app.js";
import { parseCorsOrigins } from "./security.js";

const name = process.env.OPERATOR_NAME ?? "operator";
const port = Number(process.env.PORT ?? 4000);
const selfUrl = process.env.SELF_URL ?? `http://localhost:${port}`;
const dataDir = process.env.DATA_DIR ?? `.data/${name}`;
mkdirSync(dataDir, { recursive: true });

const publicMode = process.env.PUBLIC_MODE === "true";
const allowPrivatePeerUrls = process.env.ALLOW_PRIVATE_PEER_URLS === "true" || !publicMode;
const allowedPeerHosts = new Set<string>((process.env.PEER_HOST_ALLOWLIST ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean));

const fiberEnabled = process.env.FIBER_ENABLED === "true" && !!process.env.FIBER_RPC_URL;
const fiber = fiberEnabled
  ? new FiberRpcClient(
      process.env.FIBER_RPC_URL!,
      process.env.FIBER_RPC_TOKEN || undefined,
      Number(process.env.FIBER_RPC_TIMEOUT_MS ?? 10_000)
    )
  : undefined;

const ckbEnabled = process.env.CKB_ENABLED === "true" && !!process.env.CKB_PRIVATE_KEY;
const ckb = ckbEnabled
  ? new CkbAnchorClient(
      process.env.CKB_PRIVATE_KEY!,
      process.env.CKB_RPC_URL || undefined,
      Number(process.env.CKB_ANCHOR_CAPACITY_CKB ?? 220)
    )
  : undefined;

const { app } = await buildOperatorApp({
  name,
  selfUrl,
  dataDir,
  defaultPeerUrl: process.env.DEFAULT_PEER_URL,
  operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY,
  publicMode,
  allowPrivatePeerUrls,
  allowedPeerHosts,
  adminToken: process.env.ADMIN_TOKEN,
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  requestTimeoutMs: Number(process.env.PEER_REQUEST_TIMEOUT_MS ?? 10_000),
  fiber,
  ckb,
  ckbRpcUrl: process.env.CKB_RPC_URL,
  autoAnchorOnClose: process.env.CKB_AUTO_ANCHOR_ON_CLOSE === "true"
});

await app.listen({ port, host: process.env.BIND_HOST ?? "0.0.0.0" });
