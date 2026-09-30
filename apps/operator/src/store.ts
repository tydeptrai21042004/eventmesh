import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonical,
  sha256Hex,
  SignedFiberPaymentEvidenceSchema,
  type ConflictEvidence,
  type FiberPaymentClaim,
  type SignedFiberPaymentEvidence,
  type SignedAck,
  type SignedClose,
  type SignedEvent,
  type SignedSession,
  type TranscriptExport
} from "@eventmesh/core";

export type WriteResult = "INSERTED" | "IDEMPOTENT" | "CONFLICT" | "NOT_FOUND";

type SessionRow = {
  signed: SignedSession;
  status: string;
  closeProposal?: SignedClose;
  close?: SignedClose;
  anchor?: any;
  order: number;
};

type EventRow = {
  event: SignedEvent;
  ack?: SignedAck;
  status: string;
};

type PaymentClaimRow = {
  sessionId: string;
  eventHash: string;
  claim: FiberPaymentClaim;
};

type PaymentEvidenceRow = {
  sessionId: string;
  eventHash: string;
  evidence: SignedFiberPaymentEvidence;
};

export type OutboxKind = "EVENT" | "ACK" | "ANCHOR_NOTICE";
export type OutboxRow = {
  id: string;
  sessionId: string;
  kind: OutboxKind;
  path: string;
  body: unknown;
  status: "PENDING" | "DELIVERED";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
};

type FileState = {
  version: 1;
  nextOrder: number;
  sessions: Record<string, SessionRow>;
  events: Record<string, EventRow>;
  conflicts: Array<ConflictEvidence & { sessionId: string }>;
  paymentClaims: Record<string, PaymentClaimRow>;
  paymentEvidence: Record<string, PaymentEvidenceRow>;
  outbox: Record<string, OutboxRow>;
};

const emptyState = (): FileState => ({
  version: 1,
  nextOrder: 1,
  sessions: {},
  events: {},
  conflicts: [],
  paymentClaims: {},
  paymentEvidence: {},
  outbox: {}
});

function parseState(raw: string): FileState {
  const value = JSON.parse(raw);
  if (!value || value.version !== 1) throw new Error("EVENTMESH_STATE_INVALID");

  // v0.6 hardens receiver observations by requiring an operator signature.
  // Older state files may contain unsigned evidence rows; do not accidentally
  // promote those rows to trusted signed evidence. The accepted payment claim
  // remains in paymentClaims/events and can still be exported in legacy mode.
  const paymentEvidence: Record<string, PaymentEvidenceRow> = {};
  for (const [paymentHash, row] of Object.entries(value.paymentEvidence || {})) {
    const candidate = (row as any)?.evidence;
    const parsed = SignedFiberPaymentEvidenceSchema.safeParse(candidate);
    if (parsed.success) {
      paymentEvidence[paymentHash] = {
        ...(row as any),
        evidence: parsed.data
      };
    }
  }

  return {
    ...emptyState(),
    ...value,
    sessions: value.sessions || {},
    events: value.events || {},
    conflicts: value.conflicts || [],
    paymentClaims: value.paymentClaims || {},
    paymentEvidence,
    outbox: value.outbox || {}
  };
}

/**
 * Durable operator state without a database engine. Each mutation rewrites one
 * compact JSON document through temp-file + rename, which is sufficient for the
 * single-process reference operator deployment model.
 */
export class Store {
  private readonly path: string;
  private state: FileState;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.state = parseState(readFileSync(this.path, "utf8"));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.state = emptyState();
      this.persist();
    }
  }

  private persist() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  }

  close() {
    this.persist();
  }

  getEventBySequence(sessionId: string, sequence: number) {
    return Object.values(this.state.events).find((row) => row.event.sessionId === sessionId && row.event.sequence === sequence);
  }

  private conflict(sessionId: string, kind: ConflictEvidence["kind"], existing: unknown, incoming: unknown) {
    this.state.conflicts.push({ kind, existing, incoming, observedAt: new Date().toISOString(), sessionId });
    if (this.state.sessions[sessionId]) this.state.sessions[sessionId].status = "DISPUTED";
  }

  saveSession(session: SignedSession, status = "ACTIVE"): WriteResult {
    const sessionId = session.session.sessionId;
    const existing = this.state.sessions[sessionId];
    if (!existing) {
      this.state.sessions[sessionId] = { signed: session, status, order: this.state.nextOrder++ };
      this.persist();
      return "INSERTED";
    }
    if (canonical(existing.signed.session) === canonical(session.session) && existing.signed.signatureA === session.signatureA) {
      if (existing.signed.signatureB && session.signatureB && existing.signed.signatureB !== session.signatureB) {
        this.conflict(sessionId, "SESSION", existing.signed, session);
        this.persist();
        return "CONFLICT";
      }
      if (!existing.signed.signatureB && session.signatureB) {
        existing.signed = { ...existing.signed, signatureB: session.signatureB };
        if (existing.status === "CREATING") existing.status = "ACTIVE";
        this.persist();
      }
      return "IDEMPOTENT";
    }
    this.conflict(sessionId, "SESSION", existing.signed, session);
    this.persist();
    return "CONFLICT";
  }

  getSession(sessionId: string) {
    const row = this.state.sessions[sessionId];
    if (!row) return undefined;
    return {
      signed: row.signed,
      status: row.status,
      closeProposal: row.closeProposal,
      close: row.close,
      anchor: row.anchor
    };
  }

  setSessionStatus(sessionId: string, status: string): WriteResult {
    const row = this.state.sessions[sessionId];
    if (!row) return "NOT_FOUND";
    if (row.status === status) return "IDEMPOTENT";
    if (row.status === "DISPUTED" && status !== "DISPUTED") return "CONFLICT";
    row.status = status;
    this.persist();
    return "INSERTED";
  }

  listSessions() {
    return Object.entries(this.state.sessions)
      .sort(([, a], [, b]) => b.order - a.order)
      .map(([sessionId, row]) => ({
        sessionId,
        status: row.status,
        session: row.signed.session,
        close: row.close,
        anchor: row.anchor
      }));
  }

  saveEvent(event: SignedEvent, status = "PROPOSED"): WriteResult {
    const key = event.eventHash.toLowerCase();
    const byHash = this.state.events[key];
    if (byHash) return canonical(byHash.event) === canonical(event) ? "IDEMPOTENT" : "CONFLICT";

    const sameSequence = this.getEventBySequence(event.sessionId, event.sequence);
    if (sameSequence) {
      const kind: ConflictEvidence["kind"] = sameSequence.event.sender === event.sender ? "EVENT" : "PROPOSAL_COLLISION";
      this.conflict(event.sessionId, kind, sameSequence.event, event);
      this.persist();
      return "CONFLICT";
    }

    this.state.events[key] = { event, status };
    this.persist();
    return "INSERTED";
  }

  getEvent(eventHash: string) {
    return this.state.events[eventHash.toLowerCase()];
  }

  listEvents(sessionId: string) {
    return Object.values(this.state.events)
      .filter((row) => row.event.sessionId === sessionId)
      .sort((a, b) => a.event.sequence - b.event.sequence);
  }

  saveAck(ack: SignedAck): WriteResult {
    const row = this.state.events[ack.eventHash.toLowerCase()];
    if (!row) return "NOT_FOUND";
    if (!row.ack) {
      row.ack = ack;
      row.status = "FINAL";
      this.persist();
      return "INSERTED";
    }
    if (canonical(row.ack) === canonical(ack)) return "IDEMPOTENT";
    this.conflict(row.event.sessionId, "ACK", row.ack, ack);
    this.persist();
    return "CONFLICT";
  }

  saveCloseProposal(sessionId: string, close: SignedClose): WriteResult {
    const existing = this.state.sessions[sessionId];
    if (!existing) return "NOT_FOUND";
    if (existing.closeProposal) {
      if (canonical(existing.closeProposal) === canonical(close)) return "IDEMPOTENT";
      this.conflict(sessionId, "CLOSE", existing.closeProposal, close);
      this.persist();
      return "CONFLICT";
    }
    existing.closeProposal = close;
    existing.status = "CLOSING";
    this.persist();
    return "INSERTED";
  }

  saveClose(sessionId: string, close: SignedClose): WriteResult {
    const existing = this.state.sessions[sessionId];
    if (!existing) return "NOT_FOUND";
    if (existing.close) {
      if (canonical(existing.close) === canonical(close)) return "IDEMPOTENT";
      this.conflict(sessionId, "CLOSE", existing.close, close);
      this.persist();
      return "CONFLICT";
    }
    existing.close = close;
    existing.closeProposal ||= close;
    existing.status = "CLOSED";
    this.persist();
    return "INSERTED";
  }

  saveAnchor(sessionId: string, anchor: any): WriteResult {
    const existing = this.state.sessions[sessionId];
    if (!existing) return "NOT_FOUND";
    if (existing.anchor) {
      if (existing.anchor.txHash === anchor.txHash && existing.anchor.dataHex === anchor.dataHex) {
        existing.anchor = anchor;
        this.persist();
        return "IDEMPOTENT";
      }
      this.conflict(sessionId, "ANCHOR", existing.anchor, anchor);
      this.persist();
      return "CONFLICT";
    }
    existing.anchor = anchor;
    this.persist();
    return "INSERTED";
  }

  claimPayment(sessionId: string, claim: FiberPaymentClaim, eventHash: string): WriteResult {
    const paymentHash = claim.paymentHash.toLowerCase();
    const row = this.state.paymentClaims[paymentHash];
    if (!row) {
      this.state.paymentClaims[paymentHash] = { sessionId, eventHash: eventHash.toLowerCase(), claim };
      this.persist();
      return "INSERTED";
    }
    if (row.sessionId === sessionId && row.eventHash === eventHash.toLowerCase() && canonical(row.claim) === canonical(claim)) {
      return "IDEMPOTENT";
    }

    this.conflict(sessionId, "PAYMENT", row, { sessionId, eventHash, claim });
    if (row.sessionId !== sessionId && this.state.sessions[row.sessionId]) this.state.sessions[row.sessionId].status = "DISPUTED";
    this.persist();
    return "CONFLICT";
  }

  savePaymentEvidence(sessionId: string, eventHash: string, evidence: SignedFiberPaymentEvidence): WriteResult {
    const paymentHash = evidence.evidence.claim.paymentHash.toLowerCase();
    const row = this.state.paymentEvidence[paymentHash];
    if (!row) {
      this.state.paymentEvidence[paymentHash] = { sessionId, eventHash: eventHash.toLowerCase(), evidence };
      this.persist();
      return "INSERTED";
    }
    // verifiedAt/signature may change when the same receiver re-checks an invoice
    // after a crash. Treat the stable observed facts as the idempotency identity.
    const stableIdentity = (item: SignedFiberPaymentEvidence) => canonical({
      observer: item.observer,
      claim: item.evidence.claim,
      verifier: item.evidence.verifier,
      invoiceStatus: item.evidence.invoiceStatus,
      payeePublicKey: item.evidence.payeePublicKey,
      observedUdtTypeScript: item.evidence.observedUdtTypeScript
    });
    if (row.sessionId === sessionId && row.eventHash === eventHash.toLowerCase() && stableIdentity(row.evidence) === stableIdentity(evidence)) {
      return "IDEMPOTENT";
    }
    this.conflict(sessionId, "PAYMENT", row.evidence, evidence);
    this.persist();
    return "CONFLICT";
  }

  listPaymentEvidence(sessionId: string): SignedFiberPaymentEvidence[] {
    return Object.entries(this.state.paymentEvidence)
      .filter(([, row]) => row.sessionId === sessionId)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row.evidence);
  }

  enqueueOutbox(input: Omit<OutboxRow, "status" | "attempts" | "createdAt" | "updatedAt">): OutboxRow {
    const existing = this.state.outbox[input.id];
    if (existing) {
      if (existing.sessionId !== input.sessionId || existing.path !== input.path || canonical(existing.body) !== canonical(input.body)) {
        throw new Error("OUTBOX_ID_CONFLICT");
      }
      return existing;
    }
    const now = new Date().toISOString();
    const row: OutboxRow = { ...input, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now };
    this.state.outbox[input.id] = row;
    this.persist();
    return row;
  }

  markOutboxAttempt(id: string, error?: string): OutboxRow | undefined {
    const row = this.state.outbox[id];
    if (!row) return undefined;
    const now = new Date().toISOString();
    row.attempts += 1;
    row.lastAttemptAt = now;
    row.updatedAt = now;
    if (error) row.lastError = error;
    else delete row.lastError;
    this.persist();
    return row;
  }

  markOutboxDelivered(id: string): OutboxRow | undefined {
    const row = this.state.outbox[id];
    if (!row) return undefined;
    const now = new Date().toISOString();
    row.status = "DELIVERED";
    row.deliveredAt = now;
    row.updatedAt = now;
    delete row.lastError;
    this.persist();
    return row;
  }

  listOutbox(status?: "PENDING" | "DELIVERED", sessionId?: string): OutboxRow[] {
    return Object.values(this.state.outbox)
      .filter((row) => (!status || row.status === status) && (!sessionId || row.sessionId === sessionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  sessionHead(sessionId: string) {
    const session = this.state.sessions[sessionId];
    if (!session) return undefined;
    const events = this.listEvents(sessionId);
    return {
      sessionId,
      status: session.status,
      protocol: session.signed.session.protocol,
      eventCount: events.length,
      lastEventHash: events.at(-1)?.event.eventHash ?? null,
      entries: events.map((row) => ({
        sequence: row.event.sequence,
        eventHash: row.event.eventHash,
        ackHash: row.ack?.ackHash ?? null,
        decision: row.ack?.decision ?? null,
        status: row.status
      })),
      closeHash: session.close ? sha256Hex(canonical(session.close.close)) : null,
      anchorTxHash: session.anchor?.txHash ?? null
    };
  }

  listConflicts(sessionId: string): ConflictEvidence[] {
    return this.state.conflicts
      .filter((row) => row.sessionId === sessionId)
      .map(({ sessionId: _sessionId, ...conflict }) => conflict);
  }

  exportTranscript(sessionId: string): TranscriptExport | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const conflicts = this.listConflicts(sessionId);
    const paymentEvidence = this.listPaymentEvidence(sessionId);
    return {
      session: session.signed,
      events: this.listEvents(sessionId).map((item) => ({ event: item.event, ack: item.ack })),
      close: session.close,
      ...(paymentEvidence.length ? { paymentEvidence } : {}),
      ckbAnchor: session.anchor,
      ...(conflicts.length ? { conflicts } : {})
    };
  }
}
