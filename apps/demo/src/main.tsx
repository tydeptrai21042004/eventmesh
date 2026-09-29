import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type State = any;

const newKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const createKey = () => {
  const old = sessionStorage.getItem("eventmesh-create-idempotency");
  if (old) return old;
  const next = newKey("create");
  sessionStorage.setItem("eventmesh-create-idempotency", next);
  return next;
};

async function call(body?: any, sessionId?: string) {
  const response = await fetch(sessionId ? `/api/demo?sessionId=${encodeURIComponent(sessionId)}` : "/api/demo", body ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  } : undefined);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function short(value?: string, n = 13) {
  if (!value) return "—";
  return value.length <= n * 2 ? value : `${value.slice(0, n)}…${value.slice(-n)}`;
}

function App() {
  const [health, setHealth] = useState<any>();
  const [state, setState] = useState<State>();
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [requestId, setRequestId] = useState(() => `req-${crypto.randomUUID().slice(0, 8)}`);
  const [service, setService] = useState("dataset-transform");
  const [resultHash, setResultHash] = useState(`0x${"ab".repeat(32)}`);
  const [paymentHash, setPaymentHash] = useState(`0x${"11".repeat(32)}`);
  const [amount, setAmount] = useState("100000000");
  const [currency, setCurrency] = useState("Fibt");

  const refresh = async (id = sessionId) => {
    if (!id) return;
    setState(await call(undefined, id));
  };

  useEffect(() => { call().then(setHealth).catch(e => setError(e.message)); }, []);

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label); setError(""); setNotice("");
    try { return await fn(); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(""); }
  };

  const events = state?.events ?? [];
  const has = (type: string) => events.some((row: any) => row.event.type === type && row.ack?.decision === "ACCEPT");
  const closed = state?.status === "CLOSED";

  const create = () => run("create", async () => {
    const result = await call({ action: "create_session", idempotencyKey: createKey() });
    sessionStorage.removeItem("eventmesh-create-idempotency");
    setSessionId(result.sessionId); setState(result.state || await call(undefined, result.sessionId));
    setNotice("A and B signed the same session. No browser admin token is used.");
  });

  const event = (label: string, sender: "A" | "B", type: string, payload: any) => run(label, async () => {
    const result = await call({ action: "append_event", sessionId, sender, type, payload, idempotencyKey: `${sessionId}:${type}:${requestId}` });
    setState(result.state); setNotice(`${type} is signed by ${sender} and explicitly ACCEPTed by the counterparty.`);
  });

  const settle = () => event("payment", "A", "PAYMENT_SETTLED", { paymentHash, sessionId, amount, currency });

  const close = () => run("close", async () => {
    const finalState = { kind: "paid-service", requestId, service, resultHash, paymentHash: has("PAYMENT_SETTLED") ? paymentHash : undefined, completed: true };
    const result = await call({ action: "close_session", sessionId, finalState, idempotencyKey: `${sessionId}:close` });
    setState(result.state); setNotice("Both operators signed one final transcript/state commitment.");
  });

  const anchor = () => run("anchor", async () => {
    const result = await call({ action: "anchor", sessionId });
    setState(result.state); setNotice("Anchor broadcast recorded durably before any retry is allowed.");
  });

  const reconcile = () => run("reconcile", async () => {
    const result = await call({ action: "reconcile_anchor", sessionId });
    setState(result.state); setNotice(result.ok ? "CKB commitment is committed and matches." : "Anchor is not committed yet.");
  });

  const download = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `${sessionId || "eventmesh"}.json`; a.click(); URL.revokeObjectURL(url);
  };

  const readiness = useMemo(() => [
    ["Postgres durable state", !!health?.database],
    ["Receiver-side Fiber verification", !!health?.fiberReceiverVerification],
    ["CKB anchor broadcast", !!health?.ckbAnchoring],
    ["CKB reconciliation", !!health?.ckbReconciliation]
  ], [health]);

  return <main>
    <header className="hero">
      <div>
        <div className="eyebrow">CKB + Fiber · one-project Vercel demo</div>
        <h1>EventMesh <span>v0.3 demo</span></h1>
        <p>Durable bilateral reconciliation for application events when payment, retries, crashes, or network ambiguity leave operators with different local views.</p>
      </div>
      <button className="primary" disabled={!!busy} onClick={create}>{busy === "create" ? "Creating…" : "Start signed session"}</button>
    </header>

    {error && <div className="banner error"><b>Action failed</b><span>{error}</span></div>}
    {notice && <div className="banner ok">{notice}</div>}

    <section className="grid two">
      <article className="card"><small>OPERATOR A</small><b>{short(health?.operatorA)}</b><p>Requester / payer identity</p></article>
      <article className="card"><small>OPERATOR B</small><b>{short(health?.operatorB)}</b><p>Provider / receiver identity</p></article>
    </section>

    <section className="card readiness">
      <div className="section-head"><div><small>DEPLOYMENT</small><h2>Runtime readiness</h2></div><code>/api/demo</code></div>
      <div className="readiness-grid">{readiness.map(([name, ready]: any) => <div key={name}><span className={ready ? "dot on" : "dot"}/><b>{name}</b><small>{ready ? "enabled" : "optional / not configured"}</small></div>)}</div>
      <p className="muted">PAYMENT_SETTLED is intentionally refused unless the receiver Fiber RPC is configured. The public demo never fabricates payment acceptance.</p>
    </section>

    {!sessionId ? <section className="card empty"><h2>Start with one click</h2><p>The frontend and backend deploy from this single repository. Durable state is Postgres-backed and privileged operator keys remain server-side.</p></section> : <>
      <section className="session card"><div><small>SESSION</small><b>{sessionId}</b></div><div><small>STATE</small><b>{state?.status}</b></div><div><small>EVENTS</small><b>{events.length}</b></div></section>

      <section className="grid two">
        <article className="card">
          <div className="section-head"><div><small>REFERENCE FLOW</small><h2>Paid service reconciliation</h2></div></div>
          <label>Request ID<input value={requestId} onChange={e => setRequestId(e.target.value)} disabled={events.length > 0}/></label>
          <label>Service<input value={service} onChange={e => setService(e.target.value)} disabled={events.length > 0}/></label>
          <button disabled={!!busy || has("SERVICE_REQUESTED") || closed} onClick={() => event("request", "A", "SERVICE_REQUESTED", { requestId, service })}>1. Request service</button>
          <button disabled={!!busy || !has("SERVICE_REQUESTED") || has("SERVICE_ACCEPTED") || closed} onClick={() => event("accept", "B", "SERVICE_ACCEPTED", { requestId })}>2. Provider accepts</button>
          <label>Result commitment<input value={resultHash} onChange={e => setResultHash(e.target.value)}/></label>
          <button disabled={!!busy || !has("SERVICE_ACCEPTED") || has("RESULT_COMMITTED") || closed} onClick={() => event("result", "B", "RESULT_COMMITTED", { requestId, resultHash })}>3. Commit result</button>
          <button disabled={!!busy || !has("RESULT_COMMITTED") || has("SESSION_COMPLETED") || closed} onClick={() => event("complete", "B", "SESSION_COMPLETED", { requestId })}>4. Mark service complete</button>
          <button className="primary" disabled={!!busy || !events.length || closed} onClick={close}>5. Dual-sign close</button>
        </article>

        <article className="card">
          <div className="section-head"><div><small>OPTIONAL VALUE BINDING</small><h2>Real receiver Fiber proof</h2></div></div>
          <label>Payment hash<input value={paymentHash} onChange={e => setPaymentHash(e.target.value)}/></label>
          <div className="grid two compact"><label>Amount<input value={amount} onChange={e => setAmount(e.target.value)}/></label><label>Currency<select value={currency} onChange={e => setCurrency(e.target.value)}><option>Fibt</option><option>Fibb</option><option>Fibd</option></select></label></div>
          <button disabled={!!busy || !health?.fiberReceiverVerification || has("PAYMENT_SETTLED") || closed} onClick={settle}>Verify receiver FNN + ACCEPT payment</button>
          {!health?.fiberReceiverVerification && <p className="warn">Set <code>FIBER_RECEIVER_RPC_URL</code> to enable this. This demo refuses to simulate a successful payment.</p>}

          <hr/>
          <div className="section-head"><div><small>OPTIONAL CKB</small><h2>Durable checkpoint</h2></div></div>
          <button disabled={!!busy || !closed || !health?.ckbAnchoring || !!state?.anchor} onClick={anchor}>Broadcast CKB anchor</button>
          <button disabled={!!busy || !state?.anchorOperation?.tx_hash || !health?.ckbReconciliation} onClick={reconcile}>Reconcile anchor</button>
          {state?.anchorOperation && <pre>{JSON.stringify(state.anchorOperation, null, 2)}</pre>}
        </article>
      </section>

      <section className="card">
        <div className="section-head"><div><small>EVIDENCE</small><h2>Signed event timeline</h2></div><button onClick={download}>Export JSON</button></div>
        <div className="timeline">{events.length ? events.map((row: any) => <div className="event" key={row.event.eventHash}><span>#{row.event.sequence}</span><div><b>{row.event.type}</b><small>{row.event.sender === health?.operatorA ? "A → B" : "B → A"} · ACK {row.ack?.decision}</small><code>{short(row.event.eventHash, 18)}</code></div></div>) : <p className="muted">No events yet.</p>}</div>
        {state?.close && <details><summary>Final close commitment</summary><pre>{JSON.stringify(state.close, null, 2)}</pre></details>}
      </section>
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
