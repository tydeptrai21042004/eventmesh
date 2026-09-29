import { describe, expect, it } from "vitest";
import {
  PROTOCOL,
  SIGNING_DOMAIN,
  ZERO_HASH,
  publicKeyFromPrivate,
  signAck,
  signEvent,
  signProtocolObject,
  type SignedAck,
  type SignedEvent,
  type TranscriptExport
} from "@eventmesh/core";
import { paidServiceReferenceAdapter, validateTranscriptWithAdapter } from "@eventmesh/adapter-sdk";

const keyA = `0x${"01".repeat(32)}`;
const keyB = `0x${"02".repeat(32)}`;
const operatorA = publicKeyFromPrivate(keyA);
const operatorB = publicKeyFromPrivate(keyB);
const sessionId = "ses_adapter_test";

function buildTranscript(): TranscriptExport {
  const createdAt = "2026-09-29T12:00:00.000Z";
  const session = {
    sessionId,
    protocol: PROTOCOL,
    operatorA,
    operatorB,
    operatorAUrl: "https://operator-a.example",
    operatorBUrl: "https://operator-b.example",
    createdAt,
    expiresAt: "2026-09-29T13:00:00.000Z",
    maxEvents: 20
  } as const;
  const signedSession = {
    session,
    signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, session, keyA),
    signatureB: signProtocolObject(SIGNING_DOMAIN.SESSION, session, keyB)
  };

  const rows: Array<{ event: SignedEvent; ack: SignedAck }> = [];
  const append = (type: string, payload: unknown, senderKey: string, sender: string, ackKey: string, ackOperator: string) => {
    const event = signEvent({
      sessionId,
      sequence: rows.length + 1,
      previousHash: rows.at(-1)?.event.eventHash ?? ZERO_HASH,
      type,
      payload,
      sender,
      createdAt: new Date(Date.parse(createdAt) + rows.length * 1000).toISOString()
    }, senderKey);
    const ack = signAck({
      eventHash: event.eventHash,
      decision: "ACCEPT",
      operator: ackOperator,
      createdAt: new Date(Date.parse(createdAt) + rows.length * 1000 + 500).toISOString()
    }, ackKey);
    rows.push({ event, ack });
  };

  const requestId = "req-001";
  append("SERVICE_REQUESTED", { requestId, service: "dataset-transform" }, keyA, operatorA, keyB, operatorB);
  append("SERVICE_ACCEPTED", { requestId }, keyB, operatorB, keyA, operatorA);
  append("RESULT_COMMITTED", { requestId, resultHash: `0x${"ab".repeat(32)}` }, keyB, operatorB, keyA, operatorA);
  append("PAYMENT_SETTLED", {
    paymentHash: `0x${"cd".repeat(32)}`,
    sessionId,
    amount: "100000000",
    currency: "Fibt"
  }, keyA, operatorA, keyB, operatorB);
  append("SESSION_COMPLETED", { requestId }, keyB, operatorB, keyA, operatorA);

  return { session: signedSession, events: rows };
}

describe("paid-service reference adapter", () => {
  it("validates one complete payment-linked reconciliation flow and derives deterministic state", () => {
    const result = validateTranscriptWithAdapter(buildTranscript(), paidServiceReferenceAdapter);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.finalState).toEqual({
      kind: "paid-service",
      requestId: "req-001",
      service: "dataset-transform",
      resultHash: `0x${"ab".repeat(32)}`,
      paymentHash: `0x${"cd".repeat(32)}`,
      completed: true
    });
  });

  it("rejects a transcript whose business events are out of order", () => {
    const transcript = buildTranscript();
    [transcript.events[1], transcript.events[2]] = [transcript.events[2], transcript.events[1]];
    const result = validateTranscriptWithAdapter(transcript, paidServiceReferenceAdapter);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("expected ordered events");
  });
});
