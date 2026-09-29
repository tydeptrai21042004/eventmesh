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
console.log("session", id);

const e1 = await j(`${A}/admin/sessions/${id}/events`, {
  method: "POST",
  body: JSON.stringify({ type: "WORK_REQUEST", payload: { job: "smoke" } })
});
await j(`${B}/admin/sessions/${id}/events/${e1.eventHash}/ack`, {
  method: "POST",
  body: JSON.stringify({ decision: "ACCEPT" })
});

const e2 = await j(`${B}/admin/sessions/${id}/events`, {
  method: "POST",
  body: JSON.stringify({ type: "WORK_RESULT", payload: { ok: true } })
});
await j(`${A}/admin/sessions/${id}/events/${e2.eventHash}/ack`, {
  method: "POST",
  body: JSON.stringify({ decision: "ACCEPT" })
});

const closed = await j(`${A}/admin/sessions/${id}/close`, {
  method: "POST",
  body: JSON.stringify({ finalState: { ok: true } })
});
console.log("closed", closed.close.close.transcriptRoot);

const transcript = await j(`${A}/admin/sessions/${id}/transcript`);
const out = `/tmp/${id}.json`;
await import("node:fs").then((fs) => fs.writeFileSync(out, JSON.stringify(transcript, null, 2)));
console.log("transcript", out);
