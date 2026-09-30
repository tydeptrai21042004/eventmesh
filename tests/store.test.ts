import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL,
  SIGNING_DOMAIN,
  ZERO_HASH,
  computePaymentEvidenceRoot,
  computeTranscriptRoot,
  createSessionId,
  finalStateHashFrom,
  publicKeyFromPrivate,
  randomPrivateKeyHex,
  signAck,
  signEvent,
  signProtocolObject,
  type CloseBody,
  type FiberPaymentClaim,
  type Session,
  type SignedClose
} from "@eventmesh/core";
import { Store } from "../apps/operator/src/store.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function signedSession(aPriv: string, bPriv: string, overrides: Partial<Session> = {}) {
  const a = publicKeyFromPrivate(aPriv);
  const b = publicKeyFromPrivate(bPriv);
  const session: Session = {
    sessionId: createSessionId(),
    protocol: PROTOCOL,
    operatorA: a,
    operatorB: b,
    operatorAUrl: "http://a.local",
    operatorBUrl: "http://b.local",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxEvents: 10,
    ...overrides
  };
  return {
    session,
    signatureA: signProtocolObject(SIGNING_DOMAIN.SESSION, session, aPriv),
    signatureB: signProtocolObject(SIGNING_DOMAIN.SESSION, session, bPriv)
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "eventmesh-store-"));
  dirs.push(dir);
  const store = new Store(join(dir, "eventmesh-state.json"));
  const aPriv = randomPrivateKeyHex();
  const bPriv = randomPrivateKeyHex();
  const a = publicKeyFromPrivate(aPriv);
  const b = publicKeyFromPrivate(bPriv);
  const signed = signedSession(aPriv, bPriv);
  expect(store.saveSession(signed)).toBe("INSERTED");
  return { store, session: signed.session, signed, aPriv, bPriv, a, b };
}

function signedClose(sessionId: string, aPriv: string, bPriv: string, finalState: unknown): SignedClose {
  const close: CloseBody = {
    sessionId,
    eventCount: 0,
    transcriptRoot: computeTranscriptRoot([]),
    finalStateHash: finalStateHashFrom(finalState),
    fiberPayments: [],
    paymentEvidenceRoot: computePaymentEvidenceRoot([]),
    closedAt: new Date().toISOString()
  };
  return {
    close,
    finalState,
    signatureA: signProtocolObject(SIGNING_DOMAIN.CLOSE, close, aPriv),
    signatureB: signProtocolObject(SIGNING_DOMAIN.CLOSE, close, bPriv)
  };
}

describe("Store immutability and equivocation evidence", () => {
  it("never reopens a closed session on idempotent join replay", () => {
    const { store, session, signed, aPriv, bPriv } = setup();
    expect(store.saveClose(session.sessionId, signedClose(session.sessionId, aPriv, bPriv, { done: true }))).toBe("INSERTED");
    expect(store.saveSession(signed)).toBe("IDEMPOTENT");
    expect(store.getSession(session.sessionId)?.status).toBe("CLOSED");
    store.close();
  });

  it("preserves the first ACK and records a conflicting valid ACK", () => {
    const { store, session, aPriv, bPriv, a, b } = setup();
    const event = signEvent({
      sessionId: session.sessionId, sequence: 1, previousHash: ZERO_HASH,
      type: "WORK", payload: {}, sender: a, createdAt: new Date().toISOString()
    }, aPriv);
    expect(store.saveEvent(event)).toBe("INSERTED");
    const accept = signAck({ eventHash: event.eventHash, decision: "ACCEPT", operator: b, createdAt: new Date().toISOString() }, bPriv);
    const reject = signAck({ eventHash: event.eventHash, decision: "REJECT", operator: b, createdAt: new Date(Date.now() + 1).toISOString() }, bPriv);
    expect(store.saveAck(accept)).toBe("INSERTED");
    expect(store.saveAck(reject)).toBe("CONFLICT");
    expect(store.getEvent(event.eventHash)?.ack?.ackHash).toBe(accept.ackHash);
    expect(store.getSession(session.sessionId)?.status).toBe("DISPUTED");
    expect(store.listConflicts(session.sessionId).filter((conflict) => conflict.kind === "ACK")).toHaveLength(1);
    store.close();
  });

  it("distinguishes same-sender equivocation from cross-sender proposal collision", () => {
    const { store, session, aPriv, bPriv, a, b } = setup();
    const first = signEvent({
      sessionId: session.sessionId, sequence: 1, previousHash: ZERO_HASH,
      type: "A", payload: {}, sender: a, createdAt: new Date().toISOString()
    }, aPriv);
    const equivocation = signEvent({
      sessionId: session.sessionId, sequence: 1, previousHash: ZERO_HASH,
      type: "B", payload: {}, sender: a, createdAt: new Date(Date.now() + 1).toISOString()
    }, aPriv);
    expect(store.saveEvent(first)).toBe("INSERTED");
    expect(store.saveEvent(equivocation)).toBe("CONFLICT");
    expect(store.listConflicts(session.sessionId).some((conflict) => conflict.kind === "EVENT")).toBe(true);

    const dir2 = mkdtempSync(join(tmpdir(), "eventmesh-collision-"));
    dirs.push(dir2);
    const collisionStore = new Store(join(dir2, "eventmesh-state.json"));
    expect(collisionStore.saveSession(signedSession(aPriv, bPriv, { sessionId: session.sessionId }))).toBe("INSERTED");
    expect(collisionStore.saveEvent(first)).toBe("INSERTED");
    const collision = signEvent({
      sessionId: session.sessionId, sequence: 1, previousHash: ZERO_HASH,
      type: "FROM_B", payload: {}, sender: b, createdAt: new Date(Date.now() + 2).toISOString()
    }, bPriv);
    expect(collisionStore.saveEvent(collision)).toBe("CONFLICT");
    expect(collisionStore.listConflicts(session.sessionId).some((conflict) => conflict.kind === "PROPOSAL_COLLISION")).toBe(true);
    collisionStore.close();
    store.close();
  });

  it("makes close immutable and marks a conflicting close as disputed", () => {
    const { store, session, aPriv, bPriv } = setup();
    const c1 = signedClose(session.sessionId, aPriv, bPriv, { n: 1 });
    const c2 = signedClose(session.sessionId, aPriv, bPriv, { n: 2 });
    expect(store.saveClose(session.sessionId, c1)).toBe("INSERTED");
    expect(store.saveClose(session.sessionId, c2)).toBe("CONFLICT");
    expect(store.getSession(session.sessionId)?.close?.close.finalStateHash).toBe(c1.close.finalStateHash);
    expect(store.getSession(session.sessionId)?.status).toBe("DISPUTED");
    store.close();
  });

  it("prevents one Fiber payment hash from satisfying two sessions", () => {
    const { store, session, aPriv, bPriv } = setup();
    const second = signedSession(aPriv, bPriv);
    expect(store.saveSession(second)).toBe("INSERTED");
    const paymentHash = `0x${"ab".repeat(32)}`;
    const claim1: FiberPaymentClaim = { paymentHash, sessionId: session.sessionId, amount: "1000", currency: "Fibt" };
    const claim2: FiberPaymentClaim = { paymentHash, sessionId: second.session.sessionId, amount: "1000", currency: "Fibt" };
    expect(store.claimPayment(session.sessionId, claim1, `0x${"11".repeat(32)}`)).toBe("INSERTED");
    expect(store.claimPayment(second.session.sessionId, claim2, `0x${"22".repeat(32)}`)).toBe("CONFLICT");
    expect(store.getSession(session.sessionId)?.status).toBe("DISPUTED");
    expect(store.getSession(second.session.sessionId)?.status).toBe("DISPUTED");
    store.close();
  });
});
