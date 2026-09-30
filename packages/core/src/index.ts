import { createHash, randomBytes } from "node:crypto";
import stableStringify from "json-stable-stringify";
import { secp256k1 } from "@noble/curves/secp256k1";
import { z } from "zod";

export const ZERO_HASH = `0x${"00".repeat(32)}`;
export const PROTOCOL = "eventmesh-v0.2.0";
export const ANCHOR_DOMAIN = "EVENTMESH_V02";
export const SIGNING_DOMAIN = {
  SESSION: "session",
  EVENT: "event",
  ACK: "ack",
  CLOSE: "close",
  ANCHOR_NOTICE: "anchor-notice",
  PAYMENT_EVIDENCE: "payment-evidence",
  RECONCILE: "reconcile"
} as const;
export type SigningDomain = (typeof SIGNING_DOMAIN)[keyof typeof SIGNING_DOMAIN];

const Pub = z.string().regex(/^0x[0-9a-f]{66}$/i);
const H32 = z.string().regex(/^0x[0-9a-f]{64}$/i);
const Sig = z.string().regex(/^0x[0-9a-f]{128}$/i);
const Hex = z.string().regex(/^0x[0-9a-f]*$/i);

export const CkbScriptSchema = z.object({
  code_hash: H32,
  hash_type: z.enum(["data", "type", "data1", "data2"]),
  args: Hex
}).strict();
export type CkbScript = z.infer<typeof CkbScriptSchema>;

export const SessionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  protocol: z.literal(PROTOCOL),
  environment: z.enum(["DEMO", "TESTNET"]).optional(),
  operatorA: Pub,
  operatorB: Pub,
  operatorAUrl: z.string().url(),
  operatorBUrl: z.string().url(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxEvents: z.number().int().positive().max(10000)
}).superRefine((session, context) => {
  if (session.operatorA.toLowerCase() === session.operatorB.toLowerCase()) {
    context.addIssue({ code: "custom", message: "operators must be distinct", path: ["operatorB"] });
  }
  if (Date.parse(session.expiresAt) <= Date.parse(session.createdAt)) {
    context.addIssue({ code: "custom", message: "expiresAt must be after createdAt", path: ["expiresAt"] });
  }
});
export type Session = z.infer<typeof SessionSchema>;

export const SignedSessionSchema = z.object({
  session: SessionSchema,
  signatureA: Sig,
  signatureB: Sig.optional()
});
export type SignedSession = z.infer<typeof SignedSessionSchema>;

export const EventBodySchema = z.object({
  sessionId: z.string().min(1),
  sequence: z.number().int().positive(),
  previousHash: H32,
  type: z.string().min(1).max(80),
  payload: z.unknown(),
  sender: Pub,
  createdAt: z.string().datetime()
});
export type EventBody = z.infer<typeof EventBodySchema>;
export const SignedEventSchema = EventBodySchema.extend({ eventHash: H32, signature: Sig });
export type SignedEvent = z.infer<typeof SignedEventSchema>;

export const AckBodySchema = z.object({
  eventHash: H32,
  decision: z.enum(["ACCEPT", "REJECT"]),
  operator: Pub,
  createdAt: z.string().datetime()
});
export type AckBody = z.infer<typeof AckBodySchema>;
export const SignedAckSchema = AckBodySchema.extend({ ackHash: H32, signature: Sig });
export type SignedAck = z.infer<typeof SignedAckSchema>;

/**
 * A PAYMENT_SETTLED event is a claim that the receiver must independently
 * verify against its own FNN before signing ACCEPT. The optional UDT script is
 * part of the canonical claim and therefore part of paymentEvidenceRoot.
 */
export const FiberPaymentClaimSchema = z.object({
  paymentHash: H32,
  sessionId: z.string().min(1).max(128),
  amount: z.string().regex(/^(?:0x[0-9a-f]+|[0-9]+)$/i),
  currency: z.enum(["Fibb", "Fibt", "Fibd"]),
  udtTypeScript: CkbScriptSchema.optional(),
  // Optional application-level binding. These fields make one payment identify
  // the exact obligation/result it settles rather than only the broad session.
  obligationId: z.string().min(1).max(128).optional(),
  settlesEventHash: H32.optional(),
  purposeHash: H32.optional(),
  expectedPayeePublicKey: z.string().min(1).max(256).optional()
}).strict();
export type FiberPaymentClaim = z.infer<typeof FiberPaymentClaimSchema>;

export function computeFiberPaymentPurposeHash(input: {
  sessionId: string;
  amount: string;
  currency: "Fibb" | "Fibt" | "Fibd";
  udtTypeScript?: CkbScript;
  obligationId?: string;
  settlesEventHash?: string;
  expectedPayeePublicKey?: string;
}) {
  let normalizedAmount: string;
  try { normalizedAmount = BigInt(input.amount).toString(10); }
  catch { throw new Error("INVALID_FIBER_PAYMENT_AMOUNT"); }
  return sha256Hex(canonical({
    domain: "EventMesh/FiberPaymentPurpose/v1",
    sessionId: input.sessionId,
    amount: normalizedAmount,
    currency: input.currency,
    udtTypeScript: input.udtTypeScript,
    obligationId: input.obligationId,
    settlesEventHash: input.settlesEventHash?.toLowerCase(),
    expectedPayeePublicKey: input.expectedPayeePublicKey?.toLowerCase()
  }));
}

export const FiberPaymentEvidenceSchema = z.object({
  claim: FiberPaymentClaimSchema,
  verifier: z.literal("RECEIVER_FNN"),
  verifiedAt: z.string().datetime(),
  invoiceStatus: z.literal("Paid"),
  payeePublicKey: z.string().optional(),
  observedUdtTypeScript: CkbScriptSchema.optional()
}).strict();
export type FiberPaymentEvidence = z.infer<typeof FiberPaymentEvidenceSchema>;

/**
 * Receiver-owned observations are signed by the EventMesh operator that owns
 * the receiving FNN. This prevents an exported transcript from containing an
 * unauthenticated JSON object that merely claims an invoice was Paid.
 */
export const SignedFiberPaymentEvidenceSchema = z.object({
  evidence: FiberPaymentEvidenceSchema,
  observer: Pub,
  evidenceHash: H32,
  signature: Sig
}).strict();
export type SignedFiberPaymentEvidence = z.infer<typeof SignedFiberPaymentEvidenceSchema>;

export const CloseBodySchema = z.object({
  sessionId: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  transcriptRoot: H32,
  finalStateHash: H32,
  fiberPayments: z.array(H32),
  paymentEvidenceRoot: H32,
  closedAt: z.string().datetime()
});
export type CloseBody = z.infer<typeof CloseBodySchema>;
export const SignedCloseSchema = z.object({
  close: CloseBodySchema,
  finalState: z.unknown().optional(),
  signatureA: Sig.optional(),
  signatureB: Sig.optional()
});
export type SignedClose = z.infer<typeof SignedCloseSchema>;

export type ConflictEvidence = {
  kind: "SESSION" | "EVENT" | "PROPOSAL_COLLISION" | "ACK" | "CLOSE" | "ANCHOR" | "PAYMENT";
  observedAt: string;
  existing: unknown;
  incoming: unknown;
};

export type TranscriptExport = {
  session: SignedSession;
  events: Array<{ event: SignedEvent; ack?: SignedAck }>;
  close?: SignedClose;
  // Legacy v0.2 exports may contain unsigned FiberPaymentEvidence. New
  // operators export SignedFiberPaymentEvidence and verifiers authenticate it.
  paymentEvidence?: Array<SignedFiberPaymentEvidence | FiberPaymentEvidence>;
  ckbAnchor?: {
    txHash: string;
    dataHex: string;
    status?: "PENDING" | "COMMITTED" | "CONFIRMED";
    blockHash?: string;
  };
  conflicts?: ConflictEvidence[];
};

export const canonical = (value: unknown) => stableStringify(value) ?? "null";
export function sha256Hex(value: string | Uint8Array) {
  const hash = createHash("sha256");
  hash.update(value);
  return `0x${hash.digest("hex")}`;
}
export const strip0x = (value: string) => value.startsWith("0x") ? value.slice(2) : value;
export const bytesToHex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
export const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(strip0x(hex), "hex"));
export const randomPrivateKeyHex = () => bytesToHex(secp256k1.utils.randomPrivateKey());
export const publicKeyFromPrivate = (key: string) => bytesToHex(secp256k1.getPublicKey(hexToBytes(key), true));

export function signObject(value: unknown, privateKey: string) {
  return bytesToHex(secp256k1.sign(hexToBytes(sha256Hex(canonical(value))), hexToBytes(privateKey)).toCompactRawBytes());
}
export function verifyObject(value: unknown, signature: string, publicKey: string) {
  try {
    return secp256k1.verify(hexToBytes(signature), hexToBytes(sha256Hex(canonical(value))), hexToBytes(publicKey));
  } catch {
    return false;
  }
}
export const signingEnvelope = (domain: SigningDomain, value: unknown) => ({
  domain: `EventMesh/${PROTOCOL}/${domain}`,
  value
});
export const signProtocolObject = (domain: SigningDomain, value: unknown, privateKey: string) =>
  signObject(signingEnvelope(domain, value), privateKey);
export const verifyProtocolObject = (domain: SigningDomain, value: unknown, signature: string, publicKey: string) =>
  verifyObject(signingEnvelope(domain, value), signature, publicKey);

export const createSessionId = () => `ses_${randomBytes(10).toString("hex")}`;
export const eventHash = (body: EventBody) => sha256Hex(canonical(body));
export const ackHash = (body: AckBody) => sha256Hex(canonical(body));

export function signEvent(body: EventBody, privateKey: string): SignedEvent {
  const parsed = EventBodySchema.parse(body);
  return {
    ...parsed,
    eventHash: eventHash(parsed),
    signature: signProtocolObject(SIGNING_DOMAIN.EVENT, parsed, privateKey)
  };
}
export function verifyEvent(event: SignedEvent) {
  const parsed = SignedEventSchema.safeParse(event);
  if (!parsed.success) return false;
  const { eventHash: claimedHash, signature, ...body } = parsed.data;
  return claimedHash.toLowerCase() === eventHash(body).toLowerCase()
    && verifyProtocolObject(SIGNING_DOMAIN.EVENT, body, signature, body.sender);
}
export function signAck(body: AckBody, privateKey: string): SignedAck {
  const parsed = AckBodySchema.parse(body);
  return {
    ...parsed,
    ackHash: ackHash(parsed),
    signature: signProtocolObject(SIGNING_DOMAIN.ACK, parsed, privateKey)
  };
}
export function verifyAck(ack: SignedAck) {
  const parsed = SignedAckSchema.safeParse(ack);
  if (!parsed.success) return false;
  const { ackHash: claimedHash, signature, ...body } = parsed.data;
  return claimedHash.toLowerCase() === ackHash(body).toLowerCase()
    && verifyProtocolObject(SIGNING_DOMAIN.ACK, body, signature, body.operator);
}

export function fiberPaymentEvidenceHash(evidence: FiberPaymentEvidence, observer: string) {
  return sha256Hex(canonical({ evidence: FiberPaymentEvidenceSchema.parse(evidence), observer }));
}

export function signFiberPaymentEvidence(
  evidence: FiberPaymentEvidence,
  observer: string,
  privateKey: string
): SignedFiberPaymentEvidence {
  const parsedEvidence = FiberPaymentEvidenceSchema.parse(evidence);
  const body = { evidence: parsedEvidence, observer };
  return SignedFiberPaymentEvidenceSchema.parse({
    ...body,
    evidenceHash: fiberPaymentEvidenceHash(parsedEvidence, observer),
    signature: signProtocolObject(SIGNING_DOMAIN.PAYMENT_EVIDENCE, body, privateKey)
  });
}

export function verifyFiberPaymentEvidence(input: SignedFiberPaymentEvidence) {
  const parsed = SignedFiberPaymentEvidenceSchema.safeParse(input);
  if (!parsed.success) return false;
  const { evidence, observer, evidenceHash, signature } = parsed.data;
  const body = { evidence, observer };
  return evidenceHash.toLowerCase() === fiberPaymentEvidenceHash(evidence, observer).toLowerCase()
    && verifyProtocolObject(SIGNING_DOMAIN.PAYMENT_EVIDENCE, body, signature, observer);
}

export const signedPaymentEvidenceLeaf = (input: SignedFiberPaymentEvidence) =>
  sha256Hex(canonical(SignedFiberPaymentEvidenceSchema.parse(input)));
export const computeSignedPaymentEvidenceRoot = (items: SignedFiberPaymentEvidence[]) =>
  merkleRoot([...items]
    .sort((a, b) => a.evidence.claim.paymentHash.toLowerCase().localeCompare(b.evidence.claim.paymentHash.toLowerCase()))
    .map(signedPaymentEvidenceLeaf));

export const transcriptLeaf = (event: SignedEvent, ack: SignedAck) =>
  sha256Hex(`${event.eventHash.toLowerCase()}:${ack.ackHash.toLowerCase()}`);
export function merkleRoot(leaves: string[]) {
  if (!leaves.length) return sha256Hex("EVENTMESH_EMPTY_TRANSCRIPT");
  let level = leaves.map((value) => value.toLowerCase());
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(sha256Hex(`${level[index]}:${level[index + 1] ?? level[index]}`));
    }
    level = next;
  }
  return level[0];
}
export const computeTranscriptRoot = (items: Array<{ event: SignedEvent; ack: SignedAck }>) =>
  merkleRoot([...items]
    .sort((a, b) => a.event.sequence - b.event.sequence)
    .map((item) => transcriptLeaf(item.event, item.ack)));
export const finalStateHashFrom = (value: unknown) => sha256Hex(canonical(value));

export function acceptedFiberPaymentClaims(items: Array<{ event: SignedEvent; ack?: SignedAck }>) {
  const claims = new Map<string, FiberPaymentClaim>();
  for (const item of items) {
    if (item.event.type !== "PAYMENT_SETTLED" || item.ack?.decision !== "ACCEPT") continue;
    const parsed = FiberPaymentClaimSchema.safeParse(item.event.payload);
    if (!parsed.success) continue;
    claims.set(parsed.data.paymentHash.toLowerCase(), parsed.data);
  }
  return [...claims.values()].sort((a, b) => a.paymentHash.toLowerCase().localeCompare(b.paymentHash.toLowerCase()));
}
export function acceptedFiberPaymentHashes(items: Array<{ event: SignedEvent; ack?: SignedAck }>) {
  return acceptedFiberPaymentClaims(items).map((claim) => claim.paymentHash.toLowerCase());
}
export const paymentEvidenceLeaf = (claim: FiberPaymentClaim) => sha256Hex(canonical(FiberPaymentClaimSchema.parse(claim)));
export const computePaymentEvidenceRoot = (items: Array<{ event: SignedEvent; ack?: SignedAck }>) =>
  merkleRoot(acceptedFiberPaymentClaims(items).map(paymentEvidenceLeaf));

export function buildAnchorDataHex(
  sessionId: string,
  transcriptRoot: string,
  finalStateHash: string,
  paymentEvidenceRoot: string
) {
  return `0x${Buffer.concat([
    Buffer.from(ANCHOR_DOMAIN),
    Buffer.from(strip0x(sha256Hex(sessionId)), "hex"),
    Buffer.from(strip0x(transcriptRoot), "hex"),
    Buffer.from(strip0x(finalStateHash), "hex"),
    Buffer.from(strip0x(paymentEvidenceRoot), "hex")
  ]).toString("hex")}`;
}

export function verifyTranscript(transcript: TranscriptExport) {
  const errors: string[] = [];
  const parsedSession = SignedSessionSchema.safeParse(transcript.session);
  if (!parsedSession.success) return { ok: false, errors: ["Invalid session schema"] };

  const { session, signatureA, signatureB } = parsedSession.data;
  if (!verifyProtocolObject(SIGNING_DOMAIN.SESSION, session, signatureA, session.operatorA)) {
    errors.push("Invalid operator A session signature");
  }
  if (!signatureB || !verifyProtocolObject(SIGNING_DOMAIN.SESSION, session, signatureB, session.operatorB)) {
    errors.push("Invalid or missing operator B session signature");
  }

  let previousHash = ZERO_HASH;
  const finalItems: Array<{ event: SignedEvent; ack: SignedAck }> = [];
  const paymentEvents = new Map<string, string>();
  const sortedEvents = [...transcript.events].sort((a, b) => a.event.sequence - b.event.sequence);
  const signedEvidenceByPayment = new Map<string, SignedFiberPaymentEvidence>();
  const legacyEvidenceByPayment = new Map<string, FiberPaymentEvidence>();
  const hasEvidenceSection = transcript.paymentEvidence !== undefined;
  for (const evidence of transcript.paymentEvidence ?? []) {
    const signed = SignedFiberPaymentEvidenceSchema.safeParse(evidence);
    if (signed.success) {
      if (!verifyFiberPaymentEvidence(signed.data)) {
        errors.push("Invalid signed Fiber payment evidence");
        continue;
      }
      const paymentHash = signed.data.evidence.claim.paymentHash.toLowerCase();
      const previous = signedEvidenceByPayment.get(paymentHash);
      if (previous && canonical(previous) !== canonical(signed.data)) errors.push(`Conflicting Fiber payment evidence for ${paymentHash}`);
      signedEvidenceByPayment.set(paymentHash, signed.data);
      continue;
    }

    // Backward compatibility for already-exported v0.2 transcripts. Legacy
    // observations are accepted as historical metadata only; they do not get
    // the stronger receiver-authentication guarantee of signed observations.
    const legacy = FiberPaymentEvidenceSchema.safeParse(evidence);
    if (!legacy.success) {
      errors.push("Invalid Fiber payment evidence");
      continue;
    }
    const paymentHash = legacy.data.claim.paymentHash.toLowerCase();
    const previous = legacyEvidenceByPayment.get(paymentHash);
    if (previous && canonical(previous) !== canonical(legacy.data)) errors.push(`Conflicting legacy Fiber payment evidence for ${paymentHash}`);
    legacyEvidenceByPayment.set(paymentHash, legacy.data);
  }

  for (const [index, item] of sortedEvents.entries()) {
    const { event, ack } = item;
    if (event.sessionId !== session.sessionId) errors.push(`Event ${event.sequence} wrong session`);
    if (event.sequence !== index + 1) errors.push(`Non-contiguous sequence at ${event.sequence}`);
    if (event.previousHash.toLowerCase() !== previousHash.toLowerCase()) errors.push(`Broken previousHash at event ${event.sequence}`);
    if (event.sender !== session.operatorA && event.sender !== session.operatorB) errors.push(`Event ${event.sequence} sender is not a session participant`);
    if (!verifyEvent(event)) errors.push(`Invalid event signature/hash at ${event.sequence}`);

    if (!ack) {
      errors.push(`Missing acknowledgement for event ${event.sequence}`);
    } else {
      if (ack.eventHash.toLowerCase() !== event.eventHash.toLowerCase()) errors.push(`ACK mismatch at event ${event.sequence}`);
      if (!verifyAck(ack)) errors.push(`Invalid ACK at event ${event.sequence}`);
      const expectedAckOperator = event.sender === session.operatorA ? session.operatorB : session.operatorA;
      if (ack.operator !== expectedAckOperator) errors.push(`ACK signed by wrong operator at event ${event.sequence}`);

      if (ack.decision === "ACCEPT" && event.type === "PAYMENT_SETTLED") {
        const claim = FiberPaymentClaimSchema.safeParse(event.payload);
        if (!claim.success) {
          errors.push(`Invalid PAYMENT_SETTLED payload at event ${event.sequence}`);
        } else {
          if (claim.data.sessionId !== session.sessionId) errors.push(`PAYMENT_SETTLED wrong session at event ${event.sequence}`);
          if (claim.data.purposeHash) {
            const derivedPurposeHash = computeFiberPaymentPurposeHash(claim.data);
            if (derivedPurposeHash.toLowerCase() !== claim.data.purposeHash.toLowerCase()) {
              errors.push(`PAYMENT_SETTLED purposeHash mismatch at event ${event.sequence}`);
            }
          }
          const paymentHash = claim.data.paymentHash.toLowerCase();
          if (paymentEvents.has(paymentHash) && paymentEvents.get(paymentHash) !== event.eventHash.toLowerCase()) {
            errors.push(`Fiber payment hash reused at event ${event.sequence}`);
          } else {
            paymentEvents.set(paymentHash, event.eventHash.toLowerCase());
          }
          const observed = signedEvidenceByPayment.get(paymentHash);
          const legacyObserved = legacyEvidenceByPayment.get(paymentHash);
          if (observed) {
            const expectedObserver = ack.operator;
            if (observed.observer !== expectedObserver) errors.push(`Fiber payment evidence signed by wrong operator at event ${event.sequence}`);
            if (canonical(observed.evidence.claim) !== canonical(claim.data)) errors.push(`Fiber payment evidence claim mismatch at event ${event.sequence}`);
          } else if (legacyObserved) {
            if (canonical(legacyObserved.claim) !== canonical(claim.data)) errors.push(`Legacy Fiber payment evidence claim mismatch at event ${event.sequence}`);
          } else if (hasEvidenceSection) {
            // New exporters include an evidence section. If that section exists,
            // every accepted payment must have a corresponding observation.
            errors.push(`Missing receiver Fiber payment evidence at event ${event.sequence}`);
          }
        }
      }
      finalItems.push({ event, ack });
    }
    previousHash = event.eventHash;
  }

  if (transcript.close) {
    const parsedClose = SignedCloseSchema.safeParse(transcript.close);
    if (!parsedClose.success) {
      errors.push("Invalid close schema");
    } else {
      const { close, finalState, signatureA: closeSignatureA, signatureB: closeSignatureB } = parsedClose.data;
      if (close.sessionId !== session.sessionId) errors.push("Close references wrong session");
      if (close.eventCount !== finalItems.length) errors.push("Close eventCount mismatch");
      if (finalItems.some((item) => item.ack.decision !== "ACCEPT")) errors.push("Close contains a rejected event");
      if (computeTranscriptRoot(finalItems).toLowerCase() !== close.transcriptRoot.toLowerCase()) errors.push("Close transcriptRoot mismatch");
      if (canonical(acceptedFiberPaymentHashes(finalItems)) !== canonical([...new Set(close.fiberPayments.map((value) => value.toLowerCase()))].sort())) {
        errors.push("Close fiberPayments mismatch");
      }
      if (computePaymentEvidenceRoot(finalItems).toLowerCase() !== close.paymentEvidenceRoot.toLowerCase()) {
        errors.push("Close paymentEvidenceRoot mismatch");
      }
      if (finalState !== undefined && finalStateHashFrom(finalState).toLowerCase() !== close.finalStateHash.toLowerCase()) {
        errors.push("Close finalStateHash mismatch");
      }
      if (!closeSignatureA || !verifyProtocolObject(SIGNING_DOMAIN.CLOSE, close, closeSignatureA, session.operatorA)) {
        errors.push("Invalid or missing operator A close signature");
      }
      if (!closeSignatureB || !verifyProtocolObject(SIGNING_DOMAIN.CLOSE, close, closeSignatureB, session.operatorB)) {
        errors.push("Invalid or missing operator B close signature");
      }

      if (transcript.ckbAnchor) {
        const expectedAnchor = buildAnchorDataHex(
          session.sessionId,
          close.transcriptRoot,
          close.finalStateHash,
          close.paymentEvidenceRoot
        );
        if (transcript.ckbAnchor.dataHex.toLowerCase() !== expectedAnchor.toLowerCase()) {
          errors.push("CKB anchor data does not match close commitment");
        }
      }
    }
  }

  if (transcript.conflicts?.length) errors.push(`Transcript contains ${transcript.conflicts.length} recorded conflict(s)`);
  return { ok: errors.length === 0, errors };
}
