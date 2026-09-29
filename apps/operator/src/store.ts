import Database from "better-sqlite3";
import {
  canonical,
  type ConflictEvidence,
  type FiberPaymentClaim,
  type FiberPaymentEvidence,
  type SignedAck,
  type SignedClose,
  type SignedEvent,
  type SignedSession,
  type TranscriptExport
} from "@eventmesh/core";

export type WriteResult = "INSERTED" | "IDEMPOTENT" | "CONFLICT" | "NOT_FOUND";

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        session_id TEXT PRIMARY KEY,
        signed_session_json TEXT NOT NULL,
        status TEXT NOT NULL,
        close_proposal_json TEXT,
        signed_close_json TEXT,
        ckb_anchor_json TEXT
      );
      CREATE TABLE IF NOT EXISTS events(
        event_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        ack_json TEXT,
        status TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS conflicts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        existing_json TEXT NOT NULL,
        incoming_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_claims(
        payment_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        claim_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_evidence(
        payment_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_hash TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        verified_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_conflicts_session ON conflicts(session_id);
      CREATE INDEX IF NOT EXISTS idx_payment_evidence_session ON payment_evidence(session_id);
    `);
  }

  close() {
    this.db.close();
  }

  getEventBySequence(sessionId: string, sequence: number) {
    const row = this.db.prepare("SELECT * FROM events WHERE session_id=? AND sequence=?").get(sessionId, sequence) as any;
    if (!row) return undefined;
    return {
      event: JSON.parse(row.event_json) as SignedEvent,
      ack: row.ack_json ? JSON.parse(row.ack_json) as SignedAck : undefined,
      status: row.status as string
    };
  }

  private conflict(sessionId: string, kind: ConflictEvidence["kind"], existing: unknown, incoming: unknown) {
    this.db.prepare(
      "INSERT INTO conflicts(session_id,kind,existing_json,incoming_json,observed_at) VALUES(?,?,?,?,?)"
    ).run(sessionId, kind, JSON.stringify(existing), JSON.stringify(incoming), new Date().toISOString());
    this.db.prepare("UPDATE sessions SET status='DISPUTED' WHERE session_id=?").run(sessionId);
  }

  saveSession(session: SignedSession, status = "ACTIVE"): WriteResult {
    const existing = this.getSession(session.session.sessionId);
    if (!existing) {
      this.db.prepare("INSERT INTO sessions(session_id,signed_session_json,status) VALUES(?,?,?)")
        .run(session.session.sessionId, JSON.stringify(session), status);
      return "INSERTED";
    }
    if (canonical(existing.signed.session) === canonical(session.session) && existing.signed.signatureA === session.signatureA) {
      if (!existing.signed.signatureB && session.signatureB) {
        this.db.prepare("UPDATE sessions SET signed_session_json=? WHERE session_id=?")
          .run(JSON.stringify({ ...existing.signed, signatureB: session.signatureB }), session.session.sessionId);
      }
      return "IDEMPOTENT";
    }
    this.conflict(session.session.sessionId, "SESSION", existing.signed, session);
    return "CONFLICT";
  }

  getSession(sessionId: string) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as any;
    if (!row) return undefined;
    return {
      signed: JSON.parse(row.signed_session_json) as SignedSession,
      status: row.status as string,
      closeProposal: row.close_proposal_json ? JSON.parse(row.close_proposal_json) : undefined,
      close: row.signed_close_json ? JSON.parse(row.signed_close_json) : undefined,
      anchor: row.ckb_anchor_json ? JSON.parse(row.ckb_anchor_json) : undefined
    };
  }

  listSessions() {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY rowid DESC").all() as any[]).map((row) => ({
      sessionId: row.session_id,
      status: row.status,
      session: JSON.parse(row.signed_session_json).session,
      close: row.signed_close_json ? JSON.parse(row.signed_close_json) : undefined,
      anchor: row.ckb_anchor_json ? JSON.parse(row.ckb_anchor_json) : undefined
    }));
  }

  saveEvent(event: SignedEvent, status = "PROPOSED"): WriteResult {
    const byHash = this.getEvent(event.eventHash);
    if (byHash) return canonical(byHash.event) === canonical(event) ? "IDEMPOTENT" : "CONFLICT";

    const sameSequence = this.db.prepare(
      "SELECT event_json FROM events WHERE session_id=? AND sequence=?"
    ).get(event.sessionId, event.sequence) as any;
    if (sameSequence) {
      const existing = JSON.parse(sameSequence.event_json) as SignedEvent;
      const kind: ConflictEvidence["kind"] = existing.sender === event.sender ? "EVENT" : "PROPOSAL_COLLISION";
      this.conflict(event.sessionId, kind, existing, event);
      return "CONFLICT";
    }

    this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)")
      .run(event.eventHash, event.sessionId, event.sequence, JSON.stringify(event), null, status);
    return "INSERTED";
  }

  getEvent(eventHash: string) {
    const row = this.db.prepare("SELECT * FROM events WHERE event_hash=?").get(eventHash) as any;
    if (!row) return undefined;
    return {
      event: JSON.parse(row.event_json) as SignedEvent,
      ack: row.ack_json ? JSON.parse(row.ack_json) as SignedAck : undefined,
      status: row.status as string
    };
  }

  listEvents(sessionId: string) {
    return (this.db.prepare("SELECT * FROM events WHERE session_id=? ORDER BY sequence").all(sessionId) as any[]).map((row) => ({
      event: JSON.parse(row.event_json) as SignedEvent,
      ack: row.ack_json ? JSON.parse(row.ack_json) as SignedAck : undefined,
      status: row.status as string
    }));
  }

  saveAck(ack: SignedAck): WriteResult {
    const row = this.db.prepare("SELECT session_id,ack_json FROM events WHERE event_hash=?").get(ack.eventHash) as any;
    if (!row) return "NOT_FOUND";
    if (!row.ack_json) {
      this.db.prepare("UPDATE events SET ack_json=?,status='FINAL' WHERE event_hash=?")
        .run(JSON.stringify(ack), ack.eventHash);
      return "INSERTED";
    }
    const existing = JSON.parse(row.ack_json) as SignedAck;
    if (canonical(existing) === canonical(ack)) return "IDEMPOTENT";
    this.conflict(row.session_id, "ACK", existing, ack);
    return "CONFLICT";
  }

  saveCloseProposal(sessionId: string, close: SignedClose): WriteResult {
    const existing = this.getSession(sessionId);
    if (!existing) return "NOT_FOUND";
    if (existing.closeProposal) {
      if (canonical(existing.closeProposal) === canonical(close)) return "IDEMPOTENT";
      this.conflict(sessionId, "CLOSE", existing.closeProposal, close);
      return "CONFLICT";
    }
    this.db.prepare("UPDATE sessions SET close_proposal_json=?,status='CLOSING' WHERE session_id=?")
      .run(JSON.stringify(close), sessionId);
    return "INSERTED";
  }

  saveClose(sessionId: string, close: SignedClose): WriteResult {
    const existing = this.getSession(sessionId);
    if (!existing) return "NOT_FOUND";
    if (existing.close) {
      if (canonical(existing.close) === canonical(close)) return "IDEMPOTENT";
      this.conflict(sessionId, "CLOSE", existing.close, close);
      return "CONFLICT";
    }
    this.db.prepare(
      "UPDATE sessions SET signed_close_json=?,close_proposal_json=COALESCE(close_proposal_json,?),status='CLOSED' WHERE session_id=?"
    ).run(JSON.stringify(close), JSON.stringify(close), sessionId);
    return "INSERTED";
  }

  saveAnchor(sessionId: string, anchor: any): WriteResult {
    const existing = this.getSession(sessionId);
    if (!existing) return "NOT_FOUND";
    if (existing.anchor) {
      if (existing.anchor.txHash === anchor.txHash && existing.anchor.dataHex === anchor.dataHex) {
        this.db.prepare("UPDATE sessions SET ckb_anchor_json=? WHERE session_id=?")
          .run(JSON.stringify(anchor), sessionId);
        return "IDEMPOTENT";
      }
      this.conflict(sessionId, "ANCHOR", existing.anchor, anchor);
      return "CONFLICT";
    }
    this.db.prepare("UPDATE sessions SET ckb_anchor_json=? WHERE session_id=?")
      .run(JSON.stringify(anchor), sessionId);
    return "INSERTED";
  }

  claimPayment(sessionId: string, claim: FiberPaymentClaim, eventHash: string): WriteResult {
    const paymentHash = claim.paymentHash.toLowerCase();
    const row = this.db.prepare("SELECT * FROM payment_claims WHERE payment_hash=?").get(paymentHash) as any;
    if (!row) {
      this.db.prepare("INSERT INTO payment_claims VALUES(?,?,?,?)")
        .run(paymentHash, sessionId, eventHash.toLowerCase(), JSON.stringify(claim));
      return "INSERTED";
    }
    if (
      row.session_id === sessionId
      && row.event_hash === eventHash.toLowerCase()
      && canonical(JSON.parse(row.claim_json)) === canonical(claim)
    ) return "IDEMPOTENT";

    this.conflict(sessionId, "PAYMENT", row, { sessionId, eventHash, claim });
    if (row.session_id && row.session_id !== sessionId) {
      this.db.prepare("UPDATE sessions SET status='DISPUTED' WHERE session_id=?").run(row.session_id);
    }
    return "CONFLICT";
  }

  savePaymentEvidence(sessionId: string, eventHash: string, evidence: FiberPaymentEvidence): WriteResult {
    const paymentHash = evidence.claim.paymentHash.toLowerCase();
    const row = this.db.prepare("SELECT * FROM payment_evidence WHERE payment_hash=?").get(paymentHash) as any;
    if (!row) {
      this.db.prepare("INSERT INTO payment_evidence VALUES(?,?,?,?,?)")
        .run(paymentHash, sessionId, eventHash.toLowerCase(), JSON.stringify(evidence), evidence.verifiedAt);
      return "INSERTED";
    }
    const previous = JSON.parse(row.evidence_json) as FiberPaymentEvidence;
    const stableIdentity = (item: FiberPaymentEvidence) => canonical({
      claim: item.claim,
      verifier: item.verifier,
      invoiceStatus: item.invoiceStatus,
      payeePublicKey: item.payeePublicKey,
      observedUdtTypeScript: item.observedUdtTypeScript
    });
    if (
      row.session_id === sessionId
      && row.event_hash === eventHash.toLowerCase()
      && stableIdentity(previous) === stableIdentity(evidence)
    ) {
      // Re-verification after a crash/retry is idempotent even though verifiedAt changes.
      this.db.prepare("UPDATE payment_evidence SET evidence_json=?,verified_at=? WHERE payment_hash=?")
        .run(JSON.stringify(evidence), evidence.verifiedAt, paymentHash);
      return "IDEMPOTENT";
    }
    this.conflict(sessionId, "PAYMENT", previous, evidence);
    return "CONFLICT";
  }

  listPaymentEvidence(sessionId: string): FiberPaymentEvidence[] {
    return (this.db.prepare(
      "SELECT evidence_json FROM payment_evidence WHERE session_id=? ORDER BY payment_hash"
    ).all(sessionId) as any[]).map((row) => JSON.parse(row.evidence_json) as FiberPaymentEvidence);
  }

  listConflicts(sessionId: string): ConflictEvidence[] {
    return (this.db.prepare(
      "SELECT kind,existing_json,incoming_json,observed_at FROM conflicts WHERE session_id=? ORDER BY id"
    ).all(sessionId) as any[]).map((row) => ({
      kind: row.kind,
      existing: JSON.parse(row.existing_json),
      incoming: JSON.parse(row.incoming_json),
      observedAt: row.observed_at
    }));
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
