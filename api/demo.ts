import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  signFiberPaymentEvidence,
  signProtocolObject,
  verifyTranscript,
  type FiberPaymentClaim,
  type SignedFiberPaymentEvidence,
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

type WorkspaceMode = "demo" | "testnet";

type OperatorKeys = {
  mode: WorkspaceMode;
  environment: "DEMO" | "TESTNET";
  keyA: string;
  keyB: string;
  pubA: string;
  pubB: string;
};

const configurationErrors: string[] = [];
if (process.env.DEMO_MASTER_SECRET && !configuredMasterSecret()) configurationErrors.push("DEMO_MASTER_SECRET_TOO_SHORT");

function configuredPrivateKey(name: "OPERATOR_A_PRIVATE_KEY" | "OPERATOR_B_PRIVATE_KEY") {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    configurationErrors.push(`${name}_INVALID_FORMAT`);
    return undefined;
  }
  const scalar = BigInt(value);
  if (scalar <= 0n || scalar >= SECP256K1_N) {
    configurationErrors.push(`${name}_OUT_OF_RANGE`);
    return undefined;
  }
  return value;
}

const demoKeyA = derivedKey("operator-a");
const demoKeyB = derivedKey("operator-b");
const demoPubA = publicKeyFromPrivate(demoKeyA);
const demoPubB = publicKeyFromPrivate(demoKeyB);
const testnetKeyA = configuredPrivateKey("OPERATOR_A_PRIVATE_KEY");
const testnetKeyB = configuredPrivateKey("OPERATOR_B_PRIVATE_KEY");
const testnetPubA = testnetKeyA ? publicKeyFromPrivate(testnetKeyA) : undefined;
const testnetPubB = testnetKeyB ? publicKeyFromPrivate(testnetKeyB) : undefined;

function requestedMode(value: unknown): WorkspaceMode {
  const mode = String(value || "demo").toLowerCase();
  if (mode !== "demo" && mode !== "testnet") throw new Error("INVALID_WORKSPACE_MODE");
  return mode;
}

function keysForMode(mode: WorkspaceMode): OperatorKeys {
  if (mode === "demo") {
    return { mode, environment: "DEMO", keyA: demoKeyA, keyB: demoKeyB, pubA: demoPubA, pubB: demoPubB };
  }
  if (process.env.EVENTMESH_TESTNET_MODE !== "true") throw new Error("TESTNET_WORKSPACE_DISABLED");
  if (!testnetKeyA || !testnetKeyB || !testnetPubA || !testnetPubB) throw new Error("TESTNET_OPERATOR_KEYS_REQUIRED");
  return { mode, environment: "TESTNET", keyA: testnetKeyA, keyB: testnetKeyB, pubA: testnetPubA, pubB: testnetPubB };
}

function modeFromSignedSession(signedSession: SignedSession): WorkspaceMode {
  if (signedSession.session.environment === "TESTNET") return "testnet";
  if (!signedSession.session.environment && testnetPubA && testnetPubB
    && signedSession.session.operatorA.toLowerCase() === testnetPubA.toLowerCase()
    && signedSession.session.operatorB.toLowerCase() === testnetPubB.toLowerCase()) return "testnet";
  return "demo";
}

function accessKeyConfigured() {
  const value = process.env.EVENTMESH_TESTNET_ACCESS_KEY?.trim();
  return value && value.length >= 32 ? value : undefined;
}

function secureEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorizeWorkspace(req: any, mode: WorkspaceMode) {
  if (mode !== "testnet") return;
  keysForMode("testnet");
  const expected = accessKeyConfigured();
  if (!expected) throw new Error("TESTNET_ACCESS_KEY_NOT_CONFIGURED");
  const provided = String(req.headers?.["x-eventmesh-access-key"] || "");
  if (!provided || !secureEqual(provided, expected)) throw new Error("TESTNET_ACCESS_DENIED");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("x-eventmesh-version", "0.6.0");
  res.setHeader("x-request-id", randomUUID());
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
  const fetchSite = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw new Error("CROSS_ORIGIN_MUTATION_REJECTED");
  const origin = String(req.headers?.origin || "").trim();
  if (!origin) return;
  const configuredOrigin = process.env.EVENTMESH_PUBLIC_ORIGIN?.trim()?.replace(/\/$/, "");
  const expected = configuredOrigin || baseUrl(req);
  if (origin.replace(/\/$/, "") !== expected) throw new Error("CROSS_ORIGIN_MUTATION_REJECTED");
}

function actorHash(req: any) {
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return sha256Hex(`${configuredMasterSecret() || processFallbackSecret}:${ip}`);
}

async function rateLimit(req: any, mode: WorkspaceMode, limit = Number(mode === "testnet" ? process.env.TESTNET_RATE_LIMIT_PER_MINUTE || 30 : process.env.DEMO_RATE_LIMIT_PER_MINUTE || 60)) {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 5), 1000) : 60;
  const bucket = new Date().toISOString().slice(0, 16);
  const key = `${mode}:${actorHash(req)}:${bucket}`;
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
      workspaceMode: modeFromSignedSession(session.signedSession),
      status: session.status,
      signedSession: session.signedSession,
      events: events.map((r: any) => ({ event: r.signedEvent, ack: r.ack, status: r.status })),
      close: session.signedClose || null,
      anchor: session.anchor || null,
      anchorOperation: store.anchorOps[sessionId] || null,
      paymentEvidence: evidence.map((r: any) => r.evidence),
      paymentEvidenceMeta: evidence.map((r: any) => ({
        paymentHash: r.evidence?.evidence?.claim?.paymentHash,
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
  const mode = requestedMode(input.mode);
  authorizeWorkspace(req, mode);
  const keys = keysForMode(mode);
  const idem = String(input.idempotencyKey || "");
  return withIdempotency(`create:${mode}:${idem}`, input, async (store) => {
    const now = new Date();
    const defaultTtl = mode === "testnet" ? 1800 : 3600;
    const requestedTtl = Number(input.ttlSeconds ?? defaultTtl);
    const requestedMaxEvents = Number(input.maxEvents ?? 100);
    if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) throw new Error("INVALID_TTL_SECONDS");
    if (!Number.isFinite(requestedMaxEvents) || !Number.isInteger(requestedMaxEvents)) throw new Error("INVALID_MAX_EVENTS");
    const ttlSeconds = Math.min(Math.max(requestedTtl, 60), mode === "testnet" ? 7200 : 86400);
    const maxEvents = Math.min(Math.max(requestedMaxEvents, 1), mode === "testnet" ? 250 : 1000);
    const session = {
      sessionId: createSessionId(), protocol: PROTOCOL,
      environment: keys.environment,
      operatorA: keys.pubA, operatorB: keys.pubB,
      operatorAUrl: `${baseUrl(req)}/api/demo?operator=A`,
      operatorBUrl: `${baseUrl(req)}/api/demo?operator=B`,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      maxEvents
    };
    const signed: SignedSession = {
      session,
      signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, session, keys.keyA),
      signatureB: signProtocolObject(SIGNING_DOMAIN.SESSION, session, keys.keyB)
    };
    store.sessions[session.sessionId] = { signedSession: signed, status: "ACTIVE", createdAt: now.toISOString() };
    store.events[session.sessionId] = [];
    return { ok: true, sessionId: session.sessionId, workspaceMode: mode, signedSession: signed };
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
  const mode = modeFromSignedSession(signedSession);
  const keys = keysForMode(mode);
  if (signedSession.session.operatorA.toLowerCase() !== keys.pubA.toLowerCase()) throw new Error("SNAPSHOT_OPERATOR_A_MISMATCH");
  if (signedSession.session.operatorB.toLowerCase() !== keys.pubB.toLowerCase()) throw new Error("SNAPSHOT_OPERATOR_B_MISMATCH");
  if (snapshot.workspaceMode && requestedMode(snapshot.workspaceMode) !== mode) throw new Error("SNAPSHOT_WORKSPACE_MODE_MISMATCH");
  if (snapshot.sessionId && snapshot.sessionId !== signedSession.session.sessionId) throw new Error("SNAPSHOT_SESSION_ID_MISMATCH");
  return { transcript, signedSession, verification, mode, keys };
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
      const paymentHash = String(evidence?.evidence?.claim?.paymentHash || "").toLowerCase();
      if (!paymentHash) continue;
      const event = (snapshot.events || []).find((row: any) =>
        row?.event?.type === "PAYMENT_SETTLED" && String(row?.event?.payload?.paymentHash || "").toLowerCase() === paymentHash
      );
      if (!event) continue;
      const verifiedAt = evidence?.evidence?.verifiedAt || new Date().toISOString();
      store.paymentClaims[paymentHash] = { sessionId, eventHash: event.event.eventHash.toLowerCase(), claim: evidence.evidence.claim };
      store.paymentEvidence[paymentHash] = {
        sessionId,
        eventHash: event.event.eventHash.toLowerCase(),
        identityHash: stableEvidenceIdentity(evidence),
        evidence,
        firstVerifiedAt: verifiedAt,
        lastVerifiedAt: verifiedAt,
        verificationCount: 1
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
    workspaceMode: modeFromSignedSession(signedSession),
    status: snapshot.close ? "CLOSED" : "ACTIVE",
    eventCount: events.length,
    expiresAt: signedSession.session.expiresAt,
    transcriptRoot: snapshot.close?.close?.transcriptRoot || computeTranscriptRoot(events.map((row: any) => ({ event: row.event, ack: row.ack }))),
    errors: verification.errors
  };
}

function stableEvidenceIdentity(evidence: SignedFiberPaymentEvidence) {
  // Re-verifying the same paid invoice creates a fresh verifiedAt/signature.
  // Idempotency must be based on the stable observed facts, not wall-clock time.
  return sha256Hex(canonical({
    observer: evidence.observer,
    claim: evidence.evidence.claim,
    verifier: evidence.evidence.verifier,
    invoiceStatus: evidence.evidence.invoiceStatus,
    payeePublicKey: evidence.evidence.payeePublicKey,
    observedUdtTypeScript: evidence.evidence.observedUdtTypeScript
  }));
}

const ALLOWED_EVENT_TYPES = new Set([
  "SERVICE_REQUESTED",
  "SERVICE_ACCEPTED",
  "RESULT_COMMITTED",
  "SESSION_COMPLETED",
  "PAYMENT_SETTLED",
  "RECONCILIATION_NOTE"
]);

function cleanText(value: unknown, field: string, max: number) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`INVALID_${field}`);
  return text;
}

function requestIdOf(payload: any) {
  const value = cleanText(payload?.requestId, "REQUEST_ID", 96);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error("INVALID_REQUEST_ID");
  return value;
}

function h32(value: unknown, field: string) {
  const text = String(value || "");
  if (!/^0x[0-9a-f]{64}$/i.test(text)) throw new Error(`INVALID_${field}`);
  return text.toLowerCase();
}

function acceptedEvent(rows: any[], type: string) {
  return rows.find((row: any) => row?.signedEvent?.type === type && row?.ack?.decision === "ACCEPT")?.signedEvent;
}

function validateEventInput(rows: any[], sender: "A" | "B", type: string, payload: any) {
  if (!ALLOWED_EVENT_TYPES.has(type)) throw new Error("EVENT_TYPE_NOT_ALLOWED");
  const payloadBytes = Buffer.byteLength(canonical(payload ?? {}));
  if (payloadBytes > 16 * 1024) throw new Error("EVENT_PAYLOAD_TOO_LARGE");

  if (type === "SERVICE_REQUESTED") {
    if (sender !== "A") throw new Error("SERVICE_REQUESTED_MUST_BE_SENT_BY_A");
    if (acceptedEvent(rows, type)) throw new Error("SERVICE_REQUEST_ALREADY_EXISTS");
    return { requestId: requestIdOf(payload), service: cleanText(payload?.service, "SERVICE", 120) };
  }

  if (type === "SERVICE_ACCEPTED") {
    if (sender !== "B") throw new Error("SERVICE_ACCEPTED_MUST_BE_SENT_BY_B");
    const request = acceptedEvent(rows, "SERVICE_REQUESTED");
    if (!request) throw new Error("SERVICE_REQUEST_REQUIRED");
    const requestId = requestIdOf(payload);
    if (requestId !== requestIdOf(request.payload)) throw new Error("REQUEST_ID_MISMATCH");
    if (acceptedEvent(rows, type)) throw new Error("SERVICE_ACCEPT_ALREADY_EXISTS");
    return { requestId };
  }

  if (type === "RESULT_COMMITTED") {
    if (sender !== "B") throw new Error("RESULT_COMMITTED_MUST_BE_SENT_BY_B");
    if (!acceptedEvent(rows, "SERVICE_ACCEPTED")) throw new Error("SERVICE_ACCEPT_REQUIRED");
    const request = acceptedEvent(rows, "SERVICE_REQUESTED");
    const requestId = requestIdOf(payload);
    if (requestId !== requestIdOf(request?.payload)) throw new Error("REQUEST_ID_MISMATCH");
    if (acceptedEvent(rows, type)) throw new Error("RESULT_COMMITMENT_ALREADY_EXISTS");
    return { requestId, resultHash: h32(payload?.resultHash, "RESULT_HASH") };
  }

  if (type === "SESSION_COMPLETED") {
    if (sender !== "B") throw new Error("SESSION_COMPLETED_MUST_BE_SENT_BY_B");
    if (!acceptedEvent(rows, "RESULT_COMMITTED")) throw new Error("RESULT_COMMITMENT_REQUIRED");
    const request = acceptedEvent(rows, "SERVICE_REQUESTED");
    const requestId = requestIdOf(payload);
    if (requestId !== requestIdOf(request?.payload)) throw new Error("REQUEST_ID_MISMATCH");
    if (acceptedEvent(rows, type)) throw new Error("SESSION_COMPLETION_ALREADY_EXISTS");
    return { requestId };
  }

  if (type === "PAYMENT_SETTLED") {
    if (sender !== "A") throw new Error("PAYMENT_SETTLED_MUST_BE_SENT_BY_A");
    if (!acceptedEvent(rows, "SERVICE_ACCEPTED")) throw new Error("SERVICE_ACCEPT_REQUIRED");
    return payload;
  }

  const request = acceptedEvent(rows, "SERVICE_REQUESTED");
  return {
    requestId: payload?.requestId ? requestIdOf(payload) : request ? requestIdOf(request.payload) : undefined,
    note: cleanText(payload?.note, "NOTE", 500)
  };
}

function assertChainPrecondition(rows: any[], input: any) {
  const expectedCount = Number(input.expectedEventCount);
  if (!Number.isInteger(expectedCount) || expectedCount < 0) throw new Error("EXPECTED_EVENT_COUNT_REQUIRED");
  const currentTip = rows.at(-1)?.signedEvent?.eventHash || ZERO_HASH;
  const expectedTip = String(input.expectedChainTip || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/i.test(expectedTip)) throw new Error("EXPECTED_CHAIN_TIP_REQUIRED");
  if (expectedCount !== rows.length || expectedTip !== currentTip.toLowerCase()) throw new Error("STATE_PRECONDITION_FAILED");
}

async function appendEvent(input: any) {
  const sessionId = String(input.sessionId || "");
  const idem = String(input.idempotencyKey || "");
  return withIdempotency(`event:${sessionId}:${idem}`, input, async (store) => {
    const sessionRow = store.sessions[sessionId];
    if (!sessionRow) throw new Error("SESSION_NOT_FOUND");
    if (sessionRow.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    const signedSession = sessionRow.signedSession as SignedSession;
    const mode = modeFromSignedSession(signedSession);
    const keys = keysForMode(mode);
    if (Date.now() >= Date.parse(signedSession.session.expiresAt)) throw new Error("SESSION_EXPIRED");
    const existing = store.events[sessionId] || [];
    assertChainPrecondition(existing, input);
    const last = existing.at(-1);
    const sequence = last ? Number(last.signedEvent.sequence) + 1 : 1;
    if (sequence > signedSession.session.maxEvents) throw new Error("SESSION_MAX_EVENTS_REACHED");
    const senderInput = String(input.sender || "A").toUpperCase();
    if (senderInput !== "A" && senderInput !== "B") throw new Error("INVALID_SENDER");
    const sender = senderInput as "A" | "B";
    const senderKey = sender === "A" ? keys.keyA : keys.keyB;
    const receiverKey = sender === "A" ? keys.keyB : keys.keyA;
    const receiverPub = sender === "A" ? keys.pubB : keys.pubA;
    const previousHash = last ? last.signedEvent.eventHash : ZERO_HASH;
    const type = String(input.type || "").toUpperCase();
    const payload = validateEventInput(existing, sender, type, input.payload ?? {});
    const event: SignedEvent = signEvent({
      sessionId, sequence, previousHash,
      type,
      payload,
      sender: sender === "A" ? keys.pubA : keys.pubB,
      createdAt: new Date().toISOString()
    }, senderKey);

    let paymentEvidence: SignedFiberPaymentEvidence | undefined;
    if (event.type === "PAYMENT_SETTLED") {
      const claim = event.payload as FiberPaymentClaim;
      if (String(claim?.sessionId || "") !== sessionId) throw new Error("FIBER_PAYMENT_SESSION_MISMATCH");
      if (!process.env.FIBER_RECEIVER_RPC_URL) throw new Error("FIBER_RECEIVER_RPC_REQUIRED_FOR_PAYMENT_ACCEPT");
      const fiber = new FiberRpcClient(process.env.FIBER_RECEIVER_RPC_URL, process.env.FIBER_RECEIVER_RPC_TOKEN || undefined);
      const verified = await fiber.verifyReceivedPaymentClaim(claim);
      if (!verified.ok) throw new Error(verified.reason);
      paymentEvidence = signFiberPaymentEvidence(verified.evidence, receiverPub, receiverKey);
      const paymentHash = paymentEvidence.evidence.claim.paymentHash.toLowerCase();
      const existingClaim = store.paymentClaims[paymentHash];
      if (existingClaim && (existingClaim.sessionId !== sessionId || existingClaim.eventHash !== event.eventHash.toLowerCase())) {
        throw new Error("FIBER_PAYMENT_HASH_REUSE");
      }
      if (!existingClaim) store.paymentClaims[paymentHash] = { sessionId, eventHash: event.eventHash.toLowerCase(), claim: paymentEvidence.evidence.claim };

      const identityHash = stableEvidenceIdentity(paymentEvidence);
      const priorEvidence = store.paymentEvidence[paymentHash];
      if (priorEvidence && priorEvidence.identityHash !== identityHash) throw new Error("FIBER_PAYMENT_EVIDENCE_CONFLICT");
      if (priorEvidence) {
        priorEvidence.evidence = paymentEvidence;
        priorEvidence.lastVerifiedAt = paymentEvidence.evidence.verifiedAt;
        priorEvidence.verificationCount += 1;
      } else {
        store.paymentEvidence[paymentHash] = {
          sessionId,
          eventHash: event.eventHash.toLowerCase(),
          identityHash,
          evidence: paymentEvidence,
          firstVerifiedAt: paymentEvidence.evidence.verifiedAt,
          lastVerifiedAt: paymentEvidence.evidence.verifiedAt,
          verificationCount: 1
        };
      }
    }

    const ack: SignedAck = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: receiverPub, createdAt: new Date().toISOString() }, receiverKey);
    existing.push({ eventHash: event.eventHash.toLowerCase(), sequence, signedEvent: event, ack, status: "FINAL" });
    store.events[sessionId] = existing;
    return { ok: true, workspaceMode: mode, event, ack, paymentEvidence };
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
    const signedSession = session.signedSession as SignedSession;
    const mode = modeFromSignedSession(signedSession);
    const keys = keysForMode(mode);
    const rows = store.events[sessionId] || [];
    assertChainPrecondition(rows, input);
    const required = ["SERVICE_REQUESTED", "SERVICE_ACCEPTED", "RESULT_COMMITTED", "SESSION_COMPLETED"];
    const missing = required.filter((type) => !acceptedEvent(rows, type));
    if (missing.length) throw new Error(`REFERENCE_FLOW_INCOMPLETE:${missing.join(",")}`);
    const items = rows.map((r: any) => ({ event: r.signedEvent as SignedEvent, ack: r.ack as SignedAck }));
    if (items.some((x: any) => !x.ack || x.ack.decision !== "ACCEPT")) throw new Error("ALL_EVENTS_MUST_BE_ACCEPTED_BEFORE_CLOSE");
    const finalState = input.finalState ?? { completed: true, sessionId };
    if (Buffer.byteLength(canonical(finalState)) > 32 * 1024) throw new Error("FINAL_STATE_TOO_LARGE");
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
      signatureA: signProtocolObject(SIGNING_DOMAIN.CLOSE, body, keys.keyA),
      signatureB: signProtocolObject(SIGNING_DOMAIN.CLOSE, body, keys.keyB)
    };
    session.signedClose = signedClose;
    session.status = "CLOSED";
    return { ok: true, workspaceMode: mode, close: signedClose };
  });
}

function ckbBroadcastEnabled() {
  const optedIn = process.env.TESTNET_ALLOW_CKB_BROADCAST === "true" || process.env.DEMO_ALLOW_CKB_BROADCAST === "true";
  return process.env.EVENTMESH_TESTNET_MODE === "true" && optedIn && !!process.env.CKB_PRIVATE_KEY;
}

async function anchorSession(input: any) {
  const sessionId = String(input.sessionId || "");
  if (!ckbBroadcastEnabled()) throw new Error("CKB_BROADCAST_DISABLED");

  const reserved = await mutateDemoStore((store) => {
    const session = store.sessions[sessionId];
    if (!session) throw new Error("SESSION_NOT_FOUND");
    if (modeFromSignedSession(session.signedSession) !== "testnet") throw new Error("ANCHOR_REQUIRES_TESTNET_WORKSPACE");
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
  const op = await readDemoStore((store) => {
    const session = store.sessions[sessionId];
    if (!session) throw new Error("SESSION_NOT_FOUND");
    if (modeFromSignedSession(session.signedSession) !== "testnet") throw new Error("ANCHOR_REQUIRES_TESTNET_WORKSPACE");
    return store.anchorOps[sessionId];
  });
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

async function requestMode(input: any): Promise<WorkspaceMode> {
  const action = String(input?.action || "");
  if (action === "create_session") return requestedMode(input?.mode);
  if (input?.snapshot) return validatePortableSnapshot(input.snapshot).mode;
  if (input?.sessionId) {
    return readDemoStore((store) => {
      const row = store.sessions[String(input.sessionId)];
      if (!row) throw new Error("SESSION_NOT_FOUND");
      return modeFromSignedSession(row.signedSession);
    });
  }
  return requestedMode(input?.mode);
}

export default async function handler(req: any, res: ServerResponse) {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url || "/api/demo", baseUrl(req));
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const state = await loadState(sessionId);
        authorizeWorkspace(req, state.workspaceMode);
        return json(res, 200, state);
      }

      const demoReady = !!configuredMasterSecret();
      const testnetEnabled = process.env.EVENTMESH_TESTNET_MODE === "true";
      const testnetKeysReady = !!testnetKeyA && !!testnetKeyB && !!testnetPubA && !!testnetPubB;
      const testnetAccessReady = !!accessKeyConfigured();
      return json(res, 200, {
        ok: demoReady,
        protocol: PROTOCOL,
        version: "0.6.0",
        network: "CKB Testnet",
        storage: { mode: DEMO_STORAGE_MODE, durable: DEMO_STORAGE_DURABLE, portableRecovery: true },
        operatorA: demoPubA,
        operatorB: demoPubB,
        workspaces: {
          demo: {
            ready: demoReady,
            environment: "DEMO",
            operatorA: demoPubA,
            operatorB: demoPubB,
            autoFlow: true,
            persistence: "portable-browser-snapshot"
          },
          testnet: {
            enabled: testnetEnabled,
            ready: testnetEnabled && testnetKeysReady && testnetAccessReady && configurationErrors.length === 0,
            environment: "TESTNET",
            operatorA: testnetPubA || null,
            operatorB: testnetPubB || null,
            operatorKeysConfigured: testnetKeysReady,
            accessKeyConfigured: testnetAccessReady,
            autoFlow: false,
            mutationAuth: "x-eventmesh-access-key"
          }
        },
        capabilities: {
          fiberPayments: !!process.env.FIBER_RECEIVER_RPC_URL,
          ckbAnchoring: ckbBroadcastEnabled(),
          ckbReconciliation: true
        },
        security: {
          sameOriginMutations: true,
          optimisticChainPreconditions: true,
          eventSchemaValidation: true,
          maxBodyBytes: 2 * 1024 * 1024,
          maxEventPayloadBytes: 16 * 1024
        }
      });
    }

    if (req.method !== "POST") return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    enforceSameOrigin(req);
    const input = await bodyOf(req);
    const action = String(input.action || "");
    const mode = await requestMode(input);

    if (mode === "demo") {
      if (!configuredMasterSecret()) throw new Error(process.env.DEMO_MASTER_SECRET ? "DEMO_MASTER_SECRET_TOO_SHORT" : "DEMO_MASTER_SECRET_REQUIRED");
    }
    if (mode === "testnet" && action !== "verify_snapshot") authorizeWorkspace(req, mode);
    await rateLimit(req, mode);

    if (input.snapshot && action !== "verify_snapshot") {
      await restorePortableSnapshot(input.snapshot);
    }

    let result: any;
    switch (action) {
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
        result = { ok: true, sessionId, workspaceMode: mode, reset: true };
        break;
      }
      default: throw new Error("UNKNOWN_ACTION");
    }
    const shouldLoadState = !["verify_snapshot", "reset_session"].includes(action);
    const state = shouldLoadState
      ? result?.sessionId ? await loadState(result.sessionId) : input.sessionId ? await loadState(String(input.sessionId)) : undefined
      : undefined;
    return json(res, 200, { ...result, state });
  } catch (error: any) {
    const message = safeErrorMessage(error);
    const status = message === "RATE_LIMITED" ? 429
      : message === "TESTNET_ACCESS_DENIED" ? 401
      : message.includes("NOT_FOUND") ? 404
      : message.includes("REQUIRED") || message.includes("DISABLED") || message.includes("NOT_CONFIGURED") ? 503
      : message.includes("TOO_LARGE") ? 413
      : message === "STATE_PRECONDITION_FAILED" || message.includes("CONFLICT") ? 409
      : 400;
    return json(res, status, { error: message });
  }
}
