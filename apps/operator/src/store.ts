import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import {
  canonical,
  sha256Hex,
  SignedSessionSchema,
  SignedEventSchema,
  SignedAckSchema,
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
  sessions: Object.create(null),
  events: Object.create(null),
  conflicts: [],
  paymentClaims: Object.create(null),
  paymentEvidence: Object.create(null),
  outbox: Object.create(null)
});

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EVENTMESH_STATE_INVALID");
  return Object.assign(Object.create(null), value);
}

function parseState(raw: string): FileState {
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.nextOrder) || value.nextOrder < 1 || !Array.isArray(value.conflicts)) {
    throw new Error("EVENTMESH_STATE_INVALID");
  }

  // v0.6 hardens receiver observations by requiring an operator signature.
  // Older state files may contain unsigned evidence rows; do not accidentally
  // promote those rows to trusted signed evidence. The accepted payment claim
  // remains in paymentClaims/events and can still be exported in legacy mode.
  const paymentEvidence: Record<string, PaymentEvidenceRow> = {};
  const sessions = record(value.sessions ?? {});
  const events = record(value.events ?? {});
  const outbox = record(value.outbox ?? {});
  for (const [id, row] of Object.entries(sessions)) {
    if (!row || !SignedSessionSchema.safeParse(row.signed).success || row.signed.session.sessionId !== id
      || typeof row.status !== "string" || !Number.isSafeInteger(row.order)) {
      throw new Error("EVENTMESH_STATE_INVALID_SESSION");
    }
  }
  for (const [hash, row] of Object.entries(events)) {
    if (!row || !SignedEventSchema.safeParse(row.event).success
      || row.event.eventHash.toLowerCase() !== hash.toLowerCase()
      || typeof row.status !== "string"
      || (row.ack && !SignedAckSchema.safeParse(row.ack).success)) {
      throw new Error("EVENTMESH_STATE_INVALID_EVENT");
    }
  }
  for (const [id, row] of Object.entries(outbox)) {
    if (!row || row.id !== id || typeof row.sessionId !== "string"
      || !["EVENT", "ACK", "ANCHOR_NOTICE"].includes(row.kind)
      || !["PENDING", "DELIVERED"].includes(row.status)
      || !Number.isSafeInteger(row.attempts) || row.attempts < 0
      || typeof row.path !== "string" || !row.path.startsWith("/peer/sessions/")) {
      throw new Error("EVENTMESH_STATE_INVALID_OUTBOX");
    }
  }
  for (const [paymentHash, row] of Object.entries(record(value.paymentEvidence ?? {}))) {
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
    sessions,
    events,
    conflicts: value.conflicts,
    paymentClaims: record(value.paymentClaims ?? {}),
    paymentEvidence: record(paymentEvidence),
    outbox
  };
}

/**
 * Durable operator state without a database engine. Each mutation rewrites one
 * compact JSON document through a synced temp-file + atomic rename, with an
 * exclusive same-host writer lock. This is a single-host reference store, NOT
 * an alternative to a transactional database for multi-replica deployments.
 */
export class Store {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly lockId = randomUUID();
  private closed = false;
  private durableSnapshot = "";
  private state: FileState;

  constructor(path: string) {
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.acquireLock();
    try {
      try {
        const contents = readFileSync(this.path, "utf8");
        this.state = parseState(contents);
        this.durableSnapshot = JSON.stringify(this.state);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        this.state = emptyState();
        this.persist();
      }
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }

  private acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), id: this.lockId }));
          fsyncSync(fd);
        } finally { closeSync(fd); }
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        let owner: any;
        try { owner = JSON.parse(readFileSync(this.lockPath, "utf8")); }
        catch { throw new Error("EVENTMESH_STORE_LOCK_UNREADABLE"); }
        if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
          throw new Error("EVENTMESH_STORE_ALREADY_LOCKED");
        }
        try { process.kill(owner.pid, 0); throw new Error("EVENTMESH_STORE_ALREADY_LOCKED"); }
        catch (processError: any) {
          if (processError?.code !== "ESRCH") throw processError;
        }
        // Only clear a demonstrably dead process's lock on this same host.
        unlinkSync(this.lockPath);
      }
    }
    throw new Error("EVENTMESH_STORE_ALREADY_LOCKED");
  }

  private releaseLock() {
    try {
      const owner = JSON.parse(readFileSync(this.lockPath, "utf8"));
      if (owner.id === this.lockId) unlinkSync(this.lockPath);
    } catch { /* do not delete another process's lock */ }
  }

  private persist() {
    if (this.closed) throw new Error("EVENTMESH_STORE_CLOSED");
    const contents = `${JSON.stringify(this.state)}\n`;
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let renamed = false;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, contents, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
      renamed = true;
      // fsync the containing directory to make the rename durable on POSIX.
      if (process.platform !== "win32") {
        const dirFd = openSync(dirname(this.path), "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
      this.durableSnapshot = contents;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (!renamed && existsSync(tmp)) unlinkSync(tmp);
      // Prior to rename, no observable on-disk state changed. Roll back RAM.
      if (!renamed && this.durableSnapshot) this.state = parseState(this.durableSnapshot);
      // After rename the state may have committed; keep RAM consistent and
      // fail the request rather than falsely claiming a durable commit.
      if (renamed) this.durableSnapshot = contents;
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    try { this.persist(); }
    finally { this.closed = true; this.releaseLock(); }
  }

  getEventBySequence(sessionId: string, sequence: number) {
    const value = Object.values(this.state.events).find((row) => row.event.sessionId === sessionId && row.event.sequence === sequence);
    return value && structuredClone(value);
  }

  private conflict(sessionId: string, kind: ConflictEvidence["kind"], existing: unknown, incoming: unknown) {
    this.state.conflicts.push({ kind, existing, incoming, observedAt: new Date().toISOString(), sessionId });
    if (this.state.sessions[sessionId]) this.state.sessions[sessionId].status = "DISPUTED";
  }

  saveSession(session: SignedSession, status = "ACTIVE"): WriteResult {
    const sessionId = session.session.sessionId;
    const existing = this.state.sessions[sessionId];
    if (!existing) {
      this.state.sessions[sessionId] = { signed: structuredClone(session), status, order: this.state.nextOrder++ };
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
      signed: structuredClone(row.signed),
      status: row.status,
      closeProposal: row.closeProposal && structuredClone(row.closeProposal),
      close: row.close && structuredClone(row.close),
      anchor: row.anchor && structuredClone(row.anchor)
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
        session: structuredClone(row.signed.session),
        close: row.close && structuredClone(row.close),
        anchor: row.anchor && structuredClone(row.anchor)
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

    this.state.events[key] = { event: structuredClone(event), status };
    this.persist();
    return "INSERTED";
  }

  getEvent(eventHash: string) {
    const value = this.state.events[eventHash.toLowerCase()];
    return value && structuredClone(value);
  }

  listEvents(sessionId: string) {
    return Object.values(this.state.events)
      .filter((row) => row.event.sessionId === sessionId)
      .sort((a, b) => a.event.sequence - b.event.sequence)
      .map((row) => structuredClone(row));
  }

  saveAck(ack: SignedAck): WriteResult {
    const row = this.state.events[ack.eventHash.toLowerCase()];
    if (!row) return "NOT_FOUND";
    if (!row.ack) {
      row.ack = structuredClone(ack);
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
    existing.closeProposal = structuredClone(close);
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
    existing.close = structuredClone(close);
    existing.closeProposal ||= structuredClone(close);
    existing.status = "CLOSED";
    this.persist();
    return "INSERTED";
  }

  saveAnchor(sessionId: string, anchor: any): WriteResult {
    const existing = this.state.sessions[sessionId];
    if (!existing) return "NOT_FOUND";
    if (existing.anchor) {
      if (existing.anchor.txHash === anchor.txHash && existing.anchor.dataHex === anchor.dataHex) {
        existing.anchor = structuredClone(anchor);
        this.persist();
        return "IDEMPOTENT";
      }
      this.conflict(sessionId, "ANCHOR", existing.anchor, anchor);
      this.persist();
      return "CONFLICT";
    }
    existing.anchor = structuredClone(anchor);
    this.persist();
    return "INSERTED";
  }

  claimPayment(sessionId: string, claim: FiberPaymentClaim, eventHash: string): WriteResult {
    const paymentHash = claim.paymentHash.toLowerCase();
    const row = this.state.paymentClaims[paymentHash];
    if (!row) {
      this.state.paymentClaims[paymentHash] = { sessionId, eventHash: eventHash.toLowerCase(), claim: structuredClone(claim) };
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
      this.state.paymentEvidence[paymentHash] = { sessionId, eventHash: eventHash.toLowerCase(), evidence: structuredClone(evidence) };
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
      .map(([, row]) => structuredClone(row.evidence));
  }

  enqueueOutbox(input: Omit<OutboxRow, "status" | "attempts" | "createdAt" | "updatedAt">): OutboxRow {
    const existing = this.state.outbox[input.id];
    if (existing) {
      if (existing.sessionId !== input.sessionId || existing.path !== input.path || canonical(existing.body) !== canonical(input.body)) {
        throw new Error("OUTBOX_ID_CONFLICT");
      }
      return structuredClone(existing);
    }
    const now = new Date().toISOString();
    const row: OutboxRow = { ...structuredClone(input), status: "PENDING", attempts: 0, createdAt: now, updatedAt: now };
    this.state.outbox[input.id] = row;
    this.persist();
    return structuredClone(row);
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
    return structuredClone(row);
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
    return structuredClone(row);
  }

  listOutbox(status?: "PENDING" | "DELIVERED", sessionId?: string): OutboxRow[] {
    return Object.values(this.state.outbox)
      .filter((row) => (!status || row.status === status) && (!sessionId || row.sessionId === sessionId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((row) => structuredClone(row));
  }

  getOutbox(id: string): OutboxRow | undefined {
    const value = this.state.outbox[id];
    return value && structuredClone(value);
  }

  /** Bound delivery bookkeeping growth; signed event/ACK evidence is retained. */
  pruneDeliveredOutbox(keep = 2000, minAgeMs = 7 * 24 * 60 * 60 * 1000): number {
    const delivered = Object.values(this.state.outbox)
      .filter((row) => row.status === "DELIVERED")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const cutoff = Date.now() - minAgeMs;
    let removed = 0;
    for (const row of delivered.slice(keep)) {
      if (Date.parse(row.deliveredAt ?? row.updatedAt) < cutoff) {
        delete this.state.outbox[row.id];
        removed++;
      }
    }
    if (removed) this.persist();
    return removed;
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
      .map(({ sessionId: _sessionId, ...conflict }) => structuredClone(conflict));
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
