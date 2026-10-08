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

async function createSession(a: Awaited<ReturnType<typeof buildOperatorApp>>, payload: Record<string, unknown> = {}): Promise<SignedSession> {
  const response = await a.app.inject({ method: "POST", url: "/admin/sessions", payload });
  expect(response.statusCode).toBe(201);
  return response.json() as SignedSession;
}

describe("two-operator HTTP + separate JSON-file stores", () => {
  it("serializes concurrent ACK requests into a single signed ACK without a false dispute", async () => {
    const { a, b } = await pair();
    const signed = await createSession(a);
    const id = signed.session.sessionId;
    const eventResponse = await a.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events`, payload: { type: "CONCURRENT_TEST", payload: { n: 1 } }
    });
    expect(eventResponse.statusCode).toBe(201);
    const event = eventResponse.json();
    const [first, second] = await Promise.all([
      b.app.inject({ method: "POST", url: `/admin/sessions/${id}/events/${event.eventHash}/ack`, payload: { decision: "ACCEPT" } }),
      b.app.inject({ method: "POST", url: `/admin/sessions/${id}/events/${event.eventHash}/ack`, payload: { decision: "ACCEPT" } })
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().ackHash).toBe(second.json().ackHash);
    expect(b.store.getSession(id)?.status).toBe("ACTIVE");
    expect(b.store.listConflicts(id)).toEqual([]);
    expect(b.store.listOutbox("DELIVERED", id).filter((row) => row.kind === "ACK")).toHaveLength(1);
  });

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
    expect(close.json().close.close.commitmentVersion).toBe(3);
    expect(close.json().close.finalState.kind).toBe("generic-bilateral");
    expect(close.json().close.finalState).not.toEqual({ ok: true });
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


  it("reports IN_SYNC after durable event/ACK delivery and exposes no pending outbox", async () => {
    const { a, b } = await pair();
    const signed = await createSession(a);
    const id = signed.session.sessionId;
    const eventResponse = await a.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events`, payload: { type: "SYNC_TEST", payload: { n: 1 } }
    });
    expect(eventResponse.statusCode).toBe(201);
    const event = eventResponse.json();
    expect((await b.app.inject({
      method: "POST", url: `/admin/sessions/${id}/events/${event.eventHash}/ack`, payload: { decision: "ACCEPT" }
    })).statusCode).toBe(200);

    const reconcile = await a.app.inject({
      method: "POST", url: `/admin/sessions/${id}/reconcile`, payload: { repair: true }
    });
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json()).toMatchObject({ state: "IN_SYNC", pendingOutbox: 0, safeAction: "NONE" });
    expect(a.store.listOutbox("PENDING", id)).toHaveLength(0);
    expect(b.store.listOutbox("PENDING", id)).toHaveLength(0);
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


  it("derives paid-service final state on both operators instead of signing caller JSON", async () => {
    const { a, b } = await pair();
    const signed = await createSession(a, { applicationProfile: "paid-service-v1" });
    const id = signed.session.sessionId;
    const requestId = "req-derived-state";

    const send = async (sender: typeof a, receiver: typeof a, type: string, payload: unknown) => {
      const proposed = await sender.app.inject({ method: "POST", url: `/admin/sessions/${id}/events`, payload: { type, payload } });
      expect(proposed.statusCode).toBe(201);
      const event = proposed.json();
      const ack = await receiver.app.inject({ method: "POST", url: `/admin/sessions/${id}/events/${event.eventHash}/ack`, payload: { decision: "ACCEPT" } });
      expect(ack.statusCode).toBe(200);
      return event;
    };

    await send(a, b, "SERVICE_REQUESTED", { requestId, service: "dataset-transform" });
    await send(b, a, "SERVICE_ACCEPTED", { requestId });
    await send(b, a, "RESULT_COMMITTED", { requestId, resultHash: `0x${"ab".repeat(32)}` });
    await send(b, a, "SESSION_COMPLETED", { requestId });

    const closed = await a.app.inject({
      method: "POST",
      url: `/admin/sessions/${id}/close`,
      payload: { finalState: { forgedByCaller: true } }
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().close.finalState).toEqual({
      kind: "paid-service",
      requestId,
      service: "dataset-transform",
      resultHash: `0x${"ab".repeat(32)}`,
      completed: true
    });
    expect(a.store.getSession(id)?.close?.finalState).toEqual(b.store.getSession(id)?.close?.finalState);
  });

});

describe("reviewer evidence summary", () => {
  it("reports bilateral acceptance and a dual-signed close without pretending local smoke is Fiber-bound", async () => {
    const { a, b } = await pair();
    const signed = await createSession(a);
    const id = signed.session.sessionId;

    const eventResponse = await a.app.inject({
      method: "POST",
      url: `/admin/sessions/${id}/events`,
      payload: { type: "SERVICE_REQUESTED", payload: { requestId: "req-summary", service: "demo" } }
    });
    expect(eventResponse.statusCode).toBe(201);
    const event = eventResponse.json();
    expect((await b.app.inject({
      method: "POST",
      url: `/admin/sessions/${id}/events/${event.eventHash}/ack`,
      payload: { decision: "ACCEPT" }
    })).statusCode).toBe(200);

    expect((await a.app.inject({
      method: "POST",
      url: `/admin/sessions/${id}/close`,
      payload: { finalState: { requestId: "req-summary", completed: true } }
    })).statusCode).toBe(200);

    const response = await a.app.inject({ method: "GET", url: `/admin/sessions/${id}/evidence-summary` });
    expect(response.statusCode).toBe(200);
    const summary = response.json();
    expect(summary.events).toMatchObject({ total: 1, final: 1, accepted: 1, rejected: 0, pending: 0 });
    expect(summary.readiness).toMatchObject({
      bilateralSession: true,
      allEventsFinal: true,
      allEventsAccepted: true,
      fiberBound: false,
      noRecordedConflicts: true,
      closeDualSigned: true,
      ckbCommitted: false
    });
    expect(summary.ckb.anchorStatus).toBe("NONE");
  });
});
