import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AckBodySchema,
  CkbScriptSchema,
  CloseBodySchema,
  EventBodySchema,
  FiberPaymentClaimSchema,
  FiberPaymentEvidenceSchema,
  PROTOCOL,
  SessionSchema,
  SignedAckSchema,
  SignedCloseSchema,
  SignedEventSchema,
  SignedSessionSchema,
  SIGNING_DOMAIN,
  ZERO_HASH,
  acceptedFiberPaymentHashes,
  buildAnchorDataHex,
  canonical,
  computePaymentEvidenceRoot,
  computeTranscriptRoot,
  createSessionId,
  finalStateHashFrom,
  signAck,
  signEvent,
  signProtocolObject,
  verifyAck,
  verifyEvent,
  verifyProtocolObject,
  type FiberPaymentEvidence,
  type SignedSession
} from "@eventmesh/core";
import { FiberRpcClient } from "@eventmesh/fiber";
import { CkbAnchorClient, inspectAnchorRpc } from "@eventmesh/ckb";
import { Store } from "./store.js";
import { loadIdentity } from "./identity.js";
import { adminTokenMatches, extractAdminToken, validatePeerUrl } from "./security.js";

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
  fiber?: FiberRpcClient;
  ckb?: CkbAnchorClient;
  ckbRpcUrl?: string;
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
  if (publicMode && !options.adminToken) throw new Error("PUBLIC_MODE_REQUIRES_ADMIN_TOKEN");
  if (publicMode && !options.selfUrl.startsWith("https://")) throw new Error("PUBLIC_MODE_REQUIRES_HTTPS_SELF_URL");

  mkdirSync(options.dataDir, { recursive: true });
  const identity = loadIdentity(options.dataDir, options.operatorPrivateKey);
  const store = new Store(join(options.dataDir, "eventmesh.db"));
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const corsOrigins = new Set(options.corsOrigins ?? ["http://localhost:3000"]);

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      callback(null, corsOrigins.has(origin));
    },
    methods: ["GET", "POST"]
  });

  app.addHook("onClose", async () => store.close());

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

  async function peerFetch(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    await checkedPeerBase(`${parsed.protocol}//${parsed.host}`);
    return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs) });
  }

  async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await peerFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Peer ${response.status}: ${text}`);
    return text ? JSON.parse(text) as T : ({} as T);
  }

  function peerUrlFor(session: SignedSession): string {
    return session.session.operatorA === identity.publicKey ? session.session.operatorBUrl : session.session.operatorAUrl;
  }

  async function postPeer<T>(session: SignedSession, path: string, body: unknown): Promise<T> {
    const base = await checkedPeerBase(peerUrlFor(session));
    return postJson<T>(`${base}${path}`, body);
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

  function paymentEvidenceForEvent(sessionId: string, eventHash: string): FiberPaymentEvidence | undefined {
    const event = store.getEvent(eventHash)?.event;
    if (!event || event.type !== "PAYMENT_SETTLED") return undefined;
    const claim = FiberPaymentClaimSchema.safeParse(event.payload);
    if (!claim.success) return undefined;
    return store.listPaymentEvidence(sessionId)
      .find((evidence) => evidence.claim.paymentHash.toLowerCase() === claim.data.paymentHash.toLowerCase());
  }

  async function createAndStoreAnchor(sessionId: string) {
    if (!options.ckb) throw new Error("CKB_ANCHOR_DISABLED");
    const record = store.getSession(sessionId);
    if (!record?.close) throw new Error("CLOSE_REQUIRED_BEFORE_ANCHOR");
    if (record.anchor) return record.anchor;
    const close = record.close.close;
    const anchor = await options.ckb.anchor({
      sessionId,
      transcriptRoot: close.transcriptRoot,
      finalStateHash: close.finalStateHash,
      paymentEvidenceRoot: close.paymentEvidenceRoot
    });
    const write = store.saveAnchor(sessionId, anchor);
    if (write === "CONFLICT") throw new Error("ANCHOR_CONFLICT");
    return anchor;
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
      close.paymentEvidenceRoot
    );
    const verification = await inspectAnchorRpc(options.ckbRpcUrl, record.anchor.txHash, expected);
    if (!verification.ok) {
      store.saveAnchor(sessionId, { ...record.anchor, dataHex: expected, status: "PENDING" });
      return { committed: false as const, verification };
    }
    const committed = {
      ...record.anchor,
      dataHex: expected,
      status: "COMMITTED" as const,
      blockHash: verification.blockHash
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
    ckbVerificationEnabled: !!options.ckbRpcUrl
  }));
  app.get("/identity", async () => ({
    name: options.name,
    publicKey: identity.publicKey,
    selfUrl: options.selfUrl,
    protocol: PROTOCOL,
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

  const createSession: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = z.object({
      peerUrl: z.string().url().optional(),
      expiresInSeconds: z.number().int().positive().max(86400).optional(),
      maxEvents: z.number().int().positive().max(10000).optional()
    }).parse(req.body ?? {});
    const rawPeerUrl = body.peerUrl ?? options.defaultPeerUrl;
    if (!rawPeerUrl) return reply.code(400).send({ error: "PEER_URL_REQUIRED" });
    const peerUrl = await checkedPeerBase(rawPeerUrl);
    const identityResponse = await peerFetch(`${peerUrl}/identity`);
    if (!identityResponse.ok) return reply.code(502).send({ error: "PEER_IDENTITY_FAILED", status: identityResponse.status });
    const peer = z.object({
      publicKey: z.string().regex(/^0x[0-9a-f]{66}$/i),
      protocol: z.string(),
      selfUrl: z.string().url().optional()
    }).parse(await identityResponse.json());
    if (peer.protocol !== PROTOCOL) return reply.code(409).send({ error: "PEER_PROTOCOL_MISMATCH", peerProtocol: peer.protocol, protocol: PROTOCOL });

    const now = new Date();
    const session = SessionSchema.parse({
      sessionId: createSessionId(),
      protocol: PROTOCOL,
      operatorA: identity.publicKey,
      operatorB: peer.publicKey,
      operatorAUrl: normalizedUrl(options.selfUrl),
      operatorBUrl: peerUrl,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (body.expiresInSeconds ?? 1800) * 1000).toISOString(),
      maxEvents: body.maxEvents ?? 100
    });
    const signatureA = signProtocolObject(SIGNING_DOMAIN.SESSION, session, identity.privateKey);
    const joined = await postJson<{ signatureB: string }>(`${peerUrl}/peer/sessions/${session.sessionId}/join`, { session, signatureA });
    if (!verifyProtocolObject(SIGNING_DOMAIN.SESSION, session, joined.signatureB, session.operatorB)) {
      return reply.code(502).send({ error: "INVALID_PEER_SESSION_SIGNATURE" });
    }
    const signed = SignedSessionSchema.parse({ session, signatureA, signatureB: joined.signatureB });
    const write = store.saveSession(signed);
    if (write === "CONFLICT") return reply.code(409).send({ error: "SESSION_ID_CONFLICT" });
    return reply.code(201).send(signed);
  };

  const joinSession: Handler = async (req, reply) => {
    const input = z.object({ session: SessionSchema, signatureA: z.string() }).parse(req.body);
    if (input.session.sessionId !== req.params.id) return reply.code(400).send({ error: "SESSION_ID_MISMATCH" });
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
    if (body.type === "PAYMENT_SETTLED") {
      const claim = FiberPaymentClaimSchema.safeParse(body.payload);
      if (!claim.success || claim.data.sessionId !== req.params.id) return reply.code(400).send({ error: "INVALID_FIBER_PAYMENT_CLAIM" });
    }
    const events = store.listEvents(req.params.id);
    if (events.some((item) => item.status === "PROPOSED")) return reply.code(409).send({ error: "PENDING_EVENT_MUST_BE_ACKNOWLEDGED" });
    if (events.length >= record.signed.session.maxEvents) return reply.code(409).send({ error: "MAX_EVENTS_REACHED" });
    const event = signEvent(EventBodySchema.parse({
      sessionId: req.params.id,
      sequence: events.length + 1,
      previousHash: events.length ? events[events.length - 1].event.eventHash : ZERO_HASH,
      type: body.type,
      payload: body.payload,
      sender: identity.publicKey,
      createdAt: new Date().toISOString()
    }), identity.privateKey);
    const write = store.saveEvent(event);
    if (write === "CONFLICT") return reply.code(409).send({ error: "EVENT_CONFLICT" });
    try {
      await postPeer(record.signed, `/peer/sessions/${req.params.id}/events`, { event });
    } catch (error) {
      return reply.code(502).send({ error: "PEER_DELIVERY_FAILED", detail: String(error), event });
    }
    return reply.code(201).send(event);
  };

  const retryEvent: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const session = store.getSession(req.params.id);
    const record = store.getEvent(req.params.eventHash);
    if (!session || !record) return reply.code(404).send({ error: "NOT_FOUND" });
    if (record.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
    if (record.event.sender !== identity.publicKey) return reply.code(403).send({ error: "ONLY_SENDER_CAN_RETRY_DELIVERY" });
    if (record.status !== "PROPOSED") return { delivered: true, status: record.status };
    await postPeer(session.signed, `/peer/sessions/${req.params.id}/events`, { event: record.event });
    return { delivered: true, eventHash: record.event.eventHash };
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
      try { await postPeer(session.signed, `/peer/sessions/${req.params.id}/acks`, { ack: record.ack, paymentEvidence }); }
      catch (error) { return reply.code(502).send({ error: "ACK_REDELIVERY_FAILED", detail: String(error), ack: record.ack }); }
      return { ...record.ack, duplicate: true, ...(paymentEvidence ? { paymentEvidence } : {}) };
    }
    if (record.status !== "PROPOSED") return reply.code(409).send({ error: "EVENT_NOT_PENDING", status: record.status });
    if (record.event.sender === identity.publicKey) return reply.code(403).send({ error: "SENDER_CANNOT_ACK_OWN_EVENT" });
    const { decision } = z.object({ decision: z.enum(["ACCEPT", "REJECT"]).default("ACCEPT") }).parse(req.body ?? {});
    let paymentEvidence: FiberPaymentEvidence | undefined;
    if (decision === "ACCEPT" && record.event.type === "PAYMENT_SETTLED") {
      const claim = FiberPaymentClaimSchema.safeParse(record.event.payload);
      if (!claim.success || claim.data.sessionId !== req.params.id) return reply.code(400).send({ error: "INVALID_FIBER_PAYMENT_CLAIM" });
      if (!options.fiber) return reply.code(503).send({ error: "FIBER_VERIFICATION_UNAVAILABLE" });
      const checked = await options.fiber.verifyReceivedPaymentClaim(claim.data);
      if (!checked.ok) return reply.code(409).send({ error: "FIBER_PAYMENT_VERIFICATION_FAILED", detail: checked.reason });
      if (store.claimPayment(req.params.id, claim.data, record.event.eventHash) === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_REUSE" });
      if (store.savePaymentEvidence(req.params.id, record.event.eventHash, checked.evidence) === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_EVIDENCE_CONFLICT" });
      paymentEvidence = checked.evidence;
    }
    const ack = signAck(AckBodySchema.parse({
      eventHash: record.event.eventHash,
      decision,
      operator: identity.publicKey,
      createdAt: new Date().toISOString()
    }), identity.privateKey);
    if (store.saveAck(ack) === "CONFLICT") return reply.code(409).send({ error: "ACK_EQUIVOCATION" });
    try {
      await postPeer(session.signed, `/peer/sessions/${req.params.id}/acks`, { ack, paymentEvidence });
    } catch (error) {
      return reply.code(502).send({ error: "ACK_DELIVERY_FAILED", detail: String(error), ack, paymentEvidence });
    }
    return { ...ack, ...(paymentEvidence ? { paymentEvidence } : {}) };
  };

  const receiveAck: Handler = async (req, reply) => {
    const session = store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    const { ack, paymentEvidence } = z.object({
      ack: SignedAckSchema,
      paymentEvidence: FiberPaymentEvidenceSchema.optional()
    }).parse(req.body);
    if (!verifyAck(ack)) return reply.code(400).send({ error: "INVALID_ACK" });
    const event = store.getEvent(ack.eventHash);
    if (!event) return reply.code(404).send({ error: "EVENT_NOT_FOUND" });
    if (event.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
    const expectedAckOperator = event.event.sender === session.signed.session.operatorA
      ? session.signed.session.operatorB
      : session.signed.session.operatorA;
    if (ack.operator !== expectedAckOperator) return reply.code(403).send({ error: "WRONG_ACK_OPERATOR" });
    if (event.ack?.ackHash === ack.ackHash) return { accepted: true, duplicate: true };

    if (ack.decision === "ACCEPT" && event.event.type === "PAYMENT_SETTLED") {
      const claim = FiberPaymentClaimSchema.safeParse(event.event.payload);
      if (!claim.success) return reply.code(400).send({ error: "INVALID_FIBER_PAYMENT_CLAIM" });
      if (!paymentEvidence || canonical(paymentEvidence.claim) !== canonical(claim.data)) {
        return reply.code(409).send({ error: "FIBER_PAYMENT_EVIDENCE_REQUIRED_OR_MISMATCH" });
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
      const finalState = input.finalState ?? { status: "closed", eventCount: events.length };
      const finalItems = events.map((item) => ({ event: item.event, ack: item.ack! }));
      const close = CloseBodySchema.parse({
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
    if (finalStateHashFrom(input.finalState).toLowerCase() !== input.close.finalStateHash.toLowerCase()) return reply.code(409).send({ error: "FINAL_STATE_HASH_MISMATCH" });
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
        status: z.enum(["PENDING", "COMMITTED"]).optional(),
        blockHash: z.string().optional()
      })
    }).parse(req.body);
    const close = record.close.close;
    const expected = buildAnchorDataHex(req.params.id, close.transcriptRoot, close.finalStateHash, close.paymentEvidenceRoot);
    if (anchor.dataHex.toLowerCase() !== expected.toLowerCase()) return reply.code(409).send({ error: "ANCHOR_COMMITMENT_MISMATCH" });
    if (!options.ckbRpcUrl) return reply.code(503).send({ error: "CKB_RPC_REQUIRED_TO_VERIFY_ANCHOR" });
    const verification = await inspectAnchorRpc(options.ckbRpcUrl, anchor.txHash, expected);
    if (!verification.ok) {
      store.saveAnchor(req.params.id, { ...anchor, dataHex: expected, status: "PENDING" });
      return reply.code(202).send({ accepted: false, pending: verification.status === "TX_NOT_COMMITTED", verification });
    }
    const committed = { ...anchor, dataHex: expected, status: "COMMITTED" as const, blockHash: verification.blockHash };
    if (store.saveAnchor(req.params.id, committed) === "CONFLICT") return reply.code(409).send({ error: "ANCHOR_CONFLICT", sessionStatus: "DISPUTED" });
    return { accepted: true, verification, anchor: committed };
  };

  const reconcileAnchorHandler: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const result = await reconcileAnchor(req.params.id);
      if (!result.committed) return reply.code(202).send(result);
      const record = store.getSession(req.params.id)!;
      try { await postPeer(record.signed, `/peer/sessions/${req.params.id}/anchor`, { anchor: result.anchor }); }
      catch (error) { app.log.warn({ error }, "Anchor committed locally but peer notification retry failed"); }
      return result;
    } catch (error) {
      const message = String((error as Error).message);
      return reply.code(message === "ANCHOR_NOT_FOUND" ? 404 : 409).send({ error: message });
    }
  };

  const retryAnchorPeer: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const record = store.getSession(req.params.id);
    if (!record?.anchor) return reply.code(404).send({ error: "ANCHOR_NOT_FOUND" });
    const peer = await postPeer(record.signed, `/peer/sessions/${req.params.id}/anchor`, { anchor: record.anchor });
    return { delivered: true, peer };
  };

  const newInvoice: Handler = async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!options.fiber) return reply.code(503).send({ error: "FIBER_DISABLED" });
    const body = z.object({
      sessionId: z.string().min(1),
      amount: z.string(),
      currency: z.enum(["Fibb", "Fibt", "Fibd"]).optional(),
      description: z.string().optional(),
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
  app.post("/admin/sessions", createSession);
  app.post("/admin/sessions/:id/events", proposeEvent);
  app.post("/admin/sessions/:id/events/:eventHash/retry", retryEvent);
  app.post("/admin/sessions/:id/events/:eventHash/ack", ackEvent);
  app.post("/admin/sessions/:id/close", closeSession);
  app.post("/admin/sessions/:id/anchor", createAnchor);
  app.post("/admin/sessions/:id/anchor/reconcile", reconcileAnchorHandler);
  app.post("/admin/sessions/:id/anchor/retry-peer", retryAnchorPeer);
  app.post("/admin/fiber/new-invoice", newInvoice);
  app.post("/admin/fiber/send-payment", sendPayment);
  app.get("/admin/fiber/payments/:hash", getPayment);
  app.get("/admin/fiber/invoices/:hash", getInvoice);

  // ---------- canonical v0.2 peer API ----------
  app.post("/peer/sessions/:id/join", joinSession);
  app.post("/peer/sessions/:id/events", receiveEvent);
  app.post("/peer/sessions/:id/acks", receiveAck);
  app.post("/peer/sessions/:id/close", receiveClose);
  app.post("/peer/sessions/:id/anchor", receiveAnchor);

  // ---------- v0.1 compatibility aliases (deprecated) ----------
  app.get("/sessions", listSessions);
  app.get("/sessions/:id", getSession);
  app.get("/sessions/:id/transcript", getTranscript);
  app.post("/sessions", createSession);
  app.post("/sessions/:id/join", joinSession);
  app.post("/sessions/:id/events", proposeEvent);
  app.post("/sessions/:id/events/receive", receiveEvent);
  app.post("/sessions/:id/events/:eventHash/retry", retryEvent);
  app.post("/sessions/:id/events/:eventHash/ack", ackEvent);
  app.post("/sessions/:id/acks/receive", receiveAck);
  app.post("/sessions/:id/close", closeSession);
  app.post("/sessions/:id/close/receive", receiveClose);
  app.post("/sessions/:id/anchor", createAnchor);
  app.post("/sessions/:id/anchor/receive", receiveAnchor);
  app.post("/sessions/:id/anchor/reconcile", reconcileAnchorHandler);
  app.post("/sessions/:id/anchor/retry-peer", retryAnchorPeer);
  app.post("/fiber/new-invoice", newInvoice);
  app.post("/fiber/send-payment", sendPayment);
  app.get("/fiber/payments/:hash", getPayment);
  app.get("/fiber/invoices/:hash", getInvoice);

  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error);
    reply.code((error as any).statusCode ?? 400).send({ error: "REQUEST_FAILED", detail: error.message });
  });

  return { app, store, identity };
}
