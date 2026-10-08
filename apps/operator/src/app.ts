import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AckBodySchema,
  ApplicationProfileSchema,
  ChainContextSchema,
  CkbScriptSchema,
  CloseBodySchema,
  CLOSE_COMMITMENT_VERSION,
  EventBodySchema,
  FiberPaymentClaimSchema,
  SignedFiberPaymentEvidenceSchema,
  PROTOCOL,
  SessionSchema,
  SignedAckSchema,
  SignedCloseSchema,
  SignedEventSchema,
  SignedSessionSchema,
  SIGNING_DOMAIN,
  ZERO_HASH,
  acceptedFiberPaymentHashes,
  applicationProfileHashFrom,
  buildAnchorDataHex,
  canonical,
  chainContextHashFrom,
  computeFiberPaymentPurposeHash,
  computePaymentEvidenceRoot,
  computeSignedPaymentEvidenceRoot,
  computeTranscriptRoot,
  createSessionId,
  deriveGenericBilateralFinalState,
  finalStateHashFrom,
  GENERIC_BILATERAL_PROFILE,
  sha256Hex,
  signAck,
  signFiberPaymentEvidence,
  signEvent,
  signProtocolObject,
  verifyAck,
  verifyEvent,
  verifyFiberPaymentEvidence,
  verifyProtocolObject,
  type SignedFiberPaymentEvidence,
  type SignedSession
} from "@eventmesh/core";
import { FiberRpcClient } from "@eventmesh/fiber";
import { CkbAnchorClient, inspectAnchorRpc } from "@eventmesh/ckb";
import { PAID_SERVICE_PROFILE, paidServiceReferenceAdapter, validateTranscriptWithAdapter } from "@eventmesh/adapter-sdk";
import { Store } from "./store.js";
import { loadIdentity } from "./identity.js";
import { adminTokenMatches, extractAdminToken, validatePeerUrl } from "./security.js";
import { pinnedPeerFetch, type PeerHttpResponse } from "./peer-http.js";

export type OperatorAppOptions = {
  name: string;
  selfUrl: string;
  dataDir: string;
  defaultPeerUrl?: string;
  operatorPrivateKey?: string;
  publicMode?: boolean;
  allowPrivatePeerUrls?: boolean;
  allowedPeerHosts?: Set<string>;
  adminToken?: string;
  corsOrigins?: string[];
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  peerRateLimitMax?: number;
  peerRateLimitWindowMs?: number;
  peerRateLimitMaxTrackedPeers?: number;
  maxPeerResponseBytes?: number;
  outboxRetryIntervalMs?: number;
  fiber?: FiberRpcClient;
  ckb?: CkbAnchorClient;
  ckbRpcUrl?: string;
  ckbMinConfirmations?: number;
  autoAnchorOnClose?: boolean;
};

type Identity = { privateKey: string; publicKey: string };
type Handler = (req: any, reply: FastifyReply) => unknown | Promise<unknown>;

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  if (url.pathname === "/") url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

export async function buildOperatorApp(options: OperatorAppOptions): Promise<{
  app: FastifyInstance;
  store: Store;
  identity: Identity;
}> {
  const publicMode = options.publicMode ?? false;
  const allowPrivatePeerUrls = options.allowPrivatePeerUrls ?? !publicMode;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  const peerRateLimitMax = options.peerRateLimitMax ?? (publicMode ? 120 : 1000);
  const peerRateLimitWindowMs = options.peerRateLimitWindowMs ?? 60_000;
  const peerRateLimitMaxTrackedPeers = Math.max(128, options.peerRateLimitMaxTrackedPeers ?? 4096);
  const maxPeerResponseBytes = options.maxPeerResponseBytes ?? 4 * 1024 * 1024;
  const outboxRetryIntervalMs = options.outboxRetryIntervalMs ?? 15_000;
  for (const [name, value] of Object.entries({ requestTimeoutMs, maxBodyBytes, peerRateLimitMax, peerRateLimitWindowMs, maxPeerResponseBytes, outboxRetryIntervalMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_OPERATOR_CONFIG:${name}`);
  }
  const ckbMinConfirmations = Math.max(0, options.ckbMinConfirmations ?? (publicMode ? 2 : 0));
  if (publicMode && !options.adminToken) throw new Error("PUBLIC_MODE_REQUIRES_ADMIN_TOKEN");
  if (publicMode && !options.selfUrl.startsWith("https://")) throw new Error("PUBLIC_MODE_REQUIRES_HTTPS_SELF_URL");

  mkdirSync(options.dataDir, { recursive: true });
  const identity = loadIdentity(options.dataDir, options.operatorPrivateKey, publicMode);
  const store = new Store(join(options.dataDir, "eventmesh-state.json"));
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: maxBodyBytes });
  const corsOrigins = new Set(options.corsOrigins ?? ["http://localhost:3000"]);
  const peerRate = new Map<string, { count: number; resetAt: number }>();
  const sessionQueues = new Map<string, Promise<void>>();
  const deliveryInFlight = new Map<string, Promise<{ id: string; delivered: boolean; error?: string }>>();

  // Requests for one session are ordered across awaits (including Fiber RPC).
  // This guards against duplicate ACK/close signatures and accidental forks in
  // this single-process operator. The store lock disallows a second writer.
  function serialized(handler: Handler): Handler {
    return async (req, reply) => {
      const sessionId = String(req.params?.id ?? "");
      if (!sessionId) return handler(req, reply);
      const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => pending);
      sessionQueues.set(sessionId, tail);
      await previous;
      try { return await handler(req, reply); }
      finally {
        release();
        if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId);
      }
    };
  }

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      callback(null, corsOrigins.has(origin));
    },
    methods: ["GET", "POST"]
  });

  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryPromise: Promise<void> | undefined;
  let stopping = false;
  app.addHook("onClose", async () => {
    stopping = true;
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (recoveryPromise) await recoveryPromise;
    // Wait for in-flight deliveries before releasing the single-writer lock.
    await Promise.allSettled([...deliveryInFlight.values()]);
    store.close();
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/peer/")) return;
    const now = Date.now();
    const key = req.ip;
    let bucket = peerRate.get(key);
    if (!bucket && peerRate.size >= peerRateLimitMaxTrackedPeers) {
      for (const [candidate, value] of peerRate) {
        if (now >= value.resetAt) peerRate.delete(candidate);
      }
      while (peerRate.size >= peerRateLimitMaxTrackedPeers) {
        const oldest = [...peerRate.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)[0]?.[0];
        if (!oldest) break;
        peerRate.delete(oldest);
      }
    }
    bucket = peerRate.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + peerRateLimitWindowMs };
      peerRate.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > peerRateLimitMax) {
      reply.header("retry-after", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return reply.code(429).send({ error: "PEER_RATE_LIMITED" });
    }
  });

  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!options.adminToken && !publicMode) return true;
    const provided = extractAdminToken(req.headers as Record<string, unknown>);
    if (!adminTokenMatches(provided, options.adminToken)) {
      reply.code(401).send({ error: "ADMIN_AUTH_REQUIRED" });
      return false;
    }
    return true;
  }

  async function checkedPeerBase(rawUrl: string): Promise<string> {
    const url = await validatePeerUrl(rawUrl, {
      publicMode,
      allowPrivatePeerUrls,
      allowedHosts: options.allowedPeerHosts
    });
    return normalizedUrl(url.toString());
  }

  async function peerFetch(url: string, init?: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string }): Promise<PeerHttpResponse> {
    const parsed = new URL(url);
    if (!/^\/(?:identity|peer\/sessions\/[a-zA-Z0-9_-]+\/(?:join|events|acks|close|anchor|head))$/.test(parsed.pathname)) {
      throw new Error("PEER_REQUEST_PATH_NOT_ALLOWED");
    }
    if (parsed.search || parsed.hash) throw new Error("PEER_REQUEST_PATH_NOT_ALLOWED");
    return pinnedPeerFetch(url, {
      publicMode, allowPrivatePeerUrls, allowedHosts: options.allowedPeerHosts,
      timeoutMs: requestTimeoutMs, maxResponseBytes: maxPeerResponseBytes
    }, init);
  }

  async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await peerFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`PEER_HTTP_${response.status}`);
    return text ? JSON.parse(text) as T : ({} as T);
  }

  function peerUrlFor(session: SignedSession): string {
    return session.session.operatorA === identity.publicKey ? session.session.operatorBUrl : session.session.operatorAUrl;
  }

  async function postPeer<T>(session: SignedSession, path: string, body: unknown): Promise<T> {
    const base = await checkedPeerBase(peerUrlFor(session));
    return postJson<T>(`${base}${path}`, body);
  }

  async function getPeer<T>(session: SignedSession, path: string): Promise<T> {
    const base = await checkedPeerBase(peerUrlFor(session));
    const response = await peerFetch(`${base}${path}`);
    const text = await response.text();
    if (!response.ok) throw new Error(`PEER_HTTP_${response.status}`);
    return text ? JSON.parse(text) as T : ({} as T);
  }

  async function deliverOutboxRowOnce(row: ReturnType<Store["listOutbox"]>[number]) {
    if (store.getOutbox(row.id)?.status === "DELIVERED") return { id: row.id, delivered: true };
    const session = store.getSession(row.sessionId);
    if (!session) {
      store.markOutboxAttempt(row.id, "SESSION_NOT_FOUND");
      return { id: row.id, delivered: false, error: "SESSION_NOT_FOUND" };
    }
    try {
      await postPeer(session.signed, row.path, row.body);
      store.markOutboxAttempt(row.id);
      store.markOutboxDelivered(row.id);
      return { id: row.id, delivered: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : "PEER_DELIVERY_FAILED";
      store.markOutboxAttempt(row.id, detail);
      return { id: row.id, delivered: false, error: detail };
    }
  }

  // All paths (auto-retry, admin drain, immediate send) share the same attempt.
  function deliverOutboxRow(row: ReturnType<Store["listOutbox"]>[number]) {
    const existing = deliveryInFlight.get(row.id);
    if (existing) return existing;
    const task = deliverOutboxRowOnce(row);
    deliveryInFlight.set(row.id, task);
    void task.finally(() => { if (deliveryInFlight.get(row.id) === task) deliveryInFlight.delete(row.id); }).catch(() => {});
    return task;
  }

  let recoveryRunning = false;
  let recoveryCycles = 0;
  async function recoverPendingOutbox() {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      const now = Date.now();
      const ready = store.listOutbox("PENDING").filter((row) => {
        const lastAttempt = row.lastAttemptAt ? Date.parse(row.lastAttemptAt) : 0;
        const baseDelay = Math.min(300_000, 2000 * 2 ** Math.min(8, Math.max(0, row.attempts - 1)));
        const jitter = 0.8 + parseInt(sha256Hex(row.id).slice(2, 4), 16) / 255 * 0.4;
        return !lastAttempt || !Number.isFinite(lastAttempt) || now - lastAttempt >= baseDelay * jitter;
      }).slice(0, 25);
      for (const row of ready) {
        if (stopping) break;
        await deliverOutboxRow(row);
      }
      if (++recoveryCycles % 240 === 0 && !stopping) store.pruneDeliveredOutbox();
    } catch (error) {
      app.log.error({ error }, "Outbox recovery failure");
    } finally { recoveryRunning = false; }
  }
  recoveryTimer = setInterval(() => {
    if (!recoveryPromise && !stopping) {
      recoveryPromise = recoverPendingOutbox().finally(() => { recoveryPromise = undefined; });
    }
  }, outboxRetryIntervalMs);
  recoveryTimer.unref();

  async function queueAndDeliver(input: {
    id: string;
    sessionId: string;
    kind: "EVENT" | "ACK" | "ANCHOR_NOTICE";
    path: string;
    body: unknown;
  }) {
    const row = store.enqueueOutbox(input);
    if (row.status === "DELIVERED") return { id: row.id, status: "DELIVERED" as const, attempts: row.attempts };
    const result = await deliverOutboxRow(row);
    const current = store.getOutbox(input.id)!;
    return {
      id: row.id,
      status: result.delivered ? "DELIVERED" as const : "PENDING" as const,
      attempts: current.attempts,
      ...(result.error ? { error: result.error } : {})
    };
  }

  function assertSessionParticipant(session: SignedSession) {
    if (identity.publicKey !== session.session.operatorA && identity.publicKey !== session.session.operatorB) {
      throw new Error("LOCAL_OPERATOR_NOT_SESSION_PARTICIPANT");
    }
  }

  function assertSessionOpen(session: SignedSession, status: string) {
    if (status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    if (Date.now() >= new Date(session.session.expiresAt).getTime()) throw new Error("SESSION_EXPIRED");
  }

  function paymentEvidenceForEvent(sessionId: string, eventHash: string): SignedFiberPaymentEvidence | undefined {
    const event = store.getEvent(eventHash)?.event;
    if (!event || event.type !== "PAYMENT_SETTLED") return undefined;
    const claim = FiberPaymentClaimSchema.safeParse(event.payload);
    if (!claim.success) return undefined;
    return store.listPaymentEvidence(sessionId)
      .find((evidence) => evidence.evidence.claim.paymentHash.toLowerCase() === claim.data.paymentHash.toLowerCase());
  }

  function supportedProfile(profile: unknown): "generic" | "paid-service" | "legacy" {
    if (!profile) return "legacy";
    const parsed = ApplicationProfileSchema.safeParse(profile);
    if (!parsed.success) throw new Error("APPLICATION_PROFILE_INVALID");
    const matches = (expected: typeof GENERIC_BILATERAL_PROFILE) =>
      parsed.data.id === expected.id
      && parsed.data.version === expected.version
      && parsed.data.rulesHash.toLowerCase() === expected.rulesHash.toLowerCase();
    if (matches(GENERIC_BILATERAL_PROFILE)) return "generic";
    if (matches(PAID_SERVICE_PROFILE)) return "paid-service";
    throw new Error("APPLICATION_PROFILE_UNSUPPORTED_OR_RULES_HASH_MISMATCH");
  }

  function requestedProfile(name?: string) {
    if (!name || name === "generic-bilateral-v1") return GENERIC_BILATERAL_PROFILE;
    if (name === "paid-service-v1") return PAID_SERVICE_PROFILE;
    throw new Error("APPLICATION_PROFILE_UNSUPPORTED");
  }

  function normalizeProfilePayload(
    signed: SignedSession,
    events: ReturnType<Store["listEvents"]>,
    type: string,
    payload: unknown
  ) {
    if (supportedProfile(signed.session.applicationProfile) !== "paid-service" || type !== "PAYMENT_SETTLED") return payload;
    const claim = FiberPaymentClaimSchema.parse(payload);
    const requested = events.find((row) => row.status === "FINAL" && row.ack?.decision === "ACCEPT" && row.event.type === "SERVICE_REQUESTED");
    const result = events.find((row) => row.status === "FINAL" && row.ack?.decision === "ACCEPT" && row.event.type === "RESULT_COMMITTED");
    if (!requested || !result) throw new Error("PAID_SERVICE_RESULT_REQUIRED_BEFORE_PAYMENT");
    const requestId = typeof (requested.event.payload as any)?.requestId === "string"
      ? String((requested.event.payload as any).requestId)
      : "";
    if (!requestId) throw new Error("PAID_SERVICE_REQUEST_ID_MISSING");
    if (claim.obligationId && claim.obligationId !== requestId) throw new Error("PAYMENT_OBLIGATION_ID_MISMATCH");
    if (claim.settlesEventHash && claim.settlesEventHash.toLowerCase() !== result.event.eventHash.toLowerCase()) {
      throw new Error("PAYMENT_SETTLES_EVENT_HASH_MISMATCH");
    }
    const bound = {
      ...claim,
      obligationId: requestId,
      settlesEventHash: result.event.eventHash.toLowerCase()
    };
    const purposeHash = computeFiberPaymentPurposeHash(bound);
    if (claim.purposeHash && claim.purposeHash.toLowerCase() !== purposeHash.toLowerCase()) {
      throw new Error("PAYMENT_PURPOSE_HASH_MISMATCH");
    }
    return FiberPaymentClaimSchema.parse({ ...bound, purposeHash });
  }

  function validateProfileEvent(signed: SignedSession, event: z.infer<typeof SignedEventSchema>) {
    if (supportedProfile(signed.session.applicationProfile) !== "paid-service") return;
    const expectedSender = new Map<string, string>([
      ["SERVICE_REQUESTED", signed.session.operatorA],
      ["SERVICE_ACCEPTED", signed.session.operatorB],
      ["RESULT_COMMITTED", signed.session.operatorB],
      ["PAYMENT_SETTLED", signed.session.operatorA],
      ["SESSION_COMPLETED", signed.session.operatorB]
    ]);
    const requiredSender = expectedSender.get(event.type);
    if (requiredSender && event.sender.toLowerCase() !== requiredSender.toLowerCase()) {
      throw new Error(`APPLICATION_PROFILE_WRONG_EVENT_AUTHOR:${event.type}`);
    }
    const result = paidServiceReferenceAdapter.validateEvent(event);
    if (!result.ok) throw new Error(`APPLICATION_PROFILE_EVENT_INVALID:${result.reason}`);
  }

  function deriveProfileFinalState(signed: SignedSession, events: ReturnType<Store["listEvents"]>) {
    const finalItems = events.map((item) => ({ event: item.event, ack: item.ack! }));
    const profile = supportedProfile(signed.session.applicationProfile);
    if (profile === "legacy") return undefined;
    if (profile === "generic") return deriveGenericBilateralFinalState(finalItems);
    const transcript = {
      session: signed,
      events: finalItems,
      paymentEvidence: store.listPaymentEvidence(signed.session.sessionId)
    };
    const result = validateTranscriptWithAdapter(transcript, paidServiceReferenceAdapter);
    if (!result.ok || result.finalState === undefined) {
      throw new Error(`APPLICATION_PROFILE_TRANSCRIPT_INVALID:${result.errors.join("|")}`);
    }
    return result.finalState;
  }

  function commitmentV3Fields(signed: SignedSession, events: ReturnType<Store["listEvents"]>) {
    const acceptedPayments = acceptedFiberPaymentHashes(events);
    const byPayment = new Map(store.listPaymentEvidence(signed.session.sessionId)
      .map((evidence) => [evidence.evidence.claim.paymentHash.toLowerCase(), evidence] as const));
    const evidence = acceptedPayments.map((paymentHash) => {
      const found = byPayment.get(paymentHash);
      if (!found) throw new Error(`SIGNED_PAYMENT_EVIDENCE_REQUIRED:${paymentHash}`);
      return found;
    });
    for (const row of events) {
      if (row.event.type !== "PAYMENT_SETTLED" || row.ack?.decision !== "ACCEPT") continue;
      const claim = FiberPaymentClaimSchema.parse(row.event.payload);
      const observed = byPayment.get(claim.paymentHash.toLowerCase());
      if (!row.ack.evidenceHash || !observed || row.ack.evidenceHash.toLowerCase() !== observed.evidenceHash.toLowerCase()) {
        throw new Error(`PAYMENT_ACK_EVIDENCE_BINDING_REQUIRED:${row.event.sequence}`);
      }
    }
    return {
      commitmentVersion: CLOSE_COMMITMENT_VERSION,
      paymentObservationRoot: computeSignedPaymentEvidenceRoot(evidence),
      applicationProfileHash: applicationProfileHashFrom(signed.session),
      chainContextHash: chainContextHashFrom(signed.session)
    } as const;
  }

  function anchorExtensions(close: z.infer<typeof CloseBodySchema>) {
    if (close.commitmentVersion !== CLOSE_COMMITMENT_VERSION
      || !close.paymentObservationRoot
      || !close.applicationProfileHash
      || !close.chainContextHash) return undefined;
    return {
      paymentObservationRoot: close.paymentObservationRoot,
      applicationProfileHash: close.applicationProfileHash,
      chainContextHash: close.chainContextHash
    };
  }

  async function createAndStoreAnchor(sessionId: string) {
    if (!options.ckb) throw new Error("CKB_ANCHOR_DISABLED");
    const record = store.getSession(sessionId);
    if (!record?.close) throw new Error("CLOSE_REQUIRED_BEFORE_ANCHOR");
    if (record.anchor) return record.anchor;
    const close = record.close.close;

    // Prepare + sign first so the transaction identity is deterministic, persist
    // that identity, and only then cross the irreversible broadcast boundary.
    const prepared = await options.ckb.prepareAnchor({
      sessionId,
      transcriptRoot: close.transcriptRoot,
      finalStateHash: close.finalStateHash,
      paymentEvidenceRoot: close.paymentEvidenceRoot,
      ...anchorExtensions(close)
    });
    const pending = { txHash: prepared.txHash, dataHex: prepared.dataHex, status: "PENDING" as const };
    const write = store.saveAnchor(sessionId, pending);
    if (write === "CONFLICT") throw new Error("ANCHOR_CONFLICT");

    try {
      const broadcast = await options.ckb.broadcastPrepared(prepared);
      store.saveAnchor(sessionId, broadcast);
      return broadcast;
    } catch (error) {
      // Keep the prepared tx hash. A timeout is ambiguous: the transaction may
      // already be in the mempool, so reconciliation must query by this hash.
      app.log.warn({ error, txHash: prepared.txHash }, "CKB broadcast result ambiguous; retained deterministic tx hash");
      return pending;
    }
  }

  async function reconcileAnchor(sessionId: string) {
    const record = store.getSession(sessionId);
    if (!record?.close) throw new Error("CLOSE_REQUIRED_BEFORE_ANCHOR");
    if (!record.anchor) throw new Error("ANCHOR_NOT_FOUND");
    if (!options.ckbRpcUrl) throw new Error("CKB_RPC_REQUIRED");
    const close = record.close.close;
    const expected = buildAnchorDataHex(
      sessionId,
      close.transcriptRoot,
      close.finalStateHash,
      close.paymentEvidenceRoot,
      anchorExtensions(close)
    );
    const verification = await inspectAnchorRpc(options.ckbRpcUrl, record.anchor.txHash, expected, ckbMinConfirmations);
    if (!verification.ok) {
      store.saveAnchor(sessionId, { ...record.anchor, dataHex: expected, status: "PENDING" });
      return { committed: false as const, verification };
    }
    const committed = {
      ...record.anchor,
      dataHex: expected,
      status: (verification.status === "CONFIRMED" ? "CONFIRMED" : "COMMITTED") as "CONFIRMED" | "COMMITTED",
      blockHash: verification.blockHash,
      confirmations: verification.confirmations
    };
    store.saveAnchor(sessionId, committed);
    return { committed: true as const, verification, anchor: committed };
  }

  // ---------- public ----------
  app.get("/health", async () => ({
    status: "ok",
    name: options.name,
    protocol: PROTOCOL,
    publicKey: identity.publicKey,
    mode: publicMode ? "public" : "development",
    fiberEnabled: !!options.fiber,
    ckbAnchorEnabled: !!options.ckb,
    ckbVerificationEnabled: !!options.ckbRpcUrl,
    ckbMinConfirmations,
    peerRateLimit: { maxRequests: peerRateLimitMax, windowMs: peerRateLimitWindowMs, maxTrackedPeers: peerRateLimitMaxTrackedPeers },
    maxBodyBytes,
    pendingOutbox: store.listOutbox("PENDING").length
  }));
  app.get("/identity", async () => ({
    name: options.name,
    publicKey: identity.publicKey,
    selfUrl: options.selfUrl,
    protocol: PROTOCOL,
    applicationProfiles: [GENERIC_BILATERAL_PROFILE, PAID_SERVICE_PROFILE],
    peerApi: "/peer",
    adminApi: "/admin"
  }));

  // ---------- handlers ----------
  const listSessions: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return store.listSessions();
  };

  const getSession: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const record = store.getSession(req.params.id);
    if (!record) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    return {
      ...record,
      events: store.listEvents(req.params.id),
      paymentEvidence: store.listPaymentEvidence(req.params.id),
      conflicts: store.listConflicts(req.params.id)
    };
  };

  const getTranscript: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const transcript = store.exportTranscript(req.params.id);
    if (!transcript) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    return transcript;
  };

  const getEvidenceSummary: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const record = store.getSession(req.params.id);
    if (!record) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    const events = store.listEvents(req.params.id);
    const paymentEvidence = store.listPaymentEvidence(req.params.id);
    const conflicts = store.listConflicts(req.params.id);
    const acceptedPayments = acceptedFiberPaymentHashes(events);
    const evidencePaymentHashes = new Set(paymentEvidence.map((item) => item.evidence.claim.paymentHash.toLowerCase()));
    const finalEvents = events.filter((item) => item.status === "FINAL" && !!item.ack);
    const acceptedEvents = finalEvents.filter((item) => item.ack?.decision === "ACCEPT");
    const rejectedEvents = finalEvents.filter((item) => item.ack?.decision === "REJECT");
    const pendingEvents = events.filter((item) => item.status !== "FINAL" || !item.ack);
    const closeDualSigned = !!record.close?.signatureA && !!record.close?.signatureB;
    const fiberEvidenceComplete = acceptedPayments.every((hash) => evidencePaymentHashes.has(hash.toLowerCase()));

    return {
      sessionId: req.params.id,
      protocol: record.signed.session.protocol,
      status: record.status,
      operators: {
        distinct: record.signed.session.operatorA.toLowerCase() !== record.signed.session.operatorB.toLowerCase(),
        bilateralSessionSigned: !!record.signed.signatureA && !!record.signed.signatureB
      },
      events: {
        total: events.length,
        final: finalEvents.length,
        accepted: acceptedEvents.length,
        rejected: rejectedEvents.length,
        pending: pendingEvents.length
      },
      payments: {
        acceptedClaims: acceptedPayments.length,
        receiverEvidence: paymentEvidence.length,
        evidenceComplete: acceptedPayments.length > 0 && fiberEvidenceComplete
      },
      conflicts: {
        count: conflicts.length,
        kinds: [...new Set(conflicts.map((item) => item.kind))]
      },
      close: {
        present: !!record.close,
        dualSigned: closeDualSigned,
        transcriptRoot: record.close?.close.transcriptRoot,
        finalStateHash: record.close?.close.finalStateHash,
        paymentEvidenceRoot: record.close?.close.paymentEvidenceRoot
      },
      ckb: {
        anchorStatus: record.anchor?.status ?? "NONE",
        txHash: record.anchor?.txHash
      },
      readiness: {
        bilateralSession: !!record.signed.signatureA && !!record.signed.signatureB,
        allEventsFinal: events.length > 0 && pendingEvents.length === 0,
        allEventsAccepted: events.length > 0 && pendingEvents.length === 0 && rejectedEvents.length === 0,
        receiverPaymentEvidenceComplete: acceptedPayments.length > 0 && fiberEvidenceComplete,
        fiberBound: acceptedPayments.length > 0 && fiberEvidenceComplete,
        noRecordedConflicts: conflicts.length === 0,
        closeDualSigned,
        ckbCommitted: record.anchor?.status === "COMMITTED" || record.anchor?.status === "CONFIRMED",
        ckbConfirmed: record.anchor?.status === "CONFIRMED"
      }
    };
  };


  const listOutbox: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const query = z.object({
      status: z.enum(["PENDING", "DELIVERED"]).optional(),
      sessionId: z.string().optional()
    }).parse(req.query ?? {});
    return store.listOutbox(query.status, query.sessionId);
  };

  const drainOutbox: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = z.object({
      sessionId: z.string().optional(),
      limit: z.number().int().positive().max(100).default(25)
    }).parse(req.body ?? {});
    const pending = store.listOutbox("PENDING", body.sessionId).slice(0, body.limit);
    const results = [];
    for (const row of pending) results.push(await deliverOutboxRow(row));
    return { attempted: results.length, delivered: results.filter((item) => item.delivered).length, results };
  };

  const getPeerHead: Handler = async (req, reply) => {
    const head = store.sessionHead(req.params.id);
    if (!head) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    return head;
  };

  const reconcileSession: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const record = store.getSession(req.params.id);
    if (!record) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    const body = z.object({ repair: z.boolean().default(false) }).parse(req.body ?? {});

    let repairResults: Array<{ id: string; delivered: boolean; error?: string }> = [];
    if (body.repair) {
      for (const row of store.listOutbox("PENDING", req.params.id).slice(0, 100)) {
        repairResults.push(await deliverOutboxRow(row));
      }
    }

    let local = store.sessionHead(req.params.id)!;
    let remote: any;
    try {
      remote = await getPeer<any>(record.signed, `/peer/sessions/${req.params.id}/head`);
    } catch (error) {
      return reply.code(502).send({
        state: "PEER_UNREACHABLE",
        local,
        pendingOutbox: store.listOutbox("PENDING", req.params.id).length,
        repairResults,
        detail: String(error)
      });
    }

    // Recover the common crash window where local evidence was persisted but
    // the outbox entry itself was not. Rebuild delivery from immutable signed
    // evidence; never synthesize a new event or ACK.
    if (body.repair) {
      const initialLocalEntries = Array.isArray(local.entries) ? local.entries : [];
      const initialRemoteEntries = Array.isArray(remote.entries) ? remote.entries : [];
      let canContinue = true;

      for (let index = 0; index < Math.min(initialLocalEntries.length, initialRemoteEntries.length); index += 1) {
        const left = initialLocalEntries[index];
        const right = initialRemoteEntries[index];
        if (left.eventHash?.toLowerCase() !== right.eventHash?.toLowerCase()) { canContinue = false; break; }
        if (left.ackHash && !right.ackHash) {
          const row = store.getEvent(left.eventHash);
          if (row?.ack) {
            const paymentEvidence = paymentEvidenceForEvent(req.params.id, row.event.eventHash);
            const result = await queueAndDeliver({
              id: `ack:${row.ack.ackHash.toLowerCase()}`,
              sessionId: req.params.id,
              kind: "ACK",
              path: `/peer/sessions/${req.params.id}/acks`,
              body: { ack: row.ack, paymentEvidence }
            });
            repairResults.push({ id: result.id, delivered: result.status === "DELIVERED", ...(result.error ? { error: result.error } : {}) });
            if (result.status !== "DELIVERED") canContinue = false;
          }
        } else if (left.ackHash && right.ackHash && left.ackHash.toLowerCase() !== right.ackHash.toLowerCase()) {
          canContinue = false;
        }
      }

      if (canContinue && initialLocalEntries.length > initialRemoteEntries.length) {
        for (let index = initialRemoteEntries.length; index < initialLocalEntries.length; index += 1) {
          const entry = initialLocalEntries[index];
          const row = store.getEvent(entry.eventHash);
          if (!row) { canContinue = false; break; }
          const eventDelivery = await queueAndDeliver({
            id: `event:${row.event.eventHash.toLowerCase()}`,
            sessionId: req.params.id,
            kind: "EVENT",
            path: `/peer/sessions/${req.params.id}/events`,
            body: { event: row.event }
          });
          repairResults.push({ id: eventDelivery.id, delivered: eventDelivery.status === "DELIVERED", ...(eventDelivery.error ? { error: eventDelivery.error } : {}) });
          if (eventDelivery.status !== "DELIVERED") { canContinue = false; break; }

          if (row.ack) {
            const paymentEvidence = paymentEvidenceForEvent(req.params.id, row.event.eventHash);
            const ackDelivery = await queueAndDeliver({
              id: `ack:${row.ack.ackHash.toLowerCase()}`,
              sessionId: req.params.id,
              kind: "ACK",
              path: `/peer/sessions/${req.params.id}/acks`,
              body: { ack: row.ack, paymentEvidence }
            });
            repairResults.push({ id: ackDelivery.id, delivered: ackDelivery.status === "DELIVERED", ...(ackDelivery.error ? { error: ackDelivery.error } : {}) });
            if (ackDelivery.status !== "DELIVERED") { canContinue = false; break; }
          }
        }
      }

      try {
        local = store.sessionHead(req.params.id)!;
        remote = await getPeer<any>(record.signed, `/peer/sessions/${req.params.id}/head`);
      } catch { /* keep last known heads; delivery results already explain failure */ }
    }

    const localEntries = Array.isArray(local.entries) ? local.entries : [];
    const remoteEntries = Array.isArray(remote.entries) ? remote.entries : [];
    const common = Math.min(localEntries.length, remoteEntries.length);
    for (let index = 0; index < common; index += 1) {
      const left = localEntries[index];
      const right = remoteEntries[index];
      if (left.eventHash?.toLowerCase() !== right.eventHash?.toLowerCase()) {
        return reply.code(409).send({ state: "FORK", sequence: index + 1, local: left, remote: right, repairResults });
      }
      if ((left.ackHash ?? "").toLowerCase() !== (right.ackHash ?? "").toLowerCase()) {
        return reply.code(409).send({ state: "ACK_DIVERGENCE", sequence: index + 1, local: left, remote: right, repairResults });
      }
    }

    let state = "IN_SYNC";
    if (localEntries.length > remoteEntries.length) state = "LOCAL_AHEAD";
    else if (localEntries.length < remoteEntries.length) state = "REMOTE_AHEAD";
    else if ((local.closeHash ?? null) !== (remote.closeHash ?? null)) state = "CLOSE_DIVERGENCE";
    else if ((local.anchorTxHash ?? null) !== (remote.anchorTxHash ?? null)) state = "ANCHOR_DIVERGENCE";

    return {
      state,
      local,
      remote,
      pendingOutbox: store.listOutbox("PENDING", req.params.id).length,
      repairResults,
      safeAction: state === "IN_SYNC" ? "NONE"
        : state === "LOCAL_AHEAD" ? "RETRY_LOCAL_OUTBOX_OR_REDELIVER_MISSING_EVIDENCE"
        : state === "REMOTE_AHEAD" ? "RECOVER_SIGNED_EVIDENCE_FROM_PEER_BEFORE_NEW_EVENTS"
        : "FREEZE_SESSION_AND_COMPARE_SIGNED_EVIDENCE"
    };
  };

  async function completeSessionJoin(sessionId: string) {
    const draft = store.getSession(sessionId);
    if (!draft) throw new Error("SESSION_NOT_FOUND");
    if (draft.signed.signatureB && draft.status === "ACTIVE") return draft.signed;
    const session = draft.signed.session;
    if (session.operatorA !== identity.publicKey) throw new Error("ONLY_OPERATOR_A_CAN_COMPLETE_JOIN");
    const joined = await postJson<{ signatureB: string }>(`${await checkedPeerBase(session.operatorBUrl)}/peer/sessions/${sessionId}/join`, {
      session,
      signatureA: draft.signed.signatureA
    });
    if (!verifyProtocolObject(SIGNING_DOMAIN.SESSION, session, joined.signatureB, session.operatorB)) {
      throw new Error("INVALID_PEER_SESSION_SIGNATURE");
    }
    const signed = SignedSessionSchema.parse({ ...draft.signed, signatureB: joined.signatureB });
    const write = store.saveSession(signed, "ACTIVE");
    if (write === "CONFLICT") throw new Error("SESSION_ID_CONFLICT");
    store.setSessionStatus(sessionId, "ACTIVE");
    return store.getSession(sessionId)!.signed;
  }

  const createSession: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = z.object({
      peerUrl: z.string().url().optional(),
      expiresInSeconds: z.number().int().positive().max(86400).optional(),
      maxEvents: z.number().int().positive().max(10000).optional(),
      applicationProfile: z.enum(["generic-bilateral-v1", "paid-service-v1"]).optional(),
      chainContext: ChainContextSchema.optional()
    }).parse(req.body ?? {});
    const rawPeerUrl = body.peerUrl ?? options.defaultPeerUrl;
    if (!rawPeerUrl) return reply.code(400).send({ error: "PEER_URL_REQUIRED" });
    const peerUrl = await checkedPeerBase(rawPeerUrl);
    const identityResponse = await peerFetch(`${peerUrl}/identity`);
    if (!identityResponse.ok) return reply.code(502).send({ error: "PEER_IDENTITY_FAILED", status: identityResponse.status });
    const peer = z.object({
      publicKey: z.string().regex(/^0x[0-9a-f]{66}$/i),
      protocol: z.string(),
      selfUrl: z.string().url().optional(),
      applicationProfiles: z.array(ApplicationProfileSchema).optional()
    }).parse(await identityResponse.json());
    if (peer.protocol !== PROTOCOL) return reply.code(409).send({ error: "PEER_PROTOCOL_MISMATCH", peerProtocol: peer.protocol, protocol: PROTOCOL });

    const now = new Date();
    const applicationProfile = requestedProfile(body.applicationProfile);
    if (!peer.applicationProfiles?.some((candidate) =>
      candidate.id === applicationProfile.id
      && candidate.version === applicationProfile.version
      && candidate.rulesHash.toLowerCase() === applicationProfile.rulesHash.toLowerCase())) {
      return reply.code(409).send({ error: "PEER_APPLICATION_PROFILE_UNSUPPORTED", applicationProfile });
    }
    const session = SessionSchema.parse({
      sessionId: createSessionId(),
      protocol: PROTOCOL,
      applicationProfile,
      chainContext: body.chainContext ?? { ckbNetwork: "testnet", fiberNetwork: "fiber" },
      operatorA: identity.publicKey,
      operatorB: peer.publicKey,
      operatorAUrl: normalizedUrl(options.selfUrl),
      operatorBUrl: peerUrl,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (body.expiresInSeconds ?? 1800) * 1000).toISOString(),
      maxEvents: body.maxEvents ?? 100
    });
    const draft = SignedSessionSchema.parse({
      session,
      signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, session, identity.privateKey)
    });
    // Persist before contacting the peer. If the response is lost, the exact
    // session ID and signature can be retried instead of creating a new session.
    if (store.saveSession(draft, "CREATING") === "CONFLICT") return reply.code(409).send({ error: "SESSION_ID_CONFLICT" });
    try {
      const signed = await completeSessionJoin(session.sessionId);
      return reply.code(201).send(signed);
    } catch (error) {
      return reply.code(202).send({
        session: draft,
        status: "CREATING",
        retryable: true,
        retryPath: `/admin/sessions/${session.sessionId}/join/retry`,
        detail: String(error)
      });
    }
  };

  const retrySessionJoin: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const signed = await completeSessionJoin(req.params.id);
      return { session: signed, status: "ACTIVE" };
    } catch (error) {
      const message = String((error as Error).message);
      return reply.code(message === "SESSION_NOT_FOUND" ? 404 : 502).send({ error: message, retryable: true });
    }
  };

  const joinSession: Handler = async (req, reply) => {
    const input = z.object({ session: SessionSchema, signatureA: z.string() }).parse(req.body);
    if (input.session.sessionId !== req.params.id) return reply.code(400).send({ error: "SESSION_ID_MISMATCH" });
    try { supportedProfile(input.session.applicationProfile); }
    catch (error) { return reply.code(409).send({ error: String((error as Error).message) }); }
    if (input.session.operatorB !== identity.publicKey) return reply.code(403).send({ error: "NOT_INVITED_OPERATOR" });
    if (normalizedUrl(input.session.operatorBUrl) !== normalizedUrl(options.selfUrl)) return reply.code(400).send({ error: "OPERATOR_B_URL_MISMATCH" });
    try { await checkedPeerBase(input.session.operatorAUrl); }
    catch (error) { return reply.code(400).send({ error: "INVALID_OPERATOR_A_URL", detail: String(error) }); }
    if (!verifyProtocolObject(SIGNING_DOMAIN.SESSION, input.session, input.signatureA, input.session.operatorA)) {
      return reply.code(400).send({ error: "INVALID_OPERATOR_A_SIGNATURE" });
    }
    const signatureB = signProtocolObject(SIGNING_DOMAIN.SESSION, input.session, identity.privateKey);
    const signed = SignedSessionSchema.parse({ session: input.session, signatureA: input.signatureA, signatureB });
    const write = store.saveSession(signed);
    if (write === "CONFLICT") return reply.code(409).send({ error: "SESSION_ID_CONFLICT" });
    const stored = store.getSession(req.params.id)!;
    return { signatureB: stored.signed.signatureB, duplicate: write === "IDEMPOTENT", status: stored.status };
  };

  const proposeEvent: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const record = store.getSession(req.params.id);
    if (!record) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    try { assertSessionOpen(record.signed, record.status); assertSessionParticipant(record.signed); }
    catch (error) { return reply.code(409).send({ error: String((error as Error).message) }); }
    const body = z.object({ type: z.string().min(1).max(80), payload: z.unknown() }).parse(req.body);
    const events = store.listEvents(req.params.id);
    if (events.some((item) => item.status === "PROPOSED")) return reply.code(409).send({ error: "PENDING_EVENT_MUST_BE_ACKNOWLEDGED" });
    if (events.length >= record.signed.session.maxEvents) return reply.code(409).send({ error: "MAX_EVENTS_REACHED" });
    let payload: unknown;
    try { payload = normalizeProfilePayload(record.signed, events, body.type, body.payload); }
    catch (error) { return reply.code(409).send({ error: String((error as Error).message) }); }
    if (body.type === "PAYMENT_SETTLED") {
      const claim = FiberPaymentClaimSchema.safeParse(payload);
      if (!claim.success || claim.data.sessionId !== req.params.id) return reply.code(400).send({ error: "INVALID_FIBER_PAYMENT_CLAIM" });
    }
    const event = signEvent(EventBodySchema.parse({
      sessionId: req.params.id,
      sequence: events.length + 1,
      previousHash: events.length ? events[events.length - 1].event.eventHash : ZERO_HASH,
      type: body.type,
      payload,
      sender: identity.publicKey,
      createdAt: new Date().toISOString()
    }), identity.privateKey);
    try { validateProfileEvent(record.signed, event); }
    catch (error) { return reply.code(409).send({ error: String((error as Error).message) }); }
    const write = store.saveEvent(event);
    if (write === "CONFLICT") return reply.code(409).send({ error: "EVENT_CONFLICT" });
    const delivery = await queueAndDeliver({
      id: `event:${event.eventHash.toLowerCase()}`,
      sessionId: req.params.id,
      kind: "EVENT",
      path: `/peer/sessions/${req.params.id}/events`,
      body: { event }
    });
    return reply.code(delivery.status === "DELIVERED" ? 201 : 202).send({ ...event, delivery });
  };

  const retryEvent: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const session = store.getSession(req.params.id);
    const record = store.getEvent(req.params.eventHash);
    if (!session || !record) return reply.code(404).send({ error: "NOT_FOUND" });
    if (record.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
    if (record.event.sender !== identity.publicKey) return reply.code(403).send({ error: "ONLY_SENDER_CAN_RETRY_DELIVERY" });
    if (record.status !== "PROPOSED") return { delivered: true, status: record.status };
    const delivery = await queueAndDeliver({
      id: `event:${record.event.eventHash.toLowerCase()}`,
      sessionId: req.params.id,
      kind: "EVENT",
      path: `/peer/sessions/${req.params.id}/events`,
      body: { event: record.event }
    });
    return { delivered: delivery.status === "DELIVERED", eventHash: record.event.eventHash, delivery };
  };

  const receiveEvent: Handler = async (req, reply) => {
    const sessionRecord = store.getSession(req.params.id);
    if (!sessionRecord) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    const { event } = z.object({ event: SignedEventSchema }).parse(req.body);
    if (!verifyEvent(event)) return reply.code(400).send({ error: "INVALID_EVENT" });
    if (event.sessionId !== req.params.id) return reply.code(400).send({ error: "SESSION_ID_MISMATCH" });
    if (event.type === "PAYMENT_SETTLED") {
      const claim = FiberPaymentClaimSchema.safeParse(event.payload);
      if (!claim.success || claim.data.sessionId !== req.params.id) return reply.code(400).send({ error: "INVALID_FIBER_PAYMENT_CLAIM" });
    }
    const session = sessionRecord.signed.session;
    const expectedSender = identity.publicKey === session.operatorA ? session.operatorB : session.operatorA;
    if (event.sender !== expectedSender) return reply.code(403).send({ error: "WRONG_EVENT_SENDER" });
    const byHash = store.getEvent(event.eventHash);
    if (byHash) {
      if (byHash.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_HASH_CROSS_SESSION_CONFLICT" });
      return { accepted: true, duplicate: true };
    }
    const sameSequence = store.getEventBySequence(req.params.id, event.sequence);
    if (sameSequence && sameSequence.event.eventHash !== event.eventHash) {
      store.saveEvent(event);
      return reply.code(409).send({
        error: sameSequence.event.sender === event.sender ? "EVENT_EQUIVOCATION" : "PROPOSAL_COLLISION",
        canonicalEventHash: sameSequence.event.eventHash,
        incomingEventHash: event.eventHash
      });
    }
    try { assertSessionOpen(sessionRecord.signed, sessionRecord.status); assertSessionParticipant(sessionRecord.signed); }
    catch (error) { return reply.code(409).send({ error: String((error as Error).message) }); }
    const events = store.listEvents(req.params.id);
    try {
      validateProfileEvent(sessionRecord.signed, event);
      const normalizedPayload = normalizeProfilePayload(sessionRecord.signed, events, event.type, event.payload);
      if (canonical(normalizedPayload) !== canonical(event.payload)) throw new Error("APPLICATION_PROFILE_EVENT_BINDING_MISMATCH");
    } catch (error) {
      return reply.code(409).send({ error: String((error as Error).message) });
    }
    if (events.length >= session.maxEvents) return reply.code(409).send({ error: "MAX_EVENTS_REACHED" });
    const expectedSequence = events.length + 1;
    const expectedPrevious = events.length ? events[events.length - 1].event.eventHash : ZERO_HASH;
    if (event.sequence !== expectedSequence) return reply.code(409).send({ error: "BAD_SEQUENCE", expectedSequence });
    if (event.previousHash.toLowerCase() !== expectedPrevious.toLowerCase()) return reply.code(409).send({ error: "BAD_PREVIOUS_HASH", expectedPrevious });
    if (events.some((item) => item.status === "PROPOSED")) return reply.code(409).send({ error: "PENDING_EVENT_EXISTS" });
    const write = store.saveEvent(event);
    if (write === "CONFLICT") return reply.code(409).send({ error: "EVENT_CONFLICT" });
    return { accepted: true, duplicate: write === "IDEMPOTENT" };
  };

  const ackEvent: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const session = store.getSession(req.params.id);
    const record = store.getEvent(req.params.eventHash);
    if (!session || !record) return reply.code(404).send({ error: "NOT_FOUND" });
    if (record.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
    if (record.ack) {
      const paymentEvidence = paymentEvidenceForEvent(req.params.id, record.event.eventHash);
      const delivery = await queueAndDeliver({
        id: `ack:${record.ack.ackHash.toLowerCase()}`,
        sessionId: req.params.id,
        kind: "ACK",
        path: `/peer/sessions/${req.params.id}/acks`,
        body: { ack: record.ack, paymentEvidence }
      });
      return { ...record.ack, duplicate: true, delivery, ...(paymentEvidence ? { paymentEvidence } : {}) };
    }
    if (record.status !== "PROPOSED") return reply.code(409).send({ error: "EVENT_NOT_PENDING", status: record.status });
    if (record.event.sender === identity.publicKey) return reply.code(403).send({ error: "SENDER_CANNOT_ACK_OWN_EVENT" });
    const { decision } = z.object({ decision: z.enum(["ACCEPT", "REJECT"]).default("ACCEPT") }).parse(req.body ?? {});
    let paymentEvidence: SignedFiberPaymentEvidence | undefined;
    if (decision === "ACCEPT" && record.event.type === "PAYMENT_SETTLED") {
      const claim = FiberPaymentClaimSchema.safeParse(record.event.payload);
      if (!claim.success || claim.data.sessionId !== req.params.id) return reply.code(400).send({ error: "INVALID_FIBER_PAYMENT_CLAIM" });
      if (!options.fiber) return reply.code(503).send({ error: "FIBER_VERIFICATION_UNAVAILABLE" });
      const checked = await options.fiber.verifyReceivedPaymentClaim(claim.data);
      if (!checked.ok) return reply.code(409).send({ error: "FIBER_PAYMENT_VERIFICATION_FAILED", detail: checked.reason });
      if (store.claimPayment(req.params.id, claim.data, record.event.eventHash) === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_REUSE" });
      paymentEvidence = signFiberPaymentEvidence(checked.evidence, identity.publicKey, identity.privateKey);
      const evidenceWrite = store.savePaymentEvidence(req.params.id, record.event.eventHash, paymentEvidence);
      if (evidenceWrite === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_EVIDENCE_CONFLICT" });
      if (evidenceWrite === "IDEMPOTENT") paymentEvidence = paymentEvidenceForEvent(req.params.id, record.event.eventHash) ?? paymentEvidence;
    }
    const ack = signAck(AckBodySchema.parse({
      eventHash: record.event.eventHash,
      decision,
      operator: identity.publicKey,
      ...(paymentEvidence ? { evidenceHash: paymentEvidence.evidenceHash } : {}),
      createdAt: new Date().toISOString()
    }), identity.privateKey);
    if (store.saveAck(ack) === "CONFLICT") return reply.code(409).send({ error: "ACK_EQUIVOCATION" });
    const delivery = await queueAndDeliver({
      id: `ack:${ack.ackHash.toLowerCase()}`,
      sessionId: req.params.id,
      kind: "ACK",
      path: `/peer/sessions/${req.params.id}/acks`,
      body: { ack, paymentEvidence }
    });
    return reply.code(delivery.status === "DELIVERED" ? 200 : 202).send({ ...ack, delivery, ...(paymentEvidence ? { paymentEvidence } : {}) });
  };

  const receiveAck: Handler = async (req, reply) => {
    const session = store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    const { ack, paymentEvidence } = z.object({
      ack: SignedAckSchema,
      paymentEvidence: SignedFiberPaymentEvidenceSchema.optional()
    }).parse(req.body);
    if (!verifyAck(ack)) return reply.code(400).send({ error: "INVALID_ACK" });
    const event = store.getEvent(ack.eventHash);
    if (!event) return reply.code(404).send({ error: "EVENT_NOT_FOUND" });
    if (event.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
    const expectedAckOperator = event.event.sender === session.signed.session.operatorA
      ? session.signed.session.operatorB
      : session.signed.session.operatorA;
    if (ack.operator !== expectedAckOperator) return reply.code(403).send({ error: "WRONG_ACK_OPERATOR" });

    // Re-validate attached payment evidence even for a duplicate ACK. This lets
    // a retry repair the evidence side of a partially persisted legacy state.
    if (ack.decision === "ACCEPT" && event.event.type === "PAYMENT_SETTLED") {
      const claim = FiberPaymentClaimSchema.safeParse(event.event.payload);
      if (!claim.success) return reply.code(400).send({ error: "INVALID_FIBER_PAYMENT_CLAIM" });
      if (!paymentEvidence || canonical(paymentEvidence.evidence.claim) !== canonical(claim.data)) {
        return reply.code(409).send({ error: "FIBER_PAYMENT_EVIDENCE_REQUIRED_OR_MISMATCH" });
      }
      if (paymentEvidence.observer !== ack.operator || !verifyFiberPaymentEvidence(paymentEvidence)) {
        return reply.code(409).send({ error: "FIBER_PAYMENT_EVIDENCE_SIGNATURE_INVALID" });
      }
      if (supportedProfile(session.signed.session.applicationProfile) !== "legacy"
        && (!ack.evidenceHash || ack.evidenceHash.toLowerCase() !== paymentEvidence.evidenceHash.toLowerCase())) {
        return reply.code(409).send({ error: "ACK_PAYMENT_EVIDENCE_HASH_MISMATCH" });
      }
      if (store.claimPayment(req.params.id, claim.data, event.event.eventHash) === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_REUSE" });
      if (store.savePaymentEvidence(req.params.id, event.event.eventHash, paymentEvidence) === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_EVIDENCE_CONFLICT" });
    }
    const write = store.saveAck(ack);
    if (write === "CONFLICT") return reply.code(409).send({ error: "ACK_EQUIVOCATION", sessionStatus: "DISPUTED" });
    return { accepted: true, duplicate: write === "IDEMPOTENT" };
  };

  const closeSession: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const record = store.getSession(req.params.id);
    if (!record) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    if (identity.publicKey !== record.signed.session.operatorA) return reply.code(403).send({ error: "ONLY_OPERATOR_A_INITIATES_CLOSE" });
    if (record.close) return { close: record.close, anchor: record.anchor, duplicate: true };

    let proposal = record.closeProposal as z.infer<typeof SignedCloseSchema> | undefined;
    if (!proposal) {
      try { assertSessionOpen(record.signed, record.status); }
      catch (error) { return reply.code(409).send({ error: String((error as Error).message) }); }
      const events = store.listEvents(req.params.id);
      if (events.some((item) => item.status !== "FINAL" || !item.ack)) return reply.code(409).send({ error: "ALL_EVENTS_MUST_BE_FINAL" });
      if (events.some((item) => item.ack?.decision !== "ACCEPT")) return reply.code(409).send({ error: "REJECTED_EVENT_PREVENTS_CLOSE" });
      const input = z.object({ finalState: z.unknown().optional() }).parse(req.body ?? {});
      const finalItems = events.map((item) => ({ event: item.event, ack: item.ack! }));
      let finalState: unknown;
      let v3Fields: ReturnType<typeof commitmentV3Fields> | undefined;
      try {
        const profile = supportedProfile(record.signed.session.applicationProfile);
        finalState = profile === "legacy"
          ? (input.finalState ?? { status: "closed", eventCount: events.length })
          : deriveProfileFinalState(record.signed, events);
        if (profile !== "legacy") v3Fields = commitmentV3Fields(record.signed, events);
      } catch (error) {
        return reply.code(409).send({ error: String((error as Error).message) });
      }
      const close = CloseBodySchema.parse({
        ...(v3Fields ?? {}),
        sessionId: req.params.id,
        eventCount: events.length,
        transcriptRoot: computeTranscriptRoot(finalItems),
        finalStateHash: finalStateHashFrom(finalState),
        fiberPayments: acceptedFiberPaymentHashes(events),
        paymentEvidenceRoot: computePaymentEvidenceRoot(events),
        closedAt: new Date().toISOString()
      });
      proposal = SignedCloseSchema.parse({
        close,
        finalState,
        signatureA: signProtocolObject(SIGNING_DOMAIN.CLOSE, close, identity.privateKey)
      });
      if (store.saveCloseProposal(req.params.id, proposal) === "CONFLICT") return reply.code(409).send({ error: "CLOSE_EQUIVOCATION" });
    }

    if (!proposal.signatureA) return reply.code(500).send({ error: "LOCAL_CLOSE_SIGNATURE_MISSING" });
    const peerResult = await postPeer<{ signatureB: string }>(record.signed, `/peer/sessions/${req.params.id}/close`, {
      close: proposal.close,
      finalState: proposal.finalState,
      signatureA: proposal.signatureA
    });
    if (!verifyProtocolObject(SIGNING_DOMAIN.CLOSE, proposal.close, peerResult.signatureB, record.signed.session.operatorB)) {
      return reply.code(502).send({ error: "INVALID_PEER_CLOSE_SIGNATURE" });
    }
    const signedClose = SignedCloseSchema.parse({ ...proposal, signatureB: peerResult.signatureB });
    if (store.saveClose(req.params.id, signedClose) === "CONFLICT") return reply.code(409).send({ error: "CLOSE_EQUIVOCATION" });

    let anchor = store.getSession(req.params.id)?.anchor;
    if (options.autoAnchorOnClose && options.ckb && !anchor) {
      try { anchor = await createAndStoreAnchor(req.params.id); }
      catch (error) { app.log.warn({ error }, "Close succeeded but optional automatic CKB anchor failed"); }
    }
    return { close: signedClose, anchor };
  };

  const receiveClose: Handler = async (req, reply) => {
    const record = store.getSession(req.params.id);
    if (!record) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    if (identity.publicKey !== record.signed.session.operatorB) return reply.code(403).send({ error: "ONLY_OPERATOR_B_ACCEPTS_CLOSE" });
    const input = z.object({ close: CloseBodySchema, finalState: z.unknown(), signatureA: z.string() }).parse(req.body);
    if (input.close.sessionId !== req.params.id) return reply.code(400).send({ error: "CLOSE_SESSION_ID_MISMATCH" });
    if (!verifyProtocolObject(SIGNING_DOMAIN.CLOSE, input.close, input.signatureA, record.signed.session.operatorA)) {
      return reply.code(400).send({ error: "INVALID_CLOSE_SIGNATURE_A" });
    }
    if (record.close) {
      if (canonical(record.close.close) === canonical(input.close) && record.close.signatureA === input.signatureA && record.close.signatureB) {
        return { signatureB: record.close.signatureB, duplicate: true };
      }
      store.saveClose(req.params.id, { close: input.close, finalState: input.finalState, signatureA: input.signatureA });
      return reply.code(409).send({ error: "CLOSE_EQUIVOCATION", sessionStatus: "DISPUTED" });
    }
    if (record.status !== "ACTIVE") return reply.code(409).send({ error: "SESSION_NOT_ACTIVE", status: record.status });
    const events = store.listEvents(req.params.id);
    if (events.some((item) => item.status !== "FINAL" || !item.ack)) return reply.code(409).send({ error: "LOCAL_TRANSCRIPT_NOT_FINAL" });
    if (events.some((item) => item.ack?.decision !== "ACCEPT")) return reply.code(409).send({ error: "REJECTED_EVENT_PREVENTS_CLOSE" });
    let expectedFinalState: unknown = input.finalState;
    let expectedV3: ReturnType<typeof commitmentV3Fields> | undefined;
    try {
      const profile = supportedProfile(record.signed.session.applicationProfile);
      if (profile !== "legacy") {
        expectedFinalState = deriveProfileFinalState(record.signed, events);
        expectedV3 = commitmentV3Fields(record.signed, events);
        if (canonical(expectedFinalState) !== canonical(input.finalState)) {
          return reply.code(409).send({ error: "APPLICATION_FINAL_STATE_DERIVATION_MISMATCH", expectedFinalState });
        }
      }
    } catch (error) {
      return reply.code(409).send({ error: String((error as Error).message) });
    }
    if (finalStateHashFrom(expectedFinalState).toLowerCase() !== input.close.finalStateHash.toLowerCase()) return reply.code(409).send({ error: "FINAL_STATE_HASH_MISMATCH" });
    const finalItems = events.map((item) => ({ event: item.event, ack: item.ack! }));
    const localRoot = computeTranscriptRoot(finalItems);
    if (localRoot.toLowerCase() !== input.close.transcriptRoot.toLowerCase() || events.length !== input.close.eventCount) {
      return reply.code(409).send({ error: "TRANSCRIPT_MISMATCH", localRoot, localEventCount: events.length });
    }
    const localPayments = acceptedFiberPaymentHashes(events);
    if (canonical(localPayments) !== canonical([...new Set(input.close.fiberPayments.map((hash) => hash.toLowerCase()))].sort())) {
      return reply.code(409).send({ error: "FIBER_PAYMENT_SET_MISMATCH", localPayments });
    }
    const localPaymentEvidenceRoot = computePaymentEvidenceRoot(events);
    if (localPaymentEvidenceRoot.toLowerCase() !== input.close.paymentEvidenceRoot.toLowerCase()) {
      return reply.code(409).send({ error: "PAYMENT_EVIDENCE_ROOT_MISMATCH", localPaymentEvidenceRoot });
    }
    if (expectedV3) {
      if (input.close.commitmentVersion !== expectedV3.commitmentVersion
        || input.close.paymentObservationRoot?.toLowerCase() !== expectedV3.paymentObservationRoot.toLowerCase()
        || input.close.applicationProfileHash?.toLowerCase() !== expectedV3.applicationProfileHash.toLowerCase()
        || input.close.chainContextHash?.toLowerCase() !== expectedV3.chainContextHash.toLowerCase()) {
        return reply.code(409).send({ error: "CLOSE_V3_COMMITMENT_MISMATCH", expected: expectedV3 });
      }
    }
    const signatureB = signProtocolObject(SIGNING_DOMAIN.CLOSE, input.close, identity.privateKey);
    if (store.saveClose(req.params.id, { close: input.close, finalState: input.finalState, signatureA: input.signatureA, signatureB }) === "CONFLICT") {
      return reply.code(409).send({ error: "CLOSE_EQUIVOCATION", sessionStatus: "DISPUTED" });
    }
    return { signatureB };
  };

  const createAnchor: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!options.ckb) return reply.code(503).send({ error: "CKB_ANCHOR_DISABLED" });
    try {
      const existing = store.getSession(req.params.id)?.anchor;
      const anchor = await createAndStoreAnchor(req.params.id);
      return reply.code(existing ? 200 : 201).send({ anchor, duplicate: !!existing });
    } catch (error) {
      const message = String((error as Error).message);
      return reply.code(message.includes("NOT_FOUND") ? 404 : 409).send({ error: message });
    }
  };

  const receiveAnchor: Handler = async (req, reply) => {
    const record = store.getSession(req.params.id);
    if (!record?.close) return reply.code(409).send({ error: "CLOSE_REQUIRED_BEFORE_ANCHOR" });
    const { anchor } = z.object({
      anchor: z.object({
        txHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
        dataHex: z.string().regex(/^0x[0-9a-f]+$/i),
        status: z.enum(["PENDING", "COMMITTED", "CONFIRMED"]).optional(),
        blockHash: z.string().optional()
      })
    }).parse(req.body);
    const close = record.close.close;
    const expected = buildAnchorDataHex(
      req.params.id,
      close.transcriptRoot,
      close.finalStateHash,
      close.paymentEvidenceRoot,
      anchorExtensions(close)
    );
    if (anchor.dataHex.toLowerCase() !== expected.toLowerCase()) return reply.code(409).send({ error: "ANCHOR_COMMITMENT_MISMATCH" });
    if (!options.ckbRpcUrl) return reply.code(503).send({ error: "CKB_RPC_REQUIRED_TO_VERIFY_ANCHOR" });
    const verification = await inspectAnchorRpc(options.ckbRpcUrl, anchor.txHash, expected, ckbMinConfirmations);
    if (!verification.ok) {
      store.saveAnchor(req.params.id, { ...anchor, dataHex: expected, status: "PENDING" });
      return reply.code(202).send({
        accepted: false,
        pending: verification.status === "TX_NOT_COMMITTED" || verification.status === "COMMITTED_UNCONFIRMED",
        verification
      });
    }
    const committed = {
      ...anchor,
      dataHex: expected,
      status: (verification.status === "CONFIRMED" ? "CONFIRMED" : "COMMITTED") as "CONFIRMED" | "COMMITTED",
      blockHash: verification.blockHash,
      confirmations: verification.confirmations
    };
    if (store.saveAnchor(req.params.id, committed) === "CONFLICT") return reply.code(409).send({ error: "ANCHOR_CONFLICT", sessionStatus: "DISPUTED" });
    return { accepted: true, verification, anchor: committed };
  };

  const reconcileAnchorHandler: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const result = await reconcileAnchor(req.params.id);
      if (!result.committed) return reply.code(202).send(result);
      const delivery = await queueAndDeliver({
        id: `anchor:${result.anchor.txHash.toLowerCase()}`,
        sessionId: req.params.id,
        kind: "ANCHOR_NOTICE",
        path: `/peer/sessions/${req.params.id}/anchor`,
        body: { anchor: result.anchor }
      });
      return { ...result, peerDelivery: delivery };
    } catch (error) {
      const message = String((error as Error).message);
      return reply.code(message === "ANCHOR_NOT_FOUND" ? 404 : 409).send({ error: message });
    }
  };

  const retryAnchorPeer: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const record = store.getSession(req.params.id);
    if (!record?.anchor) return reply.code(404).send({ error: "ANCHOR_NOT_FOUND" });
    const delivery = await queueAndDeliver({
      id: `anchor:${String(record.anchor.txHash).toLowerCase()}`,
      sessionId: req.params.id,
      kind: "ANCHOR_NOTICE",
      path: `/peer/sessions/${req.params.id}/anchor`,
      body: { anchor: record.anchor }
    });
    return { delivered: delivery.status === "DELIVERED", delivery };
  };

  const newInvoice: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!options.fiber) return reply.code(503).send({ error: "FIBER_DISABLED" });
    const body = z.object({
      sessionId: z.string().min(1),
      amount: z.string(),
      currency: z.enum(["Fibb", "Fibt", "Fibd"]).optional(),
      description: z.string().optional(),
      obligationId: z.string().min(1).max(128).optional(),
      settlesEventHash: z.string().regex(/^0x[0-9a-f]{64}$/i).optional(),
      purposeHash: z.string().regex(/^0x[0-9a-f]{64}$/i).optional(),
      expectedPayeePublicKey: z.string().min(1).max(256).optional(),
      expirySeconds: z.number().int().positive().optional(),
      udtTypeScript: CkbScriptSchema.optional()
    }).parse(req.body);
    if (!store.getSession(body.sessionId)) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    return options.fiber.newInvoice(body);
  };

  const sendPayment: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!options.fiber) return reply.code(503).send({ error: "FIBER_DISABLED" });
    const { invoice } = z.object({ invoice: z.string().min(1) }).parse(req.body);
    return options.fiber.sendPayment(invoice);
  };

  const getPayment: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!options.fiber) return reply.code(503).send({ error: "FIBER_DISABLED" });
    return options.fiber.getPayment(req.params.hash);
  };

  const getInvoice: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!options.fiber) return reply.code(503).send({ error: "FIBER_DISABLED" });
    return options.fiber.getInvoice(req.params.hash);
  };

  // ---------- canonical v0.2 admin API ----------
  app.get("/admin/sessions", listSessions);
  app.get("/admin/sessions/:id", getSession);
  app.get("/admin/sessions/:id/transcript", getTranscript);
  app.get("/admin/sessions/:id/evidence-summary", getEvidenceSummary);
  app.get("/admin/outbox", listOutbox);
  app.post("/admin/outbox/drain", drainOutbox);
  app.post("/admin/sessions/:id/reconcile", serialized(reconcileSession));
  app.post("/admin/sessions", createSession);
  app.post("/admin/sessions/:id/join/retry", serialized(retrySessionJoin));
  app.post("/admin/sessions/:id/events", serialized(proposeEvent));
  app.post("/admin/sessions/:id/events/:eventHash/retry", serialized(retryEvent));
  app.post("/admin/sessions/:id/events/:eventHash/ack", serialized(ackEvent));
  app.post("/admin/sessions/:id/close", serialized(closeSession));
  app.post("/admin/sessions/:id/anchor", serialized(createAnchor));
  app.post("/admin/sessions/:id/anchor/reconcile", serialized(reconcileAnchorHandler));
  app.post("/admin/sessions/:id/anchor/retry-peer", serialized(retryAnchorPeer));
  app.post("/admin/fiber/new-invoice", newInvoice);
  app.post("/admin/fiber/send-payment", sendPayment);
  app.get("/admin/fiber/payments/:hash", getPayment);
  app.get("/admin/fiber/invoices/:hash", getInvoice);

  // ---------- canonical v0.2 peer API ----------
  app.get("/peer/sessions/:id/head", getPeerHead);
  app.post("/peer/sessions/:id/join", serialized(joinSession));
  app.post("/peer/sessions/:id/events", serialized(receiveEvent));
  app.post("/peer/sessions/:id/acks", serialized(receiveAck));
  app.post("/peer/sessions/:id/close", serialized(receiveClose));
  app.post("/peer/sessions/:id/anchor", serialized(receiveAnchor));

  // ---------- v0.1 compatibility aliases (deprecated) ----------
  app.get("/sessions", listSessions);
  app.get("/sessions/:id", getSession);
  app.get("/sessions/:id/transcript", getTranscript);
  app.post("/sessions", createSession);
  app.post("/sessions/:id/join/retry", serialized(retrySessionJoin));
  app.post("/sessions/:id/join", serialized(joinSession));
  app.post("/sessions/:id/events", serialized(proposeEvent));
  app.post("/sessions/:id/events/receive", serialized(receiveEvent));
  app.post("/sessions/:id/events/:eventHash/retry", serialized(retryEvent));
  app.post("/sessions/:id/events/:eventHash/ack", serialized(ackEvent));
  app.post("/sessions/:id/acks/receive", serialized(receiveAck));
  app.post("/sessions/:id/close", serialized(closeSession));
  app.post("/sessions/:id/close/receive", serialized(receiveClose));
  app.post("/sessions/:id/anchor", serialized(createAnchor));
  app.post("/sessions/:id/anchor/receive", serialized(receiveAnchor));
  app.post("/sessions/:id/anchor/reconcile", serialized(reconcileAnchorHandler));
  app.post("/sessions/:id/anchor/retry-peer", serialized(retryAnchorPeer));
  app.post("/fiber/new-invoice", newInvoice);
  app.post("/fiber/send-payment", sendPayment);
  app.get("/fiber/payments/:hash", getPayment);
  app.get("/fiber/invoices/:hash", getInvoice);

  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error);
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "INVALID_REQUEST", fields: error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
    }
    const status = Number((error as any).statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "REQUEST_FAILED" });
    }
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  return { app, store, identity };
}
