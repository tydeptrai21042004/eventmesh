import Fastify from "fastify";
import cors from "@fastify/cors";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AckBodySchema,
  CloseBodySchema,
  EventBodySchema,
  PROTOCOL,
  SessionSchema,
  SignedAckSchema,
  SignedCloseSchema,
  SignedEventSchema,
  SignedSessionSchema,
  ZERO_HASH,
  computeTranscriptRoot,
  createSessionId,
  finalStateHashFrom,
  signAck,
  signEvent,
  SIGNING_DOMAIN,
  signProtocolObject,
  verifyAck,
  verifyEvent,
  verifyProtocolObject,
  FiberPaymentClaimSchema,
  acceptedFiberPaymentHashes,
  buildAnchorDataHex,
  type SignedSession
} from "@eventmesh/core";
import { FiberRpcClient } from "@eventmesh/fiber";
import { CkbAnchorClient, inspectAnchorRpc } from "@eventmesh/ckb";
import { z } from "zod";
import { Store } from "./store.js";
import { loadIdentity } from "./identity.js";
import { corsOriginPolicy, makeAdminGuard, validatePeerUrl } from "./security.js";

const name = process.env.OPERATOR_NAME ?? "operator";
const port = Number(process.env.PORT ?? 4000);
const selfUrl = process.env.SELF_URL ?? `http://localhost:${port}`;
const defaultPeerUrl = process.env.DEFAULT_PEER_URL;
const publicMode = process.env.PUBLIC_MODE === "true";
const adminToken = process.env.ADMIN_TOKEN || undefined;
if (publicMode && !adminToken) throw new Error("ADMIN_TOKEN is required when PUBLIC_MODE=true");
if (publicMode && !selfUrl.startsWith("https://")) throw new Error("SELF_URL must be HTTPS in PUBLIC_MODE");
const allowPrivatePeerUrls = !publicMode && process.env.ALLOW_PRIVATE_PEER_URLS !== "false";
const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",");
const dataDir = process.env.DATA_DIR ?? `.data/${name}`;
mkdirSync(dataDir, { recursive: true });
const identity = loadIdentity(dataDir, process.env.OPERATOR_PRIVATE_KEY);
const store = new Store(join(dataDir, "eventmesh.db"));
const app = Fastify({ logger: true });
await app.register(cors, { origin: corsOriginPolicy(corsOrigins) });
const adminGuard = makeAdminGuard(adminToken);

const fiberEnabled = process.env.FIBER_ENABLED === "true" && !!process.env.FIBER_RPC_URL;
const fiber = fiberEnabled ? new FiberRpcClient(process.env.FIBER_RPC_URL!, process.env.FIBER_RPC_TOKEN || undefined) : undefined;
const ckbRpcUrl = process.env.CKB_RPC_URL || undefined;
const ckbEnabled = process.env.CKB_ENABLED === "true" && !!process.env.CKB_PRIVATE_KEY;
const ckb = ckbEnabled ? new CkbAnchorClient(process.env.CKB_PRIVATE_KEY!, ckbRpcUrl, Number(process.env.CKB_ANCHOR_CAPACITY_CKB ?? 200)) : undefined;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Peer ${response.status}: ${text}`);
  return text ? JSON.parse(text) as T : ({} as T);
}

function peerUrlFor(session: SignedSession): string {
  return session.session.operatorA === identity.publicKey ? session.session.operatorBUrl : session.session.operatorAUrl;
}
async function checkedPeerUrl(raw: string) { return (await validatePeerUrl(raw, { allowPrivate: allowPrivatePeerUrls, requireHttps: publicMode })).toString().replace(/\/+$/, ""); }
async function postPeer<T>(session: SignedSession, path: string, body: unknown): Promise<T> { const base = await checkedPeerUrl(peerUrlFor(session)); return postJson<T>(`${base}${path}`, body); }

function assertSessionParticipant(session: SignedSession) {
  if (identity.publicKey !== session.session.operatorA && identity.publicKey !== session.session.operatorB) throw new Error("Local operator is not a participant");
}

function assertSessionOpen(session: SignedSession, status: string) {
  if (status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
  if (Date.now() >= new Date(session.session.expiresAt).getTime()) throw new Error("SESSION_EXPIRED");
}

app.get("/health", async () => ({ status: "ok", name, protocol: PROTOCOL, publicKey: identity.publicKey, fiberEnabled, ckbEnabled }));
app.get("/identity", async () => ({ name, publicKey: identity.publicKey, selfUrl }));
app.get("/sessions", { preHandler: adminGuard }, async () => store.listSessions());
app.get("/sessions/:id", { preHandler: adminGuard }, async (req: any, reply) => {
  const record = store.getSession(req.params.id);
  if (!record) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  return { ...record, events: store.listEvents(req.params.id) };
});
app.get("/sessions/:id/transcript", { preHandler: adminGuard }, async (req: any, reply) => {
  const transcript = store.exportTranscript(req.params.id);
  if (!transcript) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  return transcript;
});

app.post("/sessions", { preHandler: adminGuard }, async (req: any, reply) => {
  const body = z.object({ peerUrl: z.string().url().optional(), expiresInSeconds: z.number().int().positive().max(86400).optional(), maxEvents: z.number().int().positive().max(10000).optional() }).parse(req.body ?? {});
  const peerUrl = body.peerUrl ?? defaultPeerUrl;
  if (!peerUrl) return reply.code(400).send({ error: "PEER_URL_REQUIRED" });
  const peer = await (await fetch(`${peerUrl}/identity`)).json() as any;
  const now = new Date();
  const session = SessionSchema.parse({
    sessionId: createSessionId(),
    protocol: PROTOCOL,
    operatorA: identity.publicKey,
    operatorB: peer.publicKey,
    operatorAUrl: selfUrl,
    operatorBUrl: peerUrl,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (body.expiresInSeconds ?? 1800) * 1000).toISOString(),
    maxEvents: body.maxEvents ?? 100
  });
  const signatureA = signProtocolObject(SIGNING_DOMAIN.SESSION, session, identity.privateKey);
  const joined = await postJson<{ signatureB: string }>(`${peerUrl}/sessions/${session.sessionId}/join`, { session, signatureA });
  const signed: SignedSession = SignedSessionSchema.parse({ session, signatureA, signatureB: joined.signatureB });
  const savedSession = store.saveSession(signed);
  if (savedSession === "CONFLICT") return reply.code(409).send({ error: "SESSION_ID_CONFLICT" });
  return reply.code(201).send(signed);
});

app.post("/sessions/:id/join", async (req: any, reply) => {
  const input = z.object({ session: SessionSchema, signatureA: z.string() }).parse(req.body);
  if (input.session.sessionId !== req.params.id) return reply.code(400).send({ error: "SESSION_ID_MISMATCH" });
  if (input.session.operatorB !== identity.publicKey) return reply.code(403).send({ error: "NOT_INVITED_OPERATOR" });
  if (!verifyProtocolObject(SIGNING_DOMAIN.SESSION, input.session, input.signatureA, input.session.operatorA)) return reply.code(400).send({ error: "INVALID_OPERATOR_A_SIGNATURE" });
  const signatureB = signProtocolObject(SIGNING_DOMAIN.SESSION, input.session, identity.privateKey);
  store.saveSession({ session: input.session, signatureA: input.signatureA, signatureB });
  return { signatureB };
});

app.post("/sessions/:id/events", { preHandler: adminGuard }, async (req: any, reply) => {
  const sessionRecord = store.getSession(req.params.id);
  if (!sessionRecord) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  try { assertSessionOpen(sessionRecord.signed, sessionRecord.status); } catch (e) { return reply.code(409).send({ error: String((e as Error).message) }); }
  assertSessionParticipant(sessionRecord.signed);
  const body = z.object({ type: z.string().min(1), payload: z.unknown() }).parse(req.body);
  const current = store.listEvents(req.params.id);
  if (current.some((x) => x.status === "PROPOSED")) return reply.code(409).send({ error: "PENDING_EVENT_MUST_BE_ACKNOWLEDGED" });
  if (current.length >= sessionRecord.signed.session.maxEvents) return reply.code(409).send({ error: "MAX_EVENTS_REACHED" });
  const previousHash = current.length ? current[current.length - 1].event.eventHash : ZERO_HASH;
  const event = signEvent(EventBodySchema.parse({
    sessionId: req.params.id,
    sequence: current.length + 1,
    previousHash,
    type: body.type,
    payload: body.payload,
    sender: identity.publicKey,
    createdAt: new Date().toISOString()
  }), identity.privateKey);
  const eventSaved = store.saveEvent(event);
  if (eventSaved === "CONFLICT") return reply.code(409).send({ error: "EVENT_CONFLICT" });
  try {
    await postJson(`${peerUrlFor(sessionRecord.signed)}/sessions/${req.params.id}/events/receive`, { event });
  } catch (error) {
    return reply.code(502).send({ error: "PEER_DELIVERY_FAILED", detail: String(error), event });
  }
  return reply.code(201).send(event);
});

app.post("/sessions/:id/events/:eventHash/retry", { preHandler: adminGuard }, async (req: any, reply) => {
  const sessionRecord = store.getSession(req.params.id);
  const record = store.getEvent(req.params.eventHash);
  if (!sessionRecord || !record) return reply.code(404).send({ error: "NOT_FOUND" });
  if (record.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
  if (record.event.sender !== identity.publicKey) return reply.code(403).send({ error: "ONLY_SENDER_CAN_RETRY_DELIVERY" });
  if (record.status !== "PROPOSED") return { delivered: true, status: record.status };
  await postJson(`${peerUrlFor(sessionRecord.signed)}/sessions/${req.params.id}/events/receive`, { event: record.event });
  return { delivered: true, eventHash: record.event.eventHash };
});

app.post("/sessions/:id/events/receive", async (req: any, reply) => {
  const sessionRecord = store.getSession(req.params.id);
  if (!sessionRecord) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  try { assertSessionOpen(sessionRecord.signed, sessionRecord.status); } catch (e) { return reply.code(409).send({ error: String((e as Error).message) }); }
  const { event } = z.object({ event: SignedEventSchema }).parse(req.body);
  if (!verifyEvent(event)) return reply.code(400).send({ error: "INVALID_EVENT" });
  if (event.sessionId !== req.params.id) return reply.code(400).send({ error: "SESSION_ID_MISMATCH" });
  const expectedSender = identity.publicKey === sessionRecord.signed.session.operatorA ? sessionRecord.signed.session.operatorB : sessionRecord.signed.session.operatorA;
  if (event.sender !== expectedSender) return reply.code(403).send({ error: "WRONG_EVENT_SENDER" });
  const current = store.listEvents(req.params.id);
  if (store.getEvent(event.eventHash)) return { accepted: true, duplicate: true };
  if (current.length >= sessionRecord.signed.session.maxEvents) return reply.code(409).send({ error: "MAX_EVENTS_REACHED" });
  const expectedSequence = current.length + 1;
  const expectedPrevious = current.length ? current[current.length - 1].event.eventHash : ZERO_HASH;
  if (event.sequence !== expectedSequence) return reply.code(409).send({ error: "BAD_SEQUENCE", expectedSequence });
  if (event.previousHash !== expectedPrevious) return reply.code(409).send({ error: "BAD_PREVIOUS_HASH", expectedPrevious });
  if (current.some((x) => x.status === "PROPOSED")) return reply.code(409).send({ error: "PENDING_EVENT_EXISTS" });
  const savedEvent = store.saveEvent(event);
  if (savedEvent === "CONFLICT") return reply.code(409).send({ error: "EVENT_EQUIVOCATION" });
  return { accepted: true };
});

app.post("/sessions/:id/events/:eventHash/ack", { preHandler: adminGuard }, async (req: any, reply) => {
  const sessionRecord = store.getSession(req.params.id);
  const record = store.getEvent(req.params.eventHash);
  if (!sessionRecord || !record) return reply.code(404).send({ error: "NOT_FOUND" });
  if (record.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
  if (record.ack) {
    await postJson(`${peerUrlFor(sessionRecord.signed)}/sessions/${req.params.id}/acks/receive`, { ack: record.ack });
    return { ...record.ack, duplicate: true };
  }
  if (record.status !== "PROPOSED") return reply.code(409).send({ error: "EVENT_NOT_PENDING", status: record.status });
  if (record.event.sender === identity.publicKey) return reply.code(403).send({ error: "SENDER_CANNOT_ACK_OWN_EVENT" });
  const { decision } = z.object({ decision: z.enum(["ACCEPT", "REJECT"]).default("ACCEPT") }).parse(req.body ?? {});
  if (decision === "ACCEPT" && record.event.type === "PAYMENT_SETTLED") {
    const claim = FiberPaymentClaimSchema.safeParse(record.event.payload);
    if (!claim.success || claim.data.sessionId !== req.params.id) return reply.code(400).send({ error: "INVALID_PAYMENT_CLAIM" });
    if (!fiber) return reply.code(503).send({ error: "FIBER_VERIFICATION_UNAVAILABLE" });
    const checked = await fiber.verifyReceivedPaymentClaim(claim.data);
    if (!checked.ok) return reply.code(409).send({ error: "FIBER_PAYMENT_VERIFICATION_FAILED", detail: checked.reason });
    if (store.claimPayment(req.params.id, claim.data, record.event.eventHash) === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_REUSE" });
  }
  const ack = signAck(AckBodySchema.parse({ eventHash: record.event.eventHash, decision, operator: identity.publicKey, createdAt: new Date().toISOString() }), identity.privateKey);
  if (store.saveAck(ack) === "CONFLICT") return reply.code(409).send({ error: "ACK_EQUIVOCATION" });
  await postJson(`${peerUrlFor(sessionRecord.signed)}/sessions/${req.params.id}/acks/receive`, { ack });
  return ack;
});

app.post("/sessions/:id/acks/receive", async (req: any, reply) => {
  const sessionRecord = store.getSession(req.params.id);
  if (!sessionRecord) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  const { ack } = z.object({ ack: SignedAckSchema }).parse(req.body);
  if (!verifyAck(ack)) return reply.code(400).send({ error: "INVALID_ACK" });
  const event = store.getEvent(ack.eventHash);
  if (!event) return reply.code(404).send({ error: "EVENT_NOT_FOUND" });
  if (event.event.sessionId !== req.params.id) return reply.code(409).send({ error: "EVENT_SESSION_MISMATCH" });
  const expected = event.event.sender === sessionRecord.signed.session.operatorA ? sessionRecord.signed.session.operatorB : sessionRecord.signed.session.operatorA;
  if (ack.operator !== expected) return reply.code(403).send({ error: "WRONG_ACK_OPERATOR" });
  if (event.ack?.ackHash === ack.ackHash) return { accepted: true, duplicate: true };
  if (ack.decision === "ACCEPT" && event.event.type === "PAYMENT_SETTLED") { const c = FiberPaymentClaimSchema.safeParse(event.event.payload); if (!c.success || store.claimPayment(req.params.id, c.data, event.event.eventHash) === "CONFLICT") return reply.code(409).send({ error: "FIBER_PAYMENT_REUSE" }); }
  if (store.saveAck(ack) === "CONFLICT") return reply.code(409).send({ error: "ACK_EQUIVOCATION" });
  return { accepted: true };
});

app.post("/sessions/:id/close", { preHandler: adminGuard }, async (req: any, reply) => {
  const sessionRecord = store.getSession(req.params.id);
  if (!sessionRecord) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  if (sessionRecord.close) return { close: sessionRecord.close, anchor: sessionRecord.anchor, duplicate: true };
  if (identity.publicKey !== sessionRecord.signed.session.operatorA) return reply.code(403).send({ error: "ONLY_OPERATOR_A_INITIATES_CLOSE_IN_V01" });
  const events = store.listEvents(req.params.id);
  if (events.some((x) => x.status !== "FINAL" || !x.ack)) return reply.code(409).send({ error: "ALL_EVENTS_MUST_BE_ACCEPTED" });
  const input = z.object({ finalState: z.unknown().optional() }).parse(req.body ?? {});
  const finalItems = events.map((x) => ({ event: x.event, ack: x.ack! }));
  const paymentHashes = acceptedFiberPaymentHashes(events);
  const close = CloseBodySchema.parse({
    sessionId: req.params.id,
    eventCount: events.length,
    transcriptRoot: computeTranscriptRoot(finalItems),
    finalStateHash: finalStateHashFrom(input.finalState ?? { status: "closed", eventCount: events.length }),
    fiberPayments: paymentHashes,
    closedAt: new Date().toISOString()
  });
  const finalState = input.finalState ?? { status: "closed", eventCount: events.length };
  close.finalStateHash = finalStateHashFrom(finalState);
  const signatureA = signProtocolObject(SIGNING_DOMAIN.CLOSE, close, identity.privateKey);
  const proposal = SignedCloseSchema.parse({ close, finalState, signatureA });
  if (store.saveCloseProposal(req.params.id, proposal) === "CONFLICT") return reply.code(409).send({ error: "CLOSE_EQUIVOCATION" });
  const peerResult = await postPeer<{ signatureB: string }>(sessionRecord.signed, `/sessions/${req.params.id}/close/receive`, { close, finalState, signatureA });
  if (!verifyProtocolObject(SIGNING_DOMAIN.CLOSE, close, peerResult.signatureB, sessionRecord.signed.session.operatorB)) return reply.code(502).send({ error: "INVALID_CLOSE_SIGNATURE_B" });
  const signedClose = SignedCloseSchema.parse({ close, finalState, signatureA, signatureB: peerResult.signatureB });
  if (store.saveClose(req.params.id, signedClose) === "CONFLICT") return reply.code(409).send({ error: "CLOSE_EQUIVOCATION" });
  let anchor: { txHash: string; dataHex: string } | undefined;
  if (ckb) {
    const anchored = await ckb.anchor({ sessionId: req.params.id, transcriptRoot: close.transcriptRoot, finalStateHash: close.finalStateHash });
    anchor = anchored;
    store.saveAnchor(req.params.id, anchored);
    try {
      await postJson(`${peerUrlFor(sessionRecord.signed)}/sessions/${req.params.id}/anchor/receive`, { anchor: anchored });
    } catch (error) {
      app.log.warn({ error }, "CKB anchor committed but peer notification failed; local transcript retains the tx hash");
    }
  }
  return { close: signedClose, anchor };
});

app.post("/sessions/:id/close/receive", async (req: any, reply) => {
  const sessionRecord = store.getSession(req.params.id);
  if (!sessionRecord) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  if (identity.publicKey !== sessionRecord.signed.session.operatorB) return reply.code(403).send({ error: "ONLY_OPERATOR_B_ACCEPTS_CLOSE" });
  const input = z.object({ close: CloseBodySchema, finalState: z.unknown(), signatureA: z.string() }).parse(req.body);
  if (input.close.sessionId !== req.params.id) return reply.code(400).send({ error: "SESSION_ID_MISMATCH" });
  if (!verifyProtocolObject(SIGNING_DOMAIN.CLOSE, input.close, input.signatureA, sessionRecord.signed.session.operatorA)) return reply.code(400).send({ error: "INVALID_CLOSE_SIGNATURE_A" });
  const events = store.listEvents(req.params.id);
  if (events.some((x) => x.status !== "FINAL" || !x.ack)) return reply.code(409).send({ error: "LOCAL_TRANSCRIPT_NOT_FINAL" });
  const root = computeTranscriptRoot(events.map((x) => ({ event: x.event, ack: x.ack! })));
  if (root !== input.close.transcriptRoot || events.length !== input.close.eventCount) return reply.code(409).send({ error: "TRANSCRIPT_MISMATCH", localRoot: root });
  if (finalStateHashFrom(input.finalState).toLowerCase() !== input.close.finalStateHash.toLowerCase()) return reply.code(409).send({ error: "FINAL_STATE_HASH_MISMATCH" });
  if (canonical(acceptedFiberPaymentHashes(events)) !== canonical([...new Set(input.close.fiberPayments.map((x:string)=>x.toLowerCase()))].sort())) return reply.code(409).send({ error: "FIBER_PAYMENT_SET_MISMATCH" });
  const signatureB = signProtocolObject(SIGNING_DOMAIN.CLOSE, input.close, identity.privateKey);
  if (store.saveClose(req.params.id, { close: input.close, finalState: input.finalState, signatureA: input.signatureA, signatureB }) === "CONFLICT") return reply.code(409).send({ error: "CLOSE_EQUIVOCATION" });
  return { signatureB };
});

app.post("/sessions/:id/anchor/receive", async (req: any, reply) => {
  const record = store.getSession(req.params.id); if (!record?.close) return reply.code(409).send({ error: "SESSION_NOT_CLOSED" });
  const { anchor } = z.object({ anchor: z.object({ txHash: z.string(), dataHex: z.string() }) }).parse(req.body);
  const expected = buildAnchorDataHex(req.params.id, record.close.close.transcriptRoot, record.close.close.finalStateHash);
  if (anchor.dataHex.toLowerCase() !== expected.toLowerCase()) return reply.code(400).send({ error: "ANCHOR_COMMITMENT_MISMATCH" });
  if (!ckbRpcUrl) return reply.code(503).send({ error: "CKB_RPC_REQUIRED" });
  const verification = await inspectAnchorRpc(ckbRpcUrl, anchor.txHash, expected);
  if (!verification.ok) return reply.code(202).send({ accepted: false, pending: verification.status === "pending", verification });
  store.saveAnchor(req.params.id, { ...anchor, status: "COMMITTED", blockHash: verification.blockHash });
  return { accepted: true, verification };
});

app.post("/fiber/new-invoice", { preHandler: adminGuard }, async (req: any, reply) => {
  if (!fiber) return reply.code(503).send({ error: "FIBER_DISABLED" });
  const body = z.object({ sessionId: z.string().min(1), amount: z.string(), currency: z.enum(["Fibb","Fibt","Fibd"]).optional(), description: z.string().optional(), udtTypeScript: z.any().optional() }).parse(req.body);
  if (!store.getSession(body.sessionId)) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  return fiber.newInvoice(body);
});
app.post("/fiber/send-payment", { preHandler: adminGuard }, async (req: any, reply) => {
  if (!fiber) return reply.code(503).send({ error: "FIBER_DISABLED" });
  const { invoice } = z.object({ invoice: z.string().min(1) }).parse(req.body);
  return fiber.sendPayment(invoice);
});
app.get("/fiber/payments/:hash", { preHandler: adminGuard }, async (req: any, reply) => { if (!fiber) return reply.code(503).send({ error: "FIBER_DISABLED" }); return fiber.getPayment(req.params.hash); });
app.get("/fiber/invoices/:hash", { preHandler: adminGuard }, async (req: any, reply) => { if (!fiber) return reply.code(503).send({ error: "FIBER_DISABLED" }); return fiber.getInvoice(req.params.hash); });

app.setErrorHandler((error, _req, reply) => {
  app.log.error(error);
  reply.code((error as any).statusCode ?? 400).send({ error: "REQUEST_FAILED", detail: error.message });
});

await app.listen({ port, host: "0.0.0.0" });
