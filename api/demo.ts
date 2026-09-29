import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import {
  PROTOCOL,
  SIGNING_DOMAIN,
  ZERO_HASH,
  acceptedFiberPaymentHashes,
  buildAnchorDataHex,
  canonical,
  computePaymentEvidenceRoot,
  computeTranscriptRoot,
  createSessionId,
  finalStateHashFrom,
  publicKeyFromPrivate,
  sha256Hex,
  signAck,
  signEvent,
  signProtocolObject,
  type FiberPaymentClaim,
  type FiberPaymentEvidence,
  type SignedAck,
  type SignedEvent,
  type SignedSession
} from "@eventmesh/core";
import { FiberRpcClient } from "@eventmesh/fiber";

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
const CKB_TESTNET_RPC_URL = process.env.CKB_RPC_URL || "https://testnet.ckbapp.dev/";
const sql = databaseUrl ? postgres(databaseUrl, {
  max: 3,
  idle_timeout: 10,
  connect_timeout: 10,
  prepare: false
}) : undefined;
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

function derivedKey(label: string) {
  const secret = process.env.DEMO_MASTER_SECRET || "eventmesh-local-demo-change-me";
  const raw = createHmac("sha256", secret).update(label).digest("hex");
  const scalar = (BigInt(`0x${raw}`) % (SECP256K1_N - 1n)) + 1n;
  return `0x${scalar.toString(16).padStart(64, "0")}`;
}

const configurationErrors: string[] = [];
function operatorKey(name: "OPERATOR_A_PRIVATE_KEY" | "OPERATOR_B_PRIVATE_KEY", label: string) {
  const value = process.env[name]?.trim();
  if (!value) return derivedKey(label);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    configurationErrors.push(`${name}_INVALID_FORMAT`);
    return derivedKey(label);
  }
  const scalar = BigInt(value);
  if (scalar <= 0n || scalar >= SECP256K1_N) {
    configurationErrors.push(`${name}_OUT_OF_RANGE`);
    return derivedKey(label);
  }
  return value;
}

const keyA = operatorKey("OPERATOR_A_PRIVATE_KEY", "operator-a");
const keyB = operatorKey("OPERATOR_B_PRIVATE_KEY", "operator-b");
const pubA = publicKeyFromPrivate(keyA);
const pubB = publicKeyFromPrivate(keyB);

let schemaReady: Promise<void> | undefined;
async function ensureSchema() {
  if (!sql) throw new Error("DATABASE_URL_REQUIRED");
  if (!schemaReady) schemaReady = (async () => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS em_demo_sessions(
        session_id TEXT PRIMARY KEY,
        signed_session JSONB NOT NULL,
        status TEXT NOT NULL,
        signed_close JSONB,
        anchor JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS em_demo_events(
        event_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES em_demo_sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        signed_event JSONB NOT NULL,
        ack JSONB,
        status TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS em_demo_payment_claims(
        payment_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        claim JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS em_demo_payment_evidence(
        payment_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        identity_hash TEXT NOT NULL,
        evidence JSONB NOT NULL,
        first_verified_at TIMESTAMPTZ NOT NULL,
        last_verified_at TIMESTAMPTZ NOT NULL,
        verification_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS em_demo_idempotency(
        idem_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        response JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS em_demo_anchor_ops(
        session_id TEXT PRIMARY KEY REFERENCES em_demo_sessions(session_id) ON DELETE CASCADE,
        commitment_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        tx_hash TEXT,
        data_hex TEXT,
        block_hash TEXT,
        error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS em_demo_rate_limits(
        actor_hash TEXT NOT NULL,
        bucket TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY(actor_hash, bucket)
      );
      CREATE INDEX IF NOT EXISTS em_demo_events_session_idx ON em_demo_events(session_id, sequence);
    `);
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

async function bodyOf(req: any) {
  const maxBytes = 64 * 1024;
  const contentLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("REQUEST_BODY_TOO_LARGE");
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (Buffer.byteLength(req.body) > maxBytes) throw new Error("REQUEST_BODY_TOO_LARGE");
    return JSON.parse(req.body || "{}");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as IncomingMessage) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function baseUrl(req: any) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "localhost:3000").split(",")[0].trim();
  return `${proto}://${host}`;
}

function actorHash(req: any) {
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return sha256Hex(`${process.env.DEMO_MASTER_SECRET || "eventmesh"}:${ip}`);
}

async function rateLimit(req: any, limit = Number(process.env.DEMO_RATE_LIMIT_PER_MINUTE || 60)) {
  if (!sql) return;
  const bucket = new Date().toISOString().slice(0, 16);
  const actor = actorHash(req);
  const rows = await sql`
    INSERT INTO em_demo_rate_limits(actor_hash,bucket,count) VALUES(${actor},${bucket},1)
    ON CONFLICT(actor_hash,bucket) DO UPDATE SET count=em_demo_rate_limits.count+1
    RETURNING count
  `;
  if (Number(rows[0]?.count || 0) > limit) throw new Error("RATE_LIMITED");
}

async function loadState(sessionId: string) {
  if (!sql) throw new Error("DATABASE_URL_REQUIRED");
  const sessions = await sql`SELECT * FROM em_demo_sessions WHERE session_id=${sessionId}`;
  if (!sessions.length) throw new Error("SESSION_NOT_FOUND");
  const events = await sql`SELECT * FROM em_demo_events WHERE session_id=${sessionId} ORDER BY sequence`;
  const evidence = await sql`SELECT evidence, first_verified_at, last_verified_at, verification_count FROM em_demo_payment_evidence WHERE session_id=${sessionId} ORDER BY first_verified_at`;
  const op = await sql`SELECT * FROM em_demo_anchor_ops WHERE session_id=${sessionId}`;
  return {
    sessionId,
    status: sessions[0].status,
    signedSession: sessions[0].signed_session,
    events: events.map((r: any) => ({ event: r.signed_event, ack: r.ack, status: r.status })),
    close: sessions[0].signed_close,
    anchor: sessions[0].anchor,
    anchorOperation: op[0] || null,
    paymentEvidence: evidence.map((r: any) => ({ ...r.evidence, firstVerifiedAt: r.first_verified_at, lastVerifiedAt: r.last_verified_at, verificationCount: r.verification_count }))
  };
}

async function withIdempotency(key: string, request: unknown, fn: (tx: any) => Promise<any>) {
  if (!sql) throw new Error("DATABASE_URL_REQUIRED");
  if (!key || key.length > 160) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  const requestHash = sha256Hex(canonical(request));
  return sql.begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const found = await tx`SELECT request_hash,response FROM em_demo_idempotency WHERE idem_key=${key}`;
    if (found.length) {
      if (found[0].request_hash !== requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
      return { ...found[0].response, duplicate: true };
    }
    const result = await fn(tx);
    await tx`INSERT INTO em_demo_idempotency(idem_key,request_hash,response) VALUES(${key},${requestHash},${tx.json(result)})`;
    return result;
  });
}

async function createSession(req: any, input: any) {
  const idem = String(input.idempotencyKey || "");
  return withIdempotency(`create:${idem}`, input, async (tx) => {
    const now = new Date();
    const requestedTtl = Number(input.ttlSeconds ?? 3600);
    const requestedMaxEvents = Number(input.maxEvents ?? 100);
    if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) throw new Error("INVALID_TTL_SECONDS");
    if (!Number.isFinite(requestedMaxEvents) || !Number.isInteger(requestedMaxEvents)) throw new Error("INVALID_MAX_EVENTS");
    const ttlSeconds = Math.min(Math.max(requestedTtl, 1), 86400);
    const maxEvents = Math.min(Math.max(requestedMaxEvents, 1), 1000);
    const session = {
      sessionId: createSessionId(), protocol: PROTOCOL,
      operatorA: pubA, operatorB: pubB,
      operatorAUrl: `${baseUrl(req)}/api/demo?operator=A`,
      operatorBUrl: `${baseUrl(req)}/api/demo?operator=B`,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      maxEvents
    };
    const signed: SignedSession = {
      session,
      signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, session, keyA),
      signatureB: signProtocolObject(SIGNING_DOMAIN.SESSION, session, keyB)
    };
    await tx`INSERT INTO em_demo_sessions(session_id,signed_session,status) VALUES(${session.sessionId},${tx.json(signed)},'ACTIVE')`;
    return { ok: true, sessionId: session.sessionId, signedSession: signed };
  });
}

function stableEvidenceIdentity(evidence: FiberPaymentEvidence) {
  return sha256Hex(canonical({
    claim: evidence.claim,
    verifier: evidence.verifier,
    invoiceStatus: evidence.invoiceStatus,
    payeePublicKey: evidence.payeePublicKey,
    observedUdtTypeScript: evidence.observedUdtTypeScript
  }));
}

async function appendEvent(input: any) {
  const sessionId = String(input.sessionId || "");
  const idem = String(input.idempotencyKey || "");
  return withIdempotency(`event:${sessionId}:${idem}`, input, async (tx) => {
    const rows = await tx`SELECT * FROM em_demo_sessions WHERE session_id=${sessionId} FOR UPDATE`;
    if (!rows.length) throw new Error("SESSION_NOT_FOUND");
    if (rows[0].status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    const signedSession = rows[0].signed_session as SignedSession;
    if (Date.now() >= Date.parse(signedSession.session.expiresAt)) throw new Error("SESSION_EXPIRED");
    const existing = await tx`SELECT signed_event,ack FROM em_demo_events WHERE session_id=${sessionId} ORDER BY sequence DESC LIMIT 1`;
    const sequence = existing.length ? Number(existing[0].signed_event.sequence) + 1 : 1;
    if (sequence > signedSession.session.maxEvents) throw new Error("SESSION_MAX_EVENTS_REACHED");
    const senderInput = String(input.sender || "A").toUpperCase();
    if (senderInput !== "A" && senderInput !== "B") throw new Error("INVALID_SENDER");
    const sender = senderInput as "A" | "B";
    const senderKey = sender === "A" ? keyA : keyB;
    const receiverKey = sender === "A" ? keyB : keyA;
    const receiverPub = sender === "A" ? pubB : pubA;
    const previousHash = existing.length ? existing[0].signed_event.eventHash : ZERO_HASH;
    const event: SignedEvent = signEvent({
      sessionId, sequence, previousHash,
      type: String(input.type || "EVENT").slice(0, 80),
      payload: input.payload ?? {},
      sender: sender === "A" ? pubA : pubB,
      createdAt: new Date().toISOString()
    }, senderKey);

    let paymentEvidence: FiberPaymentEvidence | undefined;
    if (event.type === "PAYMENT_SETTLED") {
      const claim = event.payload as FiberPaymentClaim;
      if (String(claim?.sessionId || "") !== sessionId) throw new Error("FIBER_PAYMENT_SESSION_MISMATCH");
      if (!process.env.FIBER_RECEIVER_RPC_URL) throw new Error("FIBER_RECEIVER_RPC_REQUIRED_FOR_PAYMENT_ACCEPT");
      const fiber = new FiberRpcClient(process.env.FIBER_RECEIVER_RPC_URL, process.env.FIBER_RECEIVER_RPC_TOKEN || undefined);
      const verified = await fiber.verifyReceivedPaymentClaim(claim);
      if (!verified.ok) throw new Error(verified.reason);
      paymentEvidence = verified.evidence;
      const paymentHash = paymentEvidence.claim.paymentHash.toLowerCase();
      const existingClaim = await tx`SELECT * FROM em_demo_payment_claims WHERE payment_hash=${paymentHash}`;
      if (existingClaim.length && (existingClaim[0].session_id !== sessionId || existingClaim[0].event_hash !== event.eventHash.toLowerCase())) {
        throw new Error("FIBER_PAYMENT_HASH_REUSE");
      }
      if (!existingClaim.length) await tx`INSERT INTO em_demo_payment_claims(payment_hash,session_id,event_hash,claim) VALUES(${paymentHash},${sessionId},${event.eventHash.toLowerCase()},${tx.json(paymentEvidence.claim)})`;

      const identityHash = stableEvidenceIdentity(paymentEvidence);
      const priorEvidence = await tx`SELECT * FROM em_demo_payment_evidence WHERE payment_hash=${paymentHash}`;
      if (priorEvidence.length && priorEvidence[0].identity_hash !== identityHash) throw new Error("FIBER_PAYMENT_EVIDENCE_CONFLICT");
      if (priorEvidence.length) {
        await tx`UPDATE em_demo_payment_evidence SET evidence=${tx.json(paymentEvidence)},last_verified_at=${paymentEvidence.verifiedAt},verification_count=verification_count+1 WHERE payment_hash=${paymentHash}`;
      } else {
        await tx`INSERT INTO em_demo_payment_evidence(payment_hash,session_id,event_hash,identity_hash,evidence,first_verified_at,last_verified_at) VALUES(${paymentHash},${sessionId},${event.eventHash.toLowerCase()},${identityHash},${tx.json(paymentEvidence)},${paymentEvidence.verifiedAt},${paymentEvidence.verifiedAt})`;
      }
    }

    const ack: SignedAck = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: receiverPub, createdAt: new Date().toISOString() }, receiverKey);
    await tx`INSERT INTO em_demo_events(event_hash,session_id,sequence,signed_event,ack,status) VALUES(${event.eventHash.toLowerCase()},${sessionId},${sequence},${tx.json(event)},${tx.json(ack)},'FINAL')`;
    return { ok: true, event, ack, paymentEvidence };
  });
}

async function closeSession(input: any) {
  const sessionId = String(input.sessionId || "");
  const idem = String(input.idempotencyKey || "");
  return withIdempotency(`close:${sessionId}:${idem}`, input, async (tx) => {
    const sessions = await tx`SELECT * FROM em_demo_sessions WHERE session_id=${sessionId} FOR UPDATE`;
    if (!sessions.length) throw new Error("SESSION_NOT_FOUND");
    if (sessions[0].signed_close) return { ok: true, close: sessions[0].signed_close };
    if (sessions[0].status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    const rows = await tx`SELECT signed_event,ack,status FROM em_demo_events WHERE session_id=${sessionId} ORDER BY sequence`;
    const items = rows.map((r: any) => ({ event: r.signed_event as SignedEvent, ack: r.ack as SignedAck }));
    if (items.some((x: any) => !x.ack || x.ack.decision !== "ACCEPT")) throw new Error("ALL_EVENTS_MUST_BE_ACCEPTED_BEFORE_CLOSE");
    const finalState = input.finalState ?? { completed: true, sessionId };
    const body = {
      sessionId,
      eventCount: items.length,
      transcriptRoot: computeTranscriptRoot(items),
      finalStateHash: finalStateHashFrom(finalState),
      fiberPayments: acceptedFiberPaymentHashes(items),
      paymentEvidenceRoot: computePaymentEvidenceRoot(items),
      closedAt: new Date().toISOString()
    };
    const signedClose = {
      close: body, finalState,
      signatureA: signProtocolObject(SIGNING_DOMAIN.CLOSE, body, keyA),
      signatureB: signProtocolObject(SIGNING_DOMAIN.CLOSE, body, keyB)
    };
    await tx`UPDATE em_demo_sessions SET signed_close=${tx.json(signedClose)},status='CLOSED' WHERE session_id=${sessionId}`;
    return { ok: true, close: signedClose };
  });
}

async function anchorSession(input: any) {
  if (!sql) throw new Error("DATABASE_URL_REQUIRED");
  const sessionId = String(input.sessionId || "");
  const sessions = await sql`SELECT signed_close,anchor FROM em_demo_sessions WHERE session_id=${sessionId}`;
  if (!sessions.length) throw new Error("SESSION_NOT_FOUND");
  if (!sessions[0].signed_close) throw new Error("CLOSE_REQUIRED_BEFORE_ANCHOR");
  if (sessions[0].anchor) return { ok: true, anchor: sessions[0].anchor, duplicate: true };
  if (!process.env.CKB_PRIVATE_KEY) throw new Error("CKB_PRIVATE_KEY_REQUIRED");
  const close = sessions[0].signed_close.close;
  const dataHex = buildAnchorDataHex(sessionId, close.transcriptRoot, close.finalStateHash, close.paymentEvidenceRoot);
  const commitmentHash = sha256Hex(dataHex);
  const existing = await sql`SELECT * FROM em_demo_anchor_ops WHERE session_id=${sessionId}`;
  if (existing.length) {
    if (existing[0].tx_hash) return { ok: true, anchorOperation: existing[0], duplicate: true };
    if (["BROADCASTING", "BROADCAST_UNKNOWN"].includes(existing[0].status)) throw new Error("ANCHOR_BROADCAST_STATE_UNCERTAIN_RECONCILE_OR_REVIEW_BEFORE_RETRY");
  }
  await sql`
    INSERT INTO em_demo_anchor_ops(session_id,commitment_hash,status,data_hex) VALUES(${sessionId},${commitmentHash},'BROADCASTING',${dataHex})
    ON CONFLICT(session_id) DO UPDATE SET commitment_hash=EXCLUDED.commitment_hash,status='BROADCASTING',data_hex=EXCLUDED.data_hex,error=NULL,updated_at=NOW()
  `;
  let broadcasted: { txHash: string; dataHex: string; status: "PENDING" } | undefined;
  try {
    const { CkbAnchorClient } = await import("@eventmesh/ckb");
    const client = new CkbAnchorClient(process.env.CKB_PRIVATE_KEY, CKB_TESTNET_RPC_URL, Number(process.env.CKB_ANCHOR_CAPACITY_CKB || 220));
    broadcasted = await client.anchor({ sessionId, transcriptRoot: close.transcriptRoot, finalStateHash: close.finalStateHash, paymentEvidenceRoot: close.paymentEvidenceRoot });
    await sql.begin(async (tx: any) => {
      await tx`UPDATE em_demo_anchor_ops SET status='PENDING',tx_hash=${broadcasted!.txHash},data_hex=${broadcasted!.dataHex},updated_at=NOW() WHERE session_id=${sessionId}`;
      await tx`UPDATE em_demo_sessions SET anchor=${tx.json(broadcasted)} WHERE session_id=${sessionId}`;
    });
    return { ok: true, anchor: broadcasted };
  } catch (error) {
    const txHash = broadcasted?.txHash || null;
    await sql`UPDATE em_demo_anchor_ops SET status='BROADCAST_UNKNOWN',tx_hash=COALESCE(tx_hash,${txHash}),error=${safeErrorMessage(error)},updated_at=NOW() WHERE session_id=${sessionId}`;
    throw new Error(txHash
      ? "ANCHOR_BROADCAST_UNKNOWN: tx hash was recovered; run reconcile before any retry"
      : "ANCHOR_BROADCAST_UNKNOWN: transaction may have been submitted; automatic retry blocked");
  }
}

async function reconcileAnchor(input: any) {
  if (!sql) throw new Error("DATABASE_URL_REQUIRED");
  const sessionId = String(input.sessionId || "");
  const ops = await sql`SELECT * FROM em_demo_anchor_ops WHERE session_id=${sessionId}`;
  if (!ops.length) throw new Error("ANCHOR_OPERATION_NOT_FOUND");
  if (!ops[0].tx_hash) return { ok: false, status: ops[0].status, requiresManualReview: true, reason: "TX_HASH_UNKNOWN" };
  const { inspectAnchorRpc } = await import("@eventmesh/ckb");
  const inspected = await inspectAnchorRpc(CKB_TESTNET_RPC_URL, ops[0].tx_hash, ops[0].data_hex);
  if (inspected.ok) {
    const anchor = { txHash: ops[0].tx_hash, dataHex: ops[0].data_hex, status: "COMMITTED", blockHash: inspected.blockHash };
    await sql.begin(async (tx: any) => {
      await tx`UPDATE em_demo_anchor_ops SET status='COMMITTED',block_hash=${inspected.blockHash || null},updated_at=NOW() WHERE session_id=${sessionId}`;
      await tx`UPDATE em_demo_sessions SET anchor=${tx.json(anchor)} WHERE session_id=${sessionId}`;
    });
    return { ok: true, anchor, verification: inspected };
  }
  return { ok: false, status: "PENDING", verification: inspected };
}

function safeErrorMessage(error: unknown) {
  const raw = String((error as any)?.message || error || "UNKNOWN_ERROR");
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

export default async function handler(req: any, res: ServerResponse) {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url || "/api/demo", baseUrl(req));
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        await ensureSchema();
        return json(res, 200, await loadState(sessionId));
      }

      let database = false;
      let databaseError: string | undefined;
      let recent: any[] = [];
      if (!sql) {
        databaseError = "DATABASE_URL_NOT_CONFIGURED";
      } else {
        try {
          await ensureSchema();
          await sql`SELECT 1 AS ok`;
          database = true;
          recent = await sql`SELECT session_id,status,created_at FROM em_demo_sessions ORDER BY created_at DESC LIMIT 10`;
        } catch (error) {
          databaseError = safeErrorMessage(error);
        }
      }

      return json(res, 200, {
        ok: database,
        protocol: PROTOCOL,
        version: "0.4.0",
        operatorA: pubA,
        operatorB: pubB,
        database,
        databaseConfigured: !!sql,
        databaseError,
        fiberReceiverVerification: !!process.env.FIBER_RECEIVER_RPC_URL,
        ckbAnchoring: !!process.env.CKB_PRIVATE_KEY,
        ckbReconciliation: true,
        ckbRpcUrl: process.env.CKB_RPC_URL ? "configured" : "default-testnet",
        masterSecretConfigured: !!process.env.DEMO_MASTER_SECRET,
        configurationErrors,
        recent
      });
    }

    if (req.method !== "POST") return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    if (!process.env.DEMO_MASTER_SECRET) throw new Error("DEMO_MASTER_SECRET_REQUIRED");
    if (configurationErrors.length) throw new Error(configurationErrors.join(","));
    await ensureSchema();
    await rateLimit(req);
    const input = await bodyOf(req);
    let result: any;
    switch (String(input.action || "")) {
      case "create_session": result = await createSession(req, input); break;
      case "append_event": result = await appendEvent(input); break;
      case "close_session": result = await closeSession(input); break;
      case "anchor": result = await anchorSession(input); break;
      case "reconcile_anchor": result = await reconcileAnchor(input); break;
      default: throw new Error("UNKNOWN_ACTION");
    }
    const state = result?.sessionId ? await loadState(result.sessionId) : input.sessionId ? await loadState(String(input.sessionId)) : undefined;
    return json(res, 200, { ...result, state });
  } catch (error: any) {
    const message = safeErrorMessage(error);
    const status = message === "RATE_LIMITED" ? 429
      : message.includes("NOT_FOUND") ? 404
      : message.includes("REQUIRED") || message.includes("DATABASE") ? 503
      : 400;
    return json(res, status, { error: message });
  }
}
