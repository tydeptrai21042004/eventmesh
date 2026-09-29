import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOperatorApp } from "../apps/operator/src/app.js";
import { signAck, verifyTranscript, type SignedSession } from "@eventmesh/core";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function pair() {
  const root = mkdtempSync(join(tmpdir(), "eventmesh-int-"));
  const aPort = await freePort();
  const bPort = await freePort();
  const aUrl = `http://127.0.0.1:${aPort}`;
  const bUrl = `http://127.0.0.1:${bPort}`;
  const b = await buildOperatorApp({
    name: "operator-b", selfUrl: bUrl, dataDir: join(root, "b"),
    defaultPeerUrl: aUrl, allowPrivatePeerUrls: true
  });
  const a = await buildOperatorApp({
    name: "operator-a", selfUrl: aUrl, dataDir: join(root, "a"),
    defaultPeerUrl: bUrl, allowPrivatePeerUrls: true
  });
  await b.app.listen({ host: "127.0.0.1", port: bPort });
  await a.app.listen({ host: "127.0.0.1", port: aPort });
  cleanups.push(async () => {
    await Promise.allSettled([a.app.close(), b.app.close()]);
    rmSync(root, { recursive: true, force: true });
  });
  return { a, b };
}

async function createSession(a: Awaited<ReturnType<typeof buildOperatorApp>>): Promise<SignedSession> {
  const response = await a.app.inject({ method: "POST", url: "/admin/sessions", payload: {} });
  expect(response.statusCode).toBe(201);
  return response.json() as SignedSession;
}

describe("two-operator HTTP + separate SQLite protocol", () => {
  it("completes a bilateral transcript and never reopens CLOSED on join replay", async () => {
    const { a, b } = await pair();
    const signed = await createSession(a);
    const id = signed.session.sessionId;

    const e1r = await a.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events`,
      payload: { type: "WORK_REQUEST", payload: { job: "integration" } }
    });
    expect(e1r.statusCode).toBe(201);
    const e1 = e1r.json();
    expect((await b.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events/${e1.eventHash}/ack`, payload: { decision: "ACCEPT" }
    })).statusCode).toBe(200);

    const e2r = await b.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events`, payload: { type: "WORK_RESULT", payload: { ok: true } }
    });
    expect(e2r.statusCode).toBe(201);
    const e2 = e2r.json();
    expect((await a.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events/${e2.eventHash}/ack`, payload: { decision: "ACCEPT" }
    })).statusCode).toBe(200);

    const close = await a.app.inject({ method: "POST", url: `/admin/sessions/${id}/close`, payload: { finalState: { ok: true } } });
    expect(close.statusCode).toBe(200);
    expect(a.store.getSession(id)?.status).toBe("CLOSED");
    expect(b.store.getSession(id)?.status).toBe("CLOSED");

    const transcriptResponse = await a.app.inject({ method: "GET", url: `/admin/sessions/${id}/transcript` });
    expect(transcriptResponse.statusCode).toBe(200);
    expect(verifyTranscript(transcriptResponse.json())).toEqual({ ok: true, errors: [] });

    const replay = await b.app.inject({
      method: "POST", url: `/peer/sessions/${id}/join`, payload: { session: signed.session, signatureA: signed.signatureA }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("CLOSED");
    expect(b.store.getSession(id)?.status).toBe("CLOSED");
  });

  it("rejects cross-session eventHash use in an ACK route", async () => {
    const { a, b } = await pair();
    const s1 = await createSession(a);
    const e1r = await a.app.inject({
      method: "POST", url: `/admin/sessions/${s1.session.sessionId}/events`, payload: { type: "ONE", payload: {} }
    });
    expect(e1r.statusCode).toBe(201);
    const event = e1r.json();
    const s2 = await createSession(a);
    const wrong = await b.app.inject({
      method: "POST", url: `/admin/sessions/${s2.session.sessionId}/events/${event.eventHash}/ack`, payload: { decision: "ACCEPT" }
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe("EVENT_SESSION_MISMATCH");
  });

  it("detects a second conflicting valid ACK and preserves the first", async () => {
    const { a, b } = await pair();
    const signed = await createSession(a);
    const id = signed.session.sessionId;
    const eventResponse = await a.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events`, payload: { type: "ONE", payload: {} }
    });
    expect(eventResponse.statusCode).toBe(201);
    const event = eventResponse.json();
    const acceptResponse = await b.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events/${event.eventHash}/ack`, payload: { decision: "ACCEPT" }
    });
    expect(acceptResponse.statusCode).toBe(200);
    const firstAckHash = a.store.getEvent(event.eventHash)?.ack?.ackHash;

    const conflicting = signAck({
      eventHash: event.eventHash,
      decision: "REJECT",
      operator: b.identity.publicKey,
      createdAt: new Date(Date.now() + 1).toISOString()
    }, b.identity.privateKey);
    const response = await a.app.inject({ method: "POST", url: `/peer/sessions/${id}/acks`, payload: { ack: conflicting } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("ACK_EQUIVOCATION");
    expect(a.store.getEvent(event.eventHash)?.ack?.ackHash).toBe(firstAckHash);
    expect(a.store.getSession(id)?.status).toBe("DISPUTED");
    expect(a.store.listConflicts(id).filter((conflict) => conflict.kind === "ACK")).toHaveLength(1);
  });
});
