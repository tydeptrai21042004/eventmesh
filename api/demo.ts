import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
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
  verifyTranscript,
  type FiberPaymentClaim,
  type FiberPaymentEvidence,
  type SignedAck,
  type SignedEvent,
  type SignedSession
} from "@eventmesh/core";
import { FiberRpcClient } from "@eventmesh/fiber";
import { DEMO_STORAGE_DURABLE, DEMO_STORAGE_MODE, clearDemoSession, mutateDemoStore, readDemoStore } from "./demo-store.js";

const CKB_TESTNET_RPC_URL = process.env.CKB_RPC_URL || "https://testnet.ckbapp.dev/";
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const processFallbackSecret = randomBytes(32).toString("hex");

function configuredMasterSecret() {
  const value = process.env.DEMO_MASTER_SECRET?.trim();
  return value && value.length >= 32 ? value : undefined;
}

function derivedKey(label: string) {
  const secret = configuredMasterSecret() || processFallbackSecret;
  const raw = createHmac("sha256", secret).update(label).digest("hex");
  const scalar = (BigInt(`0x${raw}`) % (SECP256K1_N - 1n)) + 1n;
  return `0x${scalar.toString(16).padStart(64, "0")}`;
}

const configurationErrors: string[] = [];
if (process.env.DEMO_MASTER_SECRET && !configuredMasterSecret()) configurationErrors.push("DEMO_MASTER_SECRET_TOO_SHORT");

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

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.end(JSON.stringify(body));
}

async function bodyOf(req: any) {
  const maxBytes = 2 * 1024 * 1024;
  const contentType = String(req.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new Error("CONTENT_TYPE_APPLICATION_JSON_REQUIRED");
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

function enforceSameOrigin(req: any) {
  const origin = String(req.headers?.origin || "").trim();
  if (!origin) return;
  if (origin !== baseUrl(req)) throw new Error("CROSS_ORIGIN_MUTATION_REJECTED");
}

function actorHash(req: any) {
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return sha256Hex(`${configuredMasterSecret() || processFallbackSecret}:${ip}`);
}

async function rateLimit(req: any, limit = Number(process.env.DEMO_RATE_LIMIT_PER_MINUTE || 60)) {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 5), 1000) : 60;
  const bucket = new Date().toISOString().slice(0, 16);
  const key = `${actorHash(req)}:${bucket}`;
  await mutateDemoStore((store) => {
    const row = store.rateLimits[key] || { count: 0, updatedAt: new Date().toISOString() };
    row.count += 1;
    row.updatedAt = new Date().toISOString();
    store.rateLimits[key] = row;
    if (row.count > safeLimit) throw new Error("RATE_LIMITED");
  });
}

async function loadState(sessionId: string) {
  return readDemoStore((store) => {
    const session = store.sessions[sessionId];
    if (!session) throw new Error("SESSION_NOT_FOUND");
    const events = store.events[sessionId] || [];
    const evidence = Object.values(store.paymentEvidence)
      .filter((row: any) => row.sessionId === sessionId)
      .sort((a: any, b: any) => Date.parse(a.firstVerifiedAt) - Date.parse(b.firstVerifiedAt));
    return {
      sessionId,
      status: session.status,
      signedSession: session.signedSession,
      events: events.map((r: any) => ({ event: r.signedEvent, ack: r.ack, status: r.status })),
      close: session.signedClose || null,
      anchor: session.anchor || null,
      anchorOperation: store.anchorOps[sessionId] || null,
      paymentEvidence: evidence.map((r: any) => ({
        ...r.evidence,
        firstVerifiedAt: r.firstVerifiedAt,
        lastVerifiedAt: r.lastVerifiedAt,
        verificationCount: r.verificationCount
      }))
    };
  });
}

async function withIdempotency(key: string, request: unknown, fn: (store: any) => Promise<any> | any) {
  if (!key || key.length > 160) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  const requestHash = sha256Hex(canonical(request));
  return mutateDemoStore(async (store) => {
    const found = store.idempotency[key];
    if (found) {
      if (found.requestHash !== requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
      return { ...found.response, duplicate: true };
    }
    const result = await fn(store);
    store.idempotency[key] = { requestHash, response: result, createdAt: new Date().toISOString() };
    return result;
  });
}

async function createSession(req: any, input: any) {
  const idem = String(input.idempotencyKey || "");
  return withIdempotency(`create:${idem}`, input, async (store) => {
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
    store.sessions[session.sessionId] = { signedSession: signed, status: "ACTIVE", createdAt: now.toISOString() };
    store.events[session.sessionId] = [];
    return { ok: true, sessionId: session.sessionId, signedSession: signed };
  });
}


function transcriptFromSnapshot(snapshot: any) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("SNAPSHOT_REQUIRED");
  if (!snapshot.signedSession) throw new Error("SNAPSHOT_SIGNED_SESSION_REQUIRED");
  return {
    session: snapshot.signedSession,
    events: Array.isArray(snapshot.events)
      ? snapshot.events.map((row: any) => ({ event: row.event, ack: row.ack }))
      : [],
    close: snapshot.close || undefined,
    paymentEvidence: Array.isArray(snapshot.paymentEvidence) ? snapshot.paymentEvidence : undefined,
    ckbAnchor: snapshot.anchor || undefined
  };
}

function validatePortableSnapshot(snapshot: any) {
  const transcript = transcriptFromSnapshot(snapshot);
  const verification = verifyTranscript(transcript as any);
  if (!verification.ok) throw new Error(`SNAPSHOT_VERIFICATION_FAILED:${verification.errors.join("|")}`);
  const signedSession = snapshot.signedSession as SignedSession;
  if (signedSession.session.operatorA.toLowerCase() !== pubA.toLowerCase()) throw new Error("SNAPSHOT_OPERATOR_A_MISMATCH");
  if (signedSession.session.operatorB.toLowerCase() !== pubB.toLowerCase()) throw new Error("SNAPSHOT_OPERATOR_B_MISMATCH");
  if (snapshot.sessionId && snapshot.sessionId !== signedSession.session.sessionId) throw new Error("SNAPSHOT_SESSION_ID_MISMATCH");
  return { transcript, signedSession, verification };
}

async function restorePortableSnapshot(snapshot: any) {
  const { signedSession } = validatePortableSnapshot(snapshot);
  const sessionId = signedSession.session.sessionId;
  await mutateDemoStore((store) => {
    const existing = store.sessions[sessionId];
    if (existing?.signedSession) {
      const current = canonical(existing.signedSession);
      const incoming = canonical(signedSession);
      if (current !== incoming) throw new Error("SNAPSHOT_SESSION_CONFLICT");
    }

    const incomingEvents = (snapshot.events || []).map((row: any) => ({
      eventHash: row.event.eventHash.toLowerCase(),
      sequence: row.event.sequence,
      signedEvent: row.event,
      ack: row.ack,
      status: row.status || "FINAL"
    }));
    const existingEvents = store.events[sessionId] || [];
    const commonLength = Math.min(existingEvents.length, incomingEvents.length);
    for (let index = 0; index < commonLength; index += 1) {
      if (String(existingEvents[index]?.eventHash || "").toLowerCase() !== String(incomingEvents[index]?.eventHash || "").toLowerCase()) {
        throw new Error("SNAPSHOT_EVENT_HISTORY_CONFLICT");
      }
    }

    // Never roll a warm server cache backwards when a browser submits an older
    // but otherwise valid snapshot. The longer verified chain wins.
    const useIncoming = incomingEvents.length >= existingEvents.length;
    if (useIncoming) {
      store.sessions[sessionId] = {
        signedSession,
        status: snapshot.status === "CLOSED" || snapshot.close ? "CLOSED" : "ACTIVE",
        createdAt: signedSession.session.createdAt,
        signedClose: snapshot.close || undefined,
        anchor: snapshot.anchor || undefined
      };
      store.events[sessionId] = incomingEvents;
    }

    if (snapshot.anchorOperation && (useIncoming || !store.anchorOps[sessionId])) {
      if (!snapshot.close?.close) throw new Error("SNAPSHOT_ANCHOR_OPERATION_REQUIRES_CLOSE");
      const expectedDataHex = buildAnchorDataHex(
        sessionId,
        snapshot.close.close.transcriptRoot,
        snapshot.close.close.finalStateHash,
        snapshot.close.close.paymentEvidenceRoot
      );
      if (String(snapshot.anchorOperation.dataHex || "").toLowerCase() !== expectedDataHex.toLowerCase()) {
        throw new Error("SNAPSHOT_ANCHOR_OPERATION_COMMITMENT_MISMATCH");
      }
      const txHash = snapshot.anchorOperation.txHash;
      if (txHash && !/^0x[0-9a-f]{64}$/i.test(String(txHash))) throw new Error("SNAPSHOT_ANCHOR_TX_HASH_INVALID");
      if (snapshot.anchorOperation.commitmentHash && String(snapshot.anchorOperation.commitmentHash).toLowerCase() !== sha256Hex(expectedDataHex).toLowerCase()) {
        throw new Error("SNAPSHOT_ANCHOR_COMMITMENT_HASH_MISMATCH");
      }
      store.anchorOps[sessionId] = snapshot.anchorOperation;
    }

    for (const evidence of snapshot.paymentEvidence || []) {
      const paymentHash = String(evidence?.claim?.paymentHash || "").toLowerCase();
      if (!paymentHash) continue;
      const event = (snapshot.events || []).find((row: any) =>
        row?.event?.type === "PAYMENT_SETTLED" && String(row?.event?.payload?.paymentHash || "").toLowerCase() === paymentHash
      );
      if (!event) continue;
      store.paymentClaims[paymentHash] = { sessionId, eventHash: event.event.eventHash.toLowerCase(), claim: evidence.claim };
      store.paymentEvidence[paymentHash] = {
        sessionId,
        eventHash: event.event.eventHash.toLowerCase(),
        identityHash: stableEvidenceIdentity(evidence),
        evidence,
        firstVerifiedAt: evidence.firstVerifiedAt || evidence.verifiedAt,
        lastVerifiedAt: evidence.lastVerifiedAt || evidence.verifiedAt,
        verificationCount: evidence.verificationCount || 1
      };
    }
  });
  return sessionId;
}

function snapshotSummary(snapshot: any) {
  const { signedSession, verification } = validatePortableSnapshot(snapshot);
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  return {
    ok: verification.ok,
    sessionId: signedSession.session.sessionId,
    status: snapshot.close ? "CLOSED" : "ACTIVE",
    eventCount: events.length,
    expiresAt: signedSession.session.expiresAt,
    transcriptRoot: snapshot.close?.close?.transcriptRoot || computeTranscriptRoot(events.map((row: any) => ({ event: row.event, ack: row.ack }))),
    errors: verification.errors
  };
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
  return withIdempotency(`event:${sessionId}:${idem}`, input, async (store) => {
    const sessionRow = store.sessions[sessionId];
    if (!sessionRow) throw new Error("SESSION_NOT_FOUND");
    if (sessionRow.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    const signedSession = sessionRow.signedSession as SignedSession;
    if (Date.now() >= Date.parse(signedSession.session.expiresAt)) throw new Error("SESSION_EXPIRED");
    const existing = store.events[sessionId] || [];
    const last = existing.at(-1);
    const sequence = last ? Number(last.signedEvent.sequence) + 1 : 1;
    if (sequence > signedSession.session.maxEvents) throw new Error("SESSION_MAX_EVENTS_REACHED");
    const senderInput = String(input.sender || "A").toUpperCase();
    if (senderInput !== "A" && senderInput !== "B") throw new Error("INVALID_SENDER");
    const sender = senderInput as "A" | "B";
    const senderKey = sender === "A" ? keyA : keyB;
    const receiverKey = sender === "A" ? keyB : keyA;
    const receiverPub = sender === "A" ? pubB : pubA;
    const previousHash = last ? last.signedEvent.eventHash : ZERO_HASH;
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
      const existingClaim = store.paymentClaims[paymentHash];
      if (existingClaim && (existingClaim.sessionId !== sessionId || existingClaim.eventHash !== event.eventHash.toLowerCase())) {
        throw new Error("FIBER_PAYMENT_HASH_REUSE");
      }
      if (!existingClaim) store.paymentClaims[paymentHash] = { sessionId, eventHash: event.eventHash.toLowerCase(), claim: paymentEvidence.claim };

      const identityHash = stableEvidenceIdentity(paymentEvidence);
      const priorEvidence = store.paymentEvidence[paymentHash];
      if (priorEvidence && priorEvidence.identityHash !== identityHash) throw new Error("FIBER_PAYMENT_EVIDENCE_CONFLICT");
      if (priorEvidence) {
        priorEvidence.evidence = paymentEvidence;
        priorEvidence.lastVerifiedAt = paymentEvidence.verifiedAt;
        priorEvidence.verificationCount += 1;
      } else {
        store.paymentEvidence[paymentHash] = {
          sessionId,
          eventHash: event.eventHash.toLowerCase(),
          identityHash,
          evidence: paymentEvidence,
          firstVerifiedAt: paymentEvidence.verifiedAt,
          lastVerifiedAt: paymentEvidence.verifiedAt,
          verificationCount: 1
        };
      }
    }

    const ack: SignedAck = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: receiverPub, createdAt: new Date().toISOString() }, receiverKey);
    existing.push({ eventHash: event.eventHash.toLowerCase(), sequence, signedEvent: event, ack, status: "FINAL" });
    store.events[sessionId] = existing;
    return { ok: true, event, ack, paymentEvidence };
  });
}

async function closeSession(input: any) {
  const sessionId = String(input.sessionId || "");
  const idem = String(input.idempotencyKey || "");
  return withIdempotency(`close:${sessionId}:${idem}`, input, async (store) => {
    const session = store.sessions[sessionId];
    if (!session) throw new Error("SESSION_NOT_FOUND");
    if (session.signedClose) return { ok: true, close: session.signedClose };
    if (session.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    const rows = store.events[sessionId] || [];
    const items = rows.map((r: any) => ({ event: r.signedEvent as SignedEvent, ack: r.ack as SignedAck }));
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
    session.signedClose = signedClose;
    session.status = "CLOSED";
    return { ok: true, close: signedClose };
  });
}

function ckbBroadcastEnabled() {
  return process.env.DEMO_ALLOW_CKB_BROADCAST === "true" && !!process.env.CKB_PRIVATE_KEY;
}

async function anchorSession(input: any) {
  const sessionId = String(input.sessionId || "");
  if (!ckbBroadcastEnabled()) throw new Error("CKB_BROADCAST_DISABLED");

  const reserved = await mutateDemoStore((store) => {
    const session = store.sessions[sessionId];
    if (!session) throw new Error("SESSION_NOT_FOUND");
    if (!session.signedClose) throw new Error("CLOSE_REQUIRED_BEFORE_ANCHOR");
    if (session.anchor) return { duplicateAnchor: session.anchor };

    const close = session.signedClose.close;
    const dataHex = buildAnchorDataHex(sessionId, close.transcriptRoot, close.finalStateHash, close.paymentEvidenceRoot);
    const commitmentHash = sha256Hex(dataHex);
    const existing = store.anchorOps[sessionId];

    if (existing?.txHash && ["PENDING", "COMMITTED"].includes(existing.status)) {
      return { duplicateOperation: existing };
    }
    if (existing?.txHash && ["BROADCASTING", "BROADCAST_UNKNOWN"].includes(existing.status)) {
      throw new Error("ANCHOR_BROADCAST_STATE_UNCERTAIN_RECONCILE_OR_REVIEW_BEFORE_RETRY");
    }
    if (existing?.status === "PREPARING") {
      const stale = Date.now() - Date.parse(existing.updatedAt || 0) > 2 * 60 * 1000;
      if (!stale) throw new Error("ANCHOR_PREPARATION_IN_PROGRESS");
    }

    store.anchorOps[sessionId] = {
      sessionId,
      commitmentHash,
      status: "PREPARING",
      dataHex,
      updatedAt: new Date().toISOString()
    };
    return { close, dataHex, commitmentHash };
  });

  if ((reserved as any).duplicateAnchor) return { ok: true, anchor: (reserved as any).duplicateAnchor, duplicate: true };
  if ((reserved as any).duplicateOperation) return { ok: true, anchorOperation: (reserved as any).duplicateOperation, duplicate: true };

  let expectedTxHash: string | undefined;
  try {
    const { CkbAnchorClient } = await import("@eventmesh/ckb");
    const close = (reserved as any).close;
    const client = new CkbAnchorClient(
      process.env.CKB_PRIVATE_KEY!,
      CKB_TESTNET_RPC_URL,
      Number(process.env.CKB_ANCHOR_CAPACITY_CKB || 220)
    );
    const prepared = await client.prepareAnchor({
      sessionId,
      transcriptRoot: close.transcriptRoot,
      finalStateHash: close.finalStateHash,
      paymentEvidenceRoot: close.paymentEvidenceRoot
    });
    if (prepared.dataHex.toLowerCase() !== String((reserved as any).dataHex).toLowerCase()) {
      throw new Error("ANCHOR_PREPARED_COMMITMENT_MISMATCH");
    }
    expectedTxHash = prepared.txHash;

    // Persist deterministic transaction identity before the irreversible network submission.
    await mutateDemoStore((store) => {
      const op = store.anchorOps[sessionId];
      if (!op || op.commitmentHash !== (reserved as any).commitmentHash) throw new Error("ANCHOR_OPERATION_CONFLICT");
      Object.assign(op, {
        status: "BROADCASTING",
        txHash: expectedTxHash,
        updatedAt: new Date().toISOString()
      });
    });

    const broadcasted = await client.broadcastPrepared(prepared);
    await mutateDemoStore((store) => {
      const op = store.anchorOps[sessionId];
      if (!op || op.txHash?.toLowerCase() !== broadcasted.txHash.toLowerCase()) throw new Error("ANCHOR_OPERATION_CONFLICT");
      Object.assign(op, {
        status: "PENDING",
        txHash: broadcasted.txHash,
        dataHex: broadcasted.dataHex,
        updatedAt: new Date().toISOString()
      });
      store.sessions[sessionId].anchor = broadcasted;
    });
    return { ok: true, anchor: broadcasted };
  } catch (error) {
    const persisted = await mutateDemoStore((store) => {
      const op = store.anchorOps[sessionId];
      if (!op) return undefined;
      const hasTxIdentity = !!op.txHash || !!expectedTxHash;
      Object.assign(op, {
        status: hasTxIdentity ? "BROADCAST_UNKNOWN" : "PREPARE_FAILED",
        txHash: op.txHash || expectedTxHash,
        error: safeErrorMessage(error),
        updatedAt: new Date().toISOString()
      });
      return { status: op.status, txHash: op.txHash };
    });

    if (persisted?.txHash) {
      throw new Error(`ANCHOR_BROADCAST_UNKNOWN: deterministic tx hash ${persisted.txHash} was persisted; reconcile before any retry`);
    }
    throw error;
  }
}

async function reconcileAnchor(input: any) {
  const sessionId = String(input.sessionId || "");
  const op = await readDemoStore((store) => store.anchorOps[sessionId]);
  if (!op) throw new Error("ANCHOR_OPERATION_NOT_FOUND");
  if (!op.txHash) return { ok: false, status: op.status, requiresManualReview: true, reason: "TX_HASH_UNKNOWN" };
  const { inspectAnchorRpc } = await import("@eventmesh/ckb");
  const inspected = await inspectAnchorRpc(CKB_TESTNET_RPC_URL, op.txHash, op.dataHex);
  if (inspected.ok) {
    const anchor = { txHash: op.txHash, dataHex: op.dataHex, status: "COMMITTED", blockHash: inspected.blockHash };
    await mutateDemoStore((store) => {
      Object.assign(store.anchorOps[sessionId], { status: "COMMITTED", blockHash: inspected.blockHash || null, updatedAt: new Date().toISOString() });
      store.sessions[sessionId].anchor = anchor;
    });
    return { ok: true, anchor, verification: inspected };
  }
  if (inspected.status === "TX_NOT_FOUND" && ["BROADCASTING", "BROADCAST_UNKNOWN"].includes(op.status)) {
    return {
      ok: false,
      status: op.status,
      requiresManualReview: true,
      reason: "PERSISTED_TX_HASH_NOT_FOUND_ON_RPC",
      verification: inspected
    };
  }
  return { ok: false, status: "PENDING", verification: inspected };
}

function safeErrorMessage(error: unknown) {
  const raw = String((error as any)?.message || error || "UNKNOWN_ERROR");
  return raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

export default async function handler(req: any, res: ServerResponse) {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url || "/api/demo", baseUrl(req));
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) return json(res, 200, await loadState(sessionId));

      return json(res, 200, {
        ok: !!configuredMasterSecret() && configurationErrors.length === 0,
        protocol: PROTOCOL,
        version: "0.5.0",
        network: "CKB Testnet",
        storage: { mode: DEMO_STORAGE_MODE, durable: DEMO_STORAGE_DURABLE, portableRecovery: true },
        operatorA: pubA,
        operatorB: pubB,
        capabilities: {
          fiberPayments: !!process.env.FIBER_RECEIVER_RPC_URL,
          ckbAnchoring: ckbBroadcastEnabled(),
          ckbReconciliation: true
        }
      });
    }

    if (req.method !== "POST") return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    if (!configuredMasterSecret()) throw new Error(process.env.DEMO_MASTER_SECRET ? "DEMO_MASTER_SECRET_TOO_SHORT" : "DEMO_MASTER_SECRET_REQUIRED");
    if (configurationErrors.length) throw new Error(configurationErrors.join(","));
    enforceSameOrigin(req);
    await rateLimit(req);
    const input = await bodyOf(req);
    if (input.snapshot && String(input.action || "") !== "verify_snapshot") {
      await restorePortableSnapshot(input.snapshot);
    }
    let result: any;
    switch (String(input.action || "")) {
      case "create_session": result = await createSession(req, input); break;
      case "append_event": result = await appendEvent(input); break;
      case "close_session": result = await closeSession(input); break;
      case "anchor": result = await anchorSession(input); break;
      case "reconcile_anchor": result = await reconcileAnchor(input); break;
      case "verify_snapshot": result = snapshotSummary(input.snapshot); break;
      case "reset_session": {
        const sessionId = String(input.sessionId || input.snapshot?.sessionId || "");
        if (!sessionId) throw new Error("SESSION_ID_REQUIRED");
        await clearDemoSession(sessionId);
        result = { ok: true, sessionId, reset: true };
        break;
      }
      default: throw new Error("UNKNOWN_ACTION");
    }
    const shouldLoadState = !["verify_snapshot", "reset_session"].includes(String(input.action || ""));
    const state = shouldLoadState
      ? result?.sessionId ? await loadState(result.sessionId) : input.sessionId ? await loadState(String(input.sessionId)) : undefined
      : undefined;
    return json(res, 200, { ...result, state });
  } catch (error: any) {
    const message = safeErrorMessage(error);
    const status = message === "RATE_LIMITED" ? 429
      : message.includes("NOT_FOUND") ? 404
      : message.includes("REQUIRED") || message.includes("DISABLED") ? 503
      : message.includes("TOO_LARGE") ? 413
      : 400;
    return json(res, status, { error: message });
  }
}
