import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type State = any;

type PublicInfo = {
  ok?: boolean;
  protocol?: string;
  version?: string;
  network?: string;
  operatorA?: string;
  operatorB?: string;
  capabilities?: {
    fiberPayments?: boolean;
    ckbAnchoring?: boolean;
    ckbReconciliation?: boolean;
  };
};

const newKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const createKey = () => {
  const old = sessionStorage.getItem("eventmesh-create-idempotency");
  if (old) return old;
  const next = newKey("create");
  sessionStorage.setItem("eventmesh-create-idempotency", next);
  return next;
};

async function parseApiResponse(response: Response) {
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(response.status >= 500
      ? "The service is temporarily unavailable. Please try again."
      : "The request could not be completed.");
  }
  if (!response.ok) {
    const safeErrors: Record<string, string> = {
      RATE_LIMITED: "Too many requests. Please try again shortly.",
      SESSION_NOT_FOUND: "This session is no longer available.",
      METHOD_NOT_ALLOWED: "This action is not available.",
      PAYMENT_VERIFICATION_UNAVAILABLE: "Payment verification is currently unavailable.",
      FIBER_RECEIVER_UNAVAILABLE: "The payment verification service is currently unavailable."
    };
    const code = String(payload?.error || "");
    throw new Error(safeErrors[code] || (response.status >= 500
      ? "The service is temporarily unavailable. Please try again."
      : "The action could not be completed."));
  }
  return payload;
}

async function call(body?: any, sessionId?: string) {
  const response = await fetch(sessionId ? `/api/demo?sessionId=${encodeURIComponent(sessionId)}` : "/api/demo", body ? {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  } : { headers: { accept: "application/json" } });
  return parseApiResponse(response);
}

function short(value?: string, n = 13) {
  if (!value) return "—";
  return value.length <= n * 2 ? value : `${value.slice(0, n)}…${value.slice(-n)}`;
}

function App() {
  const [info, setInfo] = useState<PublicInfo>();
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

  const loadInfo = async () => {
    try {
      const result = await call();
      setInfo(result);
    } catch (e: any) {
      setInfo({ ok: false, network: "CKB Testnet" });
      setError(e?.message || "The service is temporarily unavailable.");
    }
  };

  useEffect(() => { void loadInfo(); }, []);

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try { return await fn(); }
    catch (e: any) { setError(e?.message || "The action could not be completed."); }
    finally { setBusy(""); }
  };

  const events = state?.events ?? [];
  const has = (type: string) => events.some((row: any) => row.event.type === type && row.ack?.decision === "ACCEPT");
  const closed = state?.status === "CLOSED";
  const capabilities = info?.capabilities ?? {};

  const create = () => run("create", async () => {
    const result = await call({ action: "create_session", idempotencyKey: createKey() });
    sessionStorage.removeItem("eventmesh-create-idempotency");
    setSessionId(result.sessionId);
    setState(result.state || await call(undefined, result.sessionId));
    setNotice("Signed session created successfully.");
  });

  const event = (label: string, sender: "A" | "B", type: string, payload: any) => run(label, async () => {
    const result = await call({ action: "append_event", sessionId, sender, type, payload, idempotencyKey: `${sessionId}:${type}:${requestId}` });
    setState(result.state);
    setNotice(`${type.replaceAll("_", " ")} accepted by both participants.`);
  });

  const settle = () => event("payment", "A", "PAYMENT_SETTLED", { paymentHash, sessionId, amount, currency });

  const close = () => run("close", async () => {
    const finalState = { kind: "paid-service", requestId, service, resultHash, paymentHash: has("PAYMENT_SETTLED") ? paymentHash : undefined, completed: true };
    const result = await call({ action: "close_session", sessionId, finalState, idempotencyKey: `${sessionId}:close` });
    setState(result.state);
    setNotice("Session closed with a jointly signed final commitment.");
  });

  const anchor = () => run("anchor", async () => {
    const result = await call({ action: "anchor", sessionId });
    setState(result.state);
    setNotice("Checkpoint submitted to CKB Testnet.");
  });

  const reconcile = () => run("reconcile", async () => {
    const result = await call({ action: "reconcile_anchor", sessionId });
    setState(result.state);
    setNotice(result.ok ? "CKB checkpoint verified." : "Checkpoint confirmation is still pending.");
  });

  const download = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId || "eventmesh"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const progress = useMemo(() => {
    if (closed) return 5;
    if (has("SESSION_COMPLETED")) return 4;
    if (has("RESULT_COMMITTED")) return 3;
    if (has("SERVICE_ACCEPTED")) return 2;
    if (has("SERVICE_REQUESTED")) return 1;
    return 0;
  }, [events, closed]);

  return <main>
    <nav className="topbar">
      <div className="brand"><span className="brand-mark">E</span><span>EventMesh</span></div>
      <div className="topbar-meta"><span className="network-dot"/><span>{info?.network || "CKB Testnet"}</span><span className="preview-pill">Preview</span></div>
    </nav>

    <header className="hero">
      <div>
        <div className="eyebrow">Bilateral event reconciliation</div>
        <h1>One shared record when systems disagree.</h1>
        <p>Coordinate service events, acknowledgements and final commitments between two independent operators with signed, verifiable evidence.</p>
        <div className="hero-trust"><span>Signed events</span><span>Explicit acknowledgements</span><span>CKB-ready checkpoints</span></div>
      </div>
      <div className="hero-action">
        <button className="primary large" disabled={!!busy || !info?.ok} onClick={create}>{busy === "create" ? "Starting…" : "Start signed session"}</button>
        <small>{info?.ok ? "Service ready" : "Service unavailable"}</small>
      </div>
    </header>

    {error && <div className="banner error"><div><b>Unable to complete the action</b><span>{error}</span></div><button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="banner ok"><span className="check">✓</span><span>{notice}</span></div>}

    <section className="participants">
      <div className="section-title"><small>Session participants</small><h2>Independent operator identities</h2></div>
      <div className="grid two">
        <article className="identity-card"><div className="avatar">A</div><div><small>Requester / payer</small><b>{short(info?.operatorA)}</b></div><span className="verified">Signed identity</span></article>
        <article className="identity-card"><div className="avatar">B</div><div><small>Provider / receiver</small><b>{short(info?.operatorB)}</b></div><span className="verified">Signed identity</span></article>
      </div>
    </section>

    {!sessionId ? <section className="card onboarding">
      <div className="onboarding-copy"><small>How it works</small><h2>From request to a jointly signed final state</h2><p>Run the reference flow below without exposing operator signing keys to the browser.</p></div>
      <div className="onboarding-steps">
        <div><span>01</span><b>Create</b><p>Open a signed bilateral session.</p></div>
        <div><span>02</span><b>Reconcile</b><p>Exchange events and explicit acknowledgements.</p></div>
        <div><span>03</span><b>Close</b><p>Commit to one final transcript and export the evidence.</p></div>
      </div>
    </section> : <>
      <section className="session card">
        <div className="session-id"><small>Session</small><b title={sessionId}>{short(sessionId, 18)}</b></div>
        <div><small>Status</small><b className={`status ${closed ? "closed" : "active"}`}>{closed ? "Closed" : "Active"}</b></div>
        <div><small>Events</small><b>{events.length}</b></div>
        <div><small>Progress</small><b>{progress}/5</b></div>
      </section>

      <section className="grid workspace">
        <article className="card flow-card">
          <div className="section-head"><div><small>Reference flow</small><h2>Service reconciliation</h2></div><span className="step-count">Step {Math.min(progress + 1, 5)} of 5</span></div>
          <div className="form-row"><label>Request ID<input value={requestId} onChange={e => setRequestId(e.target.value)} disabled={events.length > 0}/></label><label>Service<input value={service} onChange={e => setService(e.target.value)} disabled={events.length > 0}/></label></div>
          <div className="flow-actions">
            <button className={progress === 0 ? "next-action" : ""} disabled={!!busy || has("SERVICE_REQUESTED") || closed} onClick={() => event("request", "A", "SERVICE_REQUESTED", { requestId, service })}><span>1</span><div><b>Request service</b><small>Operator A → Operator B</small></div></button>
            <button className={progress === 1 ? "next-action" : ""} disabled={!!busy || !has("SERVICE_REQUESTED") || has("SERVICE_ACCEPTED") || closed} onClick={() => event("accept", "B", "SERVICE_ACCEPTED", { requestId })}><span>2</span><div><b>Accept request</b><small>Operator B acknowledges</small></div></button>
          </div>
          <label>Result commitment<input value={resultHash} onChange={e => setResultHash(e.target.value)}/></label>
          <div className="flow-actions">
            <button className={progress === 2 ? "next-action" : ""} disabled={!!busy || !has("SERVICE_ACCEPTED") || has("RESULT_COMMITTED") || closed} onClick={() => event("result", "B", "RESULT_COMMITTED", { requestId, resultHash })}><span>3</span><div><b>Commit result</b><small>Bind the output hash</small></div></button>
            <button className={progress === 3 ? "next-action" : ""} disabled={!!busy || !has("RESULT_COMMITTED") || has("SESSION_COMPLETED") || closed} onClick={() => event("complete", "B", "SESSION_COMPLETED", { requestId })}><span>4</span><div><b>Complete service</b><small>Provider marks delivery complete</small></div></button>
          </div>
          <button className="primary close-action" disabled={!!busy || !events.length || closed} onClick={close}><span>5</span>{closed ? "Session closed" : "Close with dual signatures"}</button>
        </article>

        <aside className="side-stack">
          <article className="card capability-card">
            <div className="section-head"><div><small>Value binding</small><h2>Fiber payment proof</h2></div><span className={`capability ${capabilities.fiberPayments ? "available" : "inactive"}`}>{capabilities.fiberPayments ? "Available" : "Not enabled"}</span></div>
            {capabilities.fiberPayments ? <>
              <label>Payment hash<input value={paymentHash} onChange={e => setPaymentHash(e.target.value)}/></label>
              <div className="grid two compact"><label>Amount<input value={amount} onChange={e => setAmount(e.target.value)}/></label><label>Currency<select value={currency} onChange={e => setCurrency(e.target.value)}><option>Fibt</option><option>Fibb</option><option>Fibd</option></select></label></div>
              <button disabled={!!busy || has("PAYMENT_SETTLED") || closed} onClick={settle}>{has("PAYMENT_SETTLED") ? "Payment verified" : "Verify payment proof"}</button>
            </> : <p className="subtle">Payment proof is not active in this preview. The core signed-session flow remains available.</p>}
          </article>

          <article className="card capability-card">
            <div className="section-head"><div><small>Settlement evidence</small><h2>CKB checkpoint</h2></div><span className={`capability ${capabilities.ckbAnchoring ? "available" : "inactive"}`}>{capabilities.ckbAnchoring ? "Available" : "Not enabled"}</span></div>
            <p className="subtle">Optionally bind the closed session commitment to CKB Testnet for independent verification.</p>
            {capabilities.ckbAnchoring && <button disabled={!!busy || !closed || !!state?.anchor} onClick={anchor}>{state?.anchor ? "Checkpoint submitted" : "Submit checkpoint"}</button>}
            {state?.anchorOperation?.tx_hash && <div className="checkpoint"><small>Transaction</small><code>{short(state.anchorOperation.tx_hash, 16)}</code>{capabilities.ckbReconciliation && <button className="text-button" disabled={!!busy} onClick={reconcile}>Verify on CKB</button>}</div>}
          </article>
        </aside>
      </section>

      <section className="card evidence-card">
        <div className="section-head"><div><small>Evidence</small><h2>Signed event timeline</h2></div><button className="secondary" onClick={download}>Export evidence</button></div>
        <div className="timeline">{events.length ? events.map((row: any) => <div className="event" key={row.event.eventHash}><span>#{row.event.sequence}</span><div className="event-main"><b>{row.event.type.replaceAll("_", " ")}</b><small>{row.event.sender === info?.operatorA ? "A → B" : "B → A"} · Accepted</small></div><code>{short(row.event.eventHash, 16)}</code></div>) : <p className="muted">No events yet.</p>}</div>
        {state?.close && <details><summary>View final commitment</summary><pre>{JSON.stringify(state.close, null, 2)}</pre></details>}
      </section>
    </>}

    <footer><span>EventMesh</span><span>Testnet preview · Do not use production funds</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
