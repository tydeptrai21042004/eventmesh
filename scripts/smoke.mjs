const A = process.env.A || "http://localhost:4001";
const B = process.env.B || "http://localhost:4002";
const token = process.env.ADMIN_TOKEN;

const j = async (url, options = {}) => {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token) headers["x-eventmesh-admin-token"] = token;
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
};

const session = await j(`${A}/admin/sessions`, { method: "POST", body: "{}" });
const id = session.session.sessionId;
const requestId = `req-${Date.now()}`;
console.log("session", id);

async function acceptedEvent(sender, receiver, type, payload) {
  const event = await j(`${sender}/admin/sessions/${id}/events`, {
    method: "POST",
    body: JSON.stringify({ type, payload })
  });
  const ack = await j(`${receiver}/admin/sessions/${id}/events/${event.eventHash}/ack`, {
    method: "POST",
    body: JSON.stringify({ decision: "ACCEPT" })
  });
  return { event, ack };
}

const request = await acceptedEvent(A, B, "SERVICE_REQUESTED", {
  requestId,
  service: "local-reconciliation-smoke"
});

// Re-ACKing the exact same event exercises idempotent redelivery: no duplicate state transition.
const duplicateAck = await j(`${B}/admin/sessions/${id}/events/${request.event.eventHash}/ack`, {
  method: "POST",
  body: JSON.stringify({ decision: "ACCEPT" })
});
if (!duplicateAck.duplicate) throw new Error("Expected duplicate ACK redelivery to be idempotent");
console.log("idempotent ACK replay", "PASS");

await acceptedEvent(B, A, "SERVICE_ACCEPTED", { requestId });
await acceptedEvent(B, A, "RESULT_COMMITTED", {
  requestId,
  resultHash: `0x${"ab".repeat(32)}`
});
await acceptedEvent(B, A, "SESSION_COMPLETED", { requestId });

const closed = await j(`${A}/admin/sessions/${id}/close`, {
  method: "POST",
  body: JSON.stringify({
    finalState: {
      kind: "local-reconciliation-smoke",
      requestId,
      completed: true,
      fiberBound: false
    }
  })
});
console.log("closed", closed.close.close.transcriptRoot);

const summary = await j(`${A}/admin/sessions/${id}/evidence-summary`);
if (!summary.readiness.bilateralSession || !summary.readiness.allEventsAccepted || !summary.readiness.closeDualSigned) {
  throw new Error(`Evidence summary not ready: ${JSON.stringify(summary.readiness)}`);
}
console.log("evidence summary", JSON.stringify(summary.readiness));

const transcript = await j(`${A}/admin/sessions/${id}/transcript`);
const out = `/tmp/${id}.json`;
await import("node:fs").then((fs) => fs.writeFileSync(out, JSON.stringify(transcript, null, 2)));
console.log("transcript", out);
console.log("NOTE: local smoke intentionally skips Fiber and CKB; use docs/HOW_TO_VERIFY.md for the funded full-proof path.");
