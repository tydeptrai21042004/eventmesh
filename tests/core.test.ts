import { describe, expect, it } from "vitest";
import {
  ANCHOR_DOMAIN,
  PROTOCOL,
  SIGNING_DOMAIN,
  ZERO_HASH,
  acceptedFiberPaymentHashes,
  buildAnchorDataHex,
  computeFiberPaymentPurposeHash,
  computePaymentEvidenceRoot,
  computeTranscriptRoot,
  createSessionId,
  finalStateHashFrom,
  publicKeyFromPrivate,
  randomPrivateKeyHex,
  signAck,
  signEvent,
  signFiberPaymentEvidence,
  signProtocolObject,
  verifyAck,
  verifyEvent,
  verifyFiberPaymentEvidence,
  verifyProtocolObject,
  verifyTranscript,
  type FiberPaymentClaim,
  type Session,
  type TranscriptExport
} from "@eventmesh/core";

function fixture() {
  const aPriv = randomPrivateKeyHex();
  const bPriv = randomPrivateKeyHex();
  const a = publicKeyFromPrivate(aPriv);
  const b = publicKeyFromPrivate(bPriv);
  const session: Session = {
    sessionId: createSessionId(),
    protocol: PROTOCOL,
    operatorA: a,
    operatorB: b,
    operatorAUrl: "http://a.local:4000",
    operatorBUrl: "http://b.local:4000",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxEvents: 10
  };
  return { aPriv, bPriv, a, b, session };
}

function signedSession(f: ReturnType<typeof fixture>) {
  return {
    session: f.session,
    signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, f.session, f.aPriv),
    signatureB: signProtocolObject(SIGNING_DOMAIN.SESSION, f.session, f.bPriv)
  };
}

describe("EventMesh v0.2 core", () => {
  it("uses the v0.2 protocol and anchor domain", () => {
    expect(PROTOCOL).toBe("eventmesh-v0.2.0");
    expect(ANCHOR_DOMAIN).toBe("EVENTMESH_V02");
  });

  it("domain-separates signatures", () => {
    const f = fixture();
    const signature = signProtocolObject(SIGNING_DOMAIN.SESSION, f.session, f.aPriv);
    expect(verifyProtocolObject(SIGNING_DOMAIN.SESSION, f.session, signature, f.a)).toBe(true);
    expect(verifyProtocolObject(SIGNING_DOMAIN.CLOSE, f.session, signature, f.a)).toBe(false);
  });

  it("signs events and ACKs and detects tampering", () => {
    const f = fixture();
    const event = signEvent({
      sessionId: f.session.sessionId,
      sequence: 1,
      previousHash: ZERO_HASH,
      type: "WORK",
      payload: { x: 1 },
      sender: f.a,
      createdAt: new Date().toISOString()
    }, f.aPriv);
    const ack = signAck({
      eventHash: event.eventHash,
      decision: "ACCEPT",
      operator: f.b,
      createdAt: new Date().toISOString()
    }, f.bPriv);
    expect(verifyEvent(event)).toBe(true);
    expect(verifyAck(ack)).toBe(true);
    expect(verifyEvent({ ...event, payload: { x: 2 } } as any)).toBe(false);
  });

  it("binds rich Fiber claims into paymentEvidenceRoot", () => {
    const f = fixture();
    const claim: FiberPaymentClaim = {
      paymentHash: `0x${"12".repeat(32)}`,
      sessionId: f.session.sessionId,
      amount: "0x5f5e100",
      currency: "Fibt"
    };
    const event = signEvent({
      sessionId: f.session.sessionId,
      sequence: 1,
      previousHash: ZERO_HASH,
      type: "PAYMENT_SETTLED",
      payload: claim,
      sender: f.a,
      createdAt: new Date().toISOString()
    }, f.aPriv);
    const ack = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: f.b, createdAt: new Date().toISOString() }, f.bPriv);
    const root1 = computePaymentEvidenceRoot([{ event, ack }]);

    const changed = signEvent({ ...event, payload: { ...claim, amount: "0x5f5e101" } } as any, f.aPriv);
    const changedAck = signAck({ eventHash: changed.eventHash, decision: "ACCEPT", operator: f.b, createdAt: new Date().toISOString() }, f.bPriv);
    const root2 = computePaymentEvidenceRoot([{ event: changed, ack: changedAck }]);
    expect(root1).not.toBe(root2);
    expect(acceptedFiberPaymentHashes([{ event, ack }])).toEqual([claim.paymentHash.toLowerCase()]);
  });


  it("binds a payment to an obligation/result and authenticates receiver-owned evidence", () => {
    const f = fixture();
    const settlesEventHash = `0x${"44".repeat(32)}`;
    const purposeHash = computeFiberPaymentPurposeHash({
      sessionId: f.session.sessionId,
      amount: "100000000",
      currency: "Fibt",
      obligationId: "job-42",
      settlesEventHash,
      expectedPayeePublicKey: "02receiver"
    });
    const claim: FiberPaymentClaim = {
      paymentHash: `0x${"45".repeat(32)}`,
      sessionId: f.session.sessionId,
      amount: "100000000",
      currency: "Fibt",
      obligationId: "job-42",
      settlesEventHash,
      purposeHash,
      expectedPayeePublicKey: "02receiver"
    };
    const event = signEvent({
      sessionId: f.session.sessionId, sequence: 1, previousHash: ZERO_HASH,
      type: "PAYMENT_SETTLED", payload: claim, sender: f.a, createdAt: new Date().toISOString()
    }, f.aPriv);
    const ack = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: f.b, createdAt: new Date().toISOString() }, f.bPriv);
    const evidence = signFiberPaymentEvidence({
      claim, verifier: "RECEIVER_FNN", verifiedAt: new Date().toISOString(), invoiceStatus: "Paid", payeePublicKey: "02receiver"
    }, f.b, f.bPriv);
    expect(verifyFiberPaymentEvidence(evidence)).toBe(true);

    const transcript: TranscriptExport = { session: signedSession(f), events: [{ event, ack }], paymentEvidence: [evidence] };
    expect(verifyTranscript(transcript)).toEqual({ ok: true, errors: [] });
    const tampered = structuredClone(transcript);
    const tamperedEvidence = tampered.paymentEvidence![0] as any;
    tamperedEvidence.evidence.payeePublicKey = "02attacker";
    expect(verifyTranscript(tampered).errors).toContain("Invalid signed Fiber payment evidence");
  });

  it("validates a dual-signed close and v0.2 CKB commitment", () => {
    const f = fixture();
    const event = signEvent({
      sessionId: f.session.sessionId,
      sequence: 1,
      previousHash: ZERO_HASH,
      type: "WORK",
      payload: {},
      sender: f.a,
      createdAt: new Date().toISOString()
    }, f.aPriv);
    const ack = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: f.b, createdAt: new Date().toISOString() }, f.bPriv);
    const items = [{ event, ack }];
    const finalState = { done: true };
    const close = {
      sessionId: f.session.sessionId,
      eventCount: 1,
      transcriptRoot: computeTranscriptRoot(items),
      finalStateHash: finalStateHashFrom(finalState),
      fiberPayments: [],
      paymentEvidenceRoot: computePaymentEvidenceRoot(items),
      closedAt: new Date().toISOString()
    };
    const transcript: TranscriptExport = {
      session: signedSession(f),
      events: items,
      close: {
        close,
        finalState,
        signatureA: signProtocolObject(SIGNING_DOMAIN.CLOSE, close, f.aPriv),
        signatureB: signProtocolObject(SIGNING_DOMAIN.CLOSE, close, f.bPriv)
      },
      ckbAnchor: {
        txHash: `0x${"ab".repeat(32)}`,
        dataHex: buildAnchorDataHex(f.session.sessionId, close.transcriptRoot, close.finalStateHash, close.paymentEvidenceRoot)
      }
    };
    expect(verifyTranscript(transcript)).toEqual({ ok: true, errors: [] });
  });

  it("rejects closing a transcript containing a REJECT ACK", () => {
    const f = fixture();
    const event = signEvent({ sessionId: f.session.sessionId, sequence: 1, previousHash: ZERO_HASH, type: "WORK", payload: {}, sender: f.a, createdAt: new Date().toISOString() }, f.aPriv);
    const ack = signAck({ eventHash: event.eventHash, decision: "REJECT", operator: f.b, createdAt: new Date().toISOString() }, f.bPriv);
    const items = [{ event, ack }];
    const close = {
      sessionId: f.session.sessionId,
      eventCount: 1,
      transcriptRoot: computeTranscriptRoot(items),
      finalStateHash: finalStateHashFrom({ done: false }),
      fiberPayments: [],
      paymentEvidenceRoot: computePaymentEvidenceRoot(items),
      closedAt: new Date().toISOString()
    };
    const transcript: TranscriptExport = {
      session: signedSession(f),
      events: items,
      close: {
        close,
        finalState: { done: false },
        signatureA: signProtocolObject(SIGNING_DOMAIN.CLOSE, close, f.aPriv),
        signatureB: signProtocolObject(SIGNING_DOMAIN.CLOSE, close, f.bPriv)
      }
    };
    expect(verifyTranscript(transcript).errors).toContain("Close contains a rejected event");
  });

  it("detects a broken hash chain", () => {
    const f = fixture();
    const event = signEvent({ sessionId: f.session.sessionId, sequence: 1, previousHash: `0x${"11".repeat(32)}`, type: "WORK", payload: {}, sender: f.a, createdAt: new Date().toISOString() }, f.aPriv);
    const ack = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: f.b, createdAt: new Date().toISOString() }, f.bPriv);
    const transcript: TranscriptExport = { session: signedSession(f), events: [{ event, ack }] };
    expect(verifyTranscript(transcript).ok).toBe(false);
  });
});
