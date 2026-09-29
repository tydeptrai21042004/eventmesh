import { createHash, randomBytes } from "node:crypto";
import stableStringify from "json-stable-stringify";
import { secp256k1 } from "@noble/curves/secp256k1";
import { z } from "zod";

export const ZERO_HASH = `0x${"00".repeat(32)}`;
export const PROTOCOL = "eventmesh-v0.1";

export const SessionSchema = z.object({
  sessionId: z.string().min(1),
  protocol: z.literal(PROTOCOL),
  operatorA: z.string().regex(/^0x[0-9a-f]{66}$/i),
  operatorB: z.string().regex(/^0x[0-9a-f]{66}$/i),
  operatorAUrl: z.string().url(),
  operatorBUrl: z.string().url(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxEvents: z.number().int().positive().max(10000)
});
export type Session = z.infer<typeof SessionSchema>;

export const SignedSessionSchema = z.object({
  session: SessionSchema,
  signatureA: z.string().regex(/^0x[0-9a-f]{128}$/i),
  signatureB: z.string().regex(/^0x[0-9a-f]{128}$/i).optional()
});
export type SignedSession = z.infer<typeof SignedSessionSchema>;

export const EventBodySchema = z.object({
  sessionId: z.string(),
  sequence: z.number().int().positive(),
  previousHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  type: z.string().min(1).max(80),
  payload: z.unknown(),
  sender: z.string().regex(/^0x[0-9a-f]{66}$/i),
  createdAt: z.string().datetime()
});
export type EventBody = z.infer<typeof EventBodySchema>;

export const SignedEventSchema = EventBodySchema.extend({
  eventHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  signature: z.string().regex(/^0x[0-9a-f]{128}$/i)
});
export type SignedEvent = z.infer<typeof SignedEventSchema>;

export const AckBodySchema = z.object({
  eventHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  decision: z.enum(["ACCEPT", "REJECT"]),
  operator: z.string().regex(/^0x[0-9a-f]{66}$/i),
  createdAt: z.string().datetime()
});
export type AckBody = z.infer<typeof AckBodySchema>;

export const SignedAckSchema = AckBodySchema.extend({
  ackHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  signature: z.string().regex(/^0x[0-9a-f]{128}$/i)
});
export type SignedAck = z.infer<typeof SignedAckSchema>;

export const CloseBodySchema = z.object({
  sessionId: z.string(),
  eventCount: z.number().int().nonnegative(),
  transcriptRoot: z.string().regex(/^0x[0-9a-f]{64}$/i),
  finalStateHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  fiberPayments: z.array(z.string()),
  closedAt: z.string().datetime()
});
export type CloseBody = z.infer<typeof CloseBodySchema>;

export const SignedCloseSchema = z.object({
  close: CloseBodySchema,
  signatureA: z.string().regex(/^0x[0-9a-f]{128}$/i).optional(),
  signatureB: z.string().regex(/^0x[0-9a-f]{128}$/i).optional()
});
export type SignedClose = z.infer<typeof SignedCloseSchema>;

export type TranscriptExport = {
  session: SignedSession;
  events: Array<{ event: SignedEvent; ack?: SignedAck }>;
  close?: SignedClose;
  ckbAnchor?: { txHash: string; dataHex: string };
};

export function canonical(value: unknown): string {
  return stableStringify(value) ?? "null";
}

export function sha256Hex(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(value);
  return `0x${hash.digest("hex")}`;
}

export function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(strip0x(hex), "hex"));
}

export function randomPrivateKeyHex(): string {
  return bytesToHex(secp256k1.utils.randomPrivateKey());
}

export function publicKeyFromPrivate(privateKeyHex: string): string {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKeyHex), true));
}

export function signObject(value: unknown, privateKeyHex: string): string {
  const digest = hexToBytes(sha256Hex(canonical(value)));
  const signature = secp256k1.sign(digest, hexToBytes(privateKeyHex));
  return bytesToHex(signature.toCompactRawBytes());
}

export function verifyObject(value: unknown, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const digest = hexToBytes(sha256Hex(canonical(value)));
    return secp256k1.verify(hexToBytes(signatureHex), digest, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export function createSessionId(): string {
  return `ses_${randomBytes(10).toString("hex")}`;
}

export function eventHash(body: EventBody): string {
  return sha256Hex(canonical(body));
}

export function ackHash(body: AckBody): string {
  return sha256Hex(canonical(body));
}

export function signEvent(body: EventBody, privateKeyHex: string): SignedEvent {
  const parsed = EventBodySchema.parse(body);
  return { ...parsed, eventHash: eventHash(parsed), signature: signObject(parsed, privateKeyHex) };
}

export function verifyEvent(event: SignedEvent): boolean {
  const parsed = SignedEventSchema.safeParse(event);
  if (!parsed.success) return false;
  const { eventHash: suppliedHash, signature, ...body } = parsed.data;
  return suppliedHash === eventHash(body) && verifyObject(body, signature, body.sender);
}

export function signAck(body: AckBody, privateKeyHex: string): SignedAck {
  const parsed = AckBodySchema.parse(body);
  return { ...parsed, ackHash: ackHash(parsed), signature: signObject(parsed, privateKeyHex) };
}

export function verifyAck(ack: SignedAck): boolean {
  const parsed = SignedAckSchema.safeParse(ack);
  if (!parsed.success) return false;
  const { ackHash: suppliedHash, signature, ...body } = parsed.data;
  return suppliedHash === ackHash(body) && verifyObject(body, signature, body.operator);
}

export function transcriptLeaf(event: SignedEvent, ack: SignedAck): string {
  return sha256Hex(`${event.eventHash}:${ack.ackHash}`);
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256Hex("EVENTMESH_EMPTY_TRANSCRIPT");
  let level = leaves.map((leaf) => leaf.toLowerCase());
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(sha256Hex(`${left}:${right}`));
    }
    level = next;
  }
  return level[0];
}

export function computeTranscriptRoot(items: Array<{ event: SignedEvent; ack: SignedAck }>): string {
  const ordered = [...items].sort((a, b) => a.event.sequence - b.event.sequence);
  return merkleRoot(ordered.map(({ event, ack }) => transcriptLeaf(event, ack)));
}

export function finalStateHashFrom(value: unknown): string {
  return sha256Hex(canonical(value));
}

export function verifyTranscript(exported: TranscriptExport): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const sessionParsed = SignedSessionSchema.safeParse(exported.session);
  if (!sessionParsed.success) return { ok: false, errors: ["Invalid session schema"] };
  const { session, signatureA, signatureB } = sessionParsed.data;
  if (!verifyObject(session, signatureA, session.operatorA)) errors.push("Invalid operator A session signature");
  if (!signatureB || !verifyObject(session, signatureB, session.operatorB)) errors.push("Invalid or missing operator B session signature");

  let previousHash = ZERO_HASH;
  const finalItems: Array<{ event: SignedEvent; ack: SignedAck }> = [];
  const seenHashes = new Set<string>();
  const ordered = [...exported.events].sort((a, b) => a.event.sequence - b.event.sequence);

  for (let i = 0; i < ordered.length; i++) {
    const { event, ack } = ordered[i];
    if (event.sessionId !== session.sessionId) errors.push(`Event ${event.sequence} wrong session`);
    if (event.sequence !== i + 1) errors.push(`Non-contiguous sequence at ${event.sequence}`);
    if (event.previousHash !== previousHash) errors.push(`Broken previousHash at event ${event.sequence}`);
    if (!verifyEvent(event)) errors.push(`Invalid event signature/hash at ${event.sequence}`);
    if (seenHashes.has(event.eventHash)) errors.push(`Duplicate event hash at ${event.sequence}`);
    seenHashes.add(event.eventHash);
    if (!ack) {
      errors.push(`Missing acknowledgement for event ${event.sequence}`);
    } else {
      if (ack.eventHash !== event.eventHash) errors.push(`ACK mismatch at event ${event.sequence}`);
      if (!verifyAck(ack)) errors.push(`Invalid ACK at event ${event.sequence}`);
      const expectedAckOperator = event.sender === session.operatorA ? session.operatorB : session.operatorA;
      if (ack.operator !== expectedAckOperator) errors.push(`ACK signed by wrong operator at event ${event.sequence}`);
      if (ack.decision !== "ACCEPT") errors.push(`Event ${event.sequence} was not accepted`);
      finalItems.push({ event, ack });
    }
    previousHash = event.eventHash;
  }

  if (exported.close) {
    const closeParsed = SignedCloseSchema.safeParse(exported.close);
    if (!closeParsed.success) errors.push("Invalid close schema");
    else {
      const { close, signatureA: closeA, signatureB: closeB } = closeParsed.data;
      if (close.sessionId !== session.sessionId) errors.push("Close references wrong session");
      if (close.eventCount !== finalItems.length) errors.push("Close eventCount mismatch");
      const root = computeTranscriptRoot(finalItems);
      if (root !== close.transcriptRoot) errors.push("Close transcriptRoot mismatch");
      if (!closeA || !verifyObject(close, closeA, session.operatorA)) errors.push("Invalid/missing close signature A");
      if (!closeB || !verifyObject(close, closeB, session.operatorB)) errors.push("Invalid/missing close signature B");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildAnchorDataHex(sessionId: string, transcriptRoot: string, finalStateHash: string): string {
  const prefix = Buffer.from("EVENTMESH_V01", "utf8");
  const sessionHash = Buffer.from(strip0x(sha256Hex(sessionId)), "hex");
  const root = Buffer.from(strip0x(transcriptRoot), "hex");
  const state = Buffer.from(strip0x(finalStateHash), "hex");
  return `0x${Buffer.concat([prefix, sessionHash, root, state]).toString("hex")}`;
}
