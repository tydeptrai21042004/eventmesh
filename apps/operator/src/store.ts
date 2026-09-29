import Database from "better-sqlite3";
import type { SignedAck, SignedClose, SignedEvent, SignedSession, TranscriptExport } from "@eventmesh/core";

export class Store {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        signed_session_json TEXT NOT NULL,
        status TEXT NOT NULL,
        signed_close_json TEXT,
        ckb_anchor_json TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        event_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        ack_json TEXT,
        status TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
    `);
  }

  saveSession(signed: SignedSession, status = "ACTIVE") {
    this.db.prepare(`INSERT INTO sessions(session_id,signed_session_json,status) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET signed_session_json=excluded.signed_session_json,status=excluded.status`)
      .run(signed.session.sessionId, JSON.stringify(signed), status);
  }

  getSession(id: string): { signed: SignedSession; status: string; close?: SignedClose; anchor?: { txHash: string; dataHex: string } } | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(id) as any;
    if (!row) return undefined;
    return {
      signed: JSON.parse(row.signed_session_json),
      status: row.status,
      close: row.signed_close_json ? JSON.parse(row.signed_close_json) : undefined,
      anchor: row.ckb_anchor_json ? JSON.parse(row.ckb_anchor_json) : undefined
    };
  }

  listSessions() {
    return (this.db.prepare("SELECT session_id,status,signed_session_json,signed_close_json,ckb_anchor_json FROM sessions ORDER BY rowid DESC").all() as any[]).map((row) => ({
      sessionId: row.session_id,
      status: row.status,
      session: JSON.parse(row.signed_session_json).session,
      close: row.signed_close_json ? JSON.parse(row.signed_close_json) : undefined,
      anchor: row.ckb_anchor_json ? JSON.parse(row.ckb_anchor_json) : undefined
    }));
  }

  saveEvent(event: SignedEvent, status = "PROPOSED") {
    this.db.prepare(`INSERT INTO events(event_hash,session_id,sequence,event_json,status) VALUES(?,?,?,?,?)
      ON CONFLICT(event_hash) DO NOTHING`).run(event.eventHash, event.sessionId, event.sequence, JSON.stringify(event), status);
  }

  getEvent(hash: string): { event: SignedEvent; ack?: SignedAck; status: string } | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE event_hash=?").get(hash) as any;
    if (!row) return undefined;
    return { event: JSON.parse(row.event_json), ack: row.ack_json ? JSON.parse(row.ack_json) : undefined, status: row.status };
  }

  listEvents(sessionId: string): Array<{ event: SignedEvent; ack?: SignedAck; status: string }> {
    return (this.db.prepare("SELECT * FROM events WHERE session_id=? ORDER BY sequence ASC").all(sessionId) as any[]).map((row) => ({
      event: JSON.parse(row.event_json),
      ack: row.ack_json ? JSON.parse(row.ack_json) : undefined,
      status: row.status
    }));
  }

  saveAck(ack: SignedAck) {
    this.db.prepare("UPDATE events SET ack_json=?, status=? WHERE event_hash=?").run(JSON.stringify(ack), ack.decision === "ACCEPT" ? "FINAL" : "REJECTED", ack.eventHash);
  }

  saveClose(sessionId: string, close: SignedClose) {
    this.db.prepare("UPDATE sessions SET signed_close_json=?, status='CLOSED' WHERE session_id=?").run(JSON.stringify(close), sessionId);
  }

  saveAnchor(sessionId: string, anchor: { txHash: string; dataHex: string }) {
    this.db.prepare("UPDATE sessions SET ckb_anchor_json=? WHERE session_id=?").run(JSON.stringify(anchor), sessionId);
  }

  exportTranscript(sessionId: string): TranscriptExport | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    return {
      session: session.signed,
      events: this.listEvents(sessionId).map(({ event, ack }) => ({ event, ack })),
      close: session.close,
      ckbAnchor: session.anchor
    };
  }
}
