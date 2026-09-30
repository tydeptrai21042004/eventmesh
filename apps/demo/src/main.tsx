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
  signerMode?: "configured-secret" | "public-preview";
  storage?: { mode?: string; durable?: boolean; warning?: string };
  capabilities?: {
    referenceFlow?: boolean;
    evidenceVerification?: boolean;
    fiberPayments?: boolean;
    ckbAnchoring?: boolean;
    ckbReconciliation?: boolean;
  };
};

const LAST_SESSION_KEY = "eventmesh-last-preview-session";
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
      ? "The preview API is temporarily unavailable. Please retry."
      : "The request could not be completed.");
  }
  if (!response.ok) {
    const safeErrors: Record<string, string> = {
      RATE_LIMITED: "Too many requests. Please try again shortly.",
      SESSION_NOT_FOUND: "This preview session expired or was reset. Start a new session.",
      METHOD_NOT_ALLOWED: "This action is not available.",
      PAYMENT_VERIFICATION_UNAVAILABLE: "Payment verification is currently unavailable.",
      FIBER_RECEIVER_UNAVAILABLE: "The payment verification service is currently unavailable.",
      FIBER_RECEIVER_RPC_REQUIRED_FOR_PAYMENT_ACCEPT: "Fiber receiver verification is not configured for this preview.",
      CKB_BROADCAST_DISABLED: "CKB broadcasting is disabled in this preview deployment."
    };
    const code = String(payload?.error || "");
    throw new Error(safeErrors[code] || (response.status >= 500
      ? "The preview API is temporarily unavailable. Please retry."
      : code || "The action could not be completed."));
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

function friendlyEvent(type: string) {
  return type.replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase());
}

function App() {
  const [info, setInfo] = useState<PublicInfo>();
  const [state, setState] = useState<State>();
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verification, setVerification] = useState<any>();
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
      setError(e?.message || "The preview API is temporarily unavailable.");
    }
  };

  const rememberSession = (id: string) => {
    setSessionId(id);
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  };

  useEffect(() => {
    void loadInfo();
    const saved = localStorage.getItem(LAST_SESSION_KEY);
    if (!saved) return;
    void call(undefined, saved).then(restored => {
      setSessionId(saved);
      setState(restored);
      setNotice("Restored the last preview session from this browser.");
    }).catch(() => {
      localStorage.removeItem(LAST_SESSION_KEY);
    });
  }, []);

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try { return await fn(); }
    catch (e: any) {
      if (String(e?.message || "").includes("expired or was reset")) {
        rememberSession("");
        setState(undefined);
      }
      setError(e?.message || "The action could not be completed.");
    }
    finally { setBusy(""); }
  };

  const events = state?.events ?? [];
  const has = (type: string) => events.some((row: any) => row.event.type === type && row.ack?.decision === "ACCEPT");
  const closed = state?.status === "CLOSED";
  const capabilities = info?.capabilities ?? {};

  const create = () => run("create", async () => {
    const result = await call({ action: "create_session", idempotencyKey: createKey() });
    sessionStorage.removeItem("eventmesh-create-idempotency");
    rememberSession(result.sessionId);
    setVerification(undefined);
    setState(result.state || await call(undefined, result.sessionId));
    setNotice("Signed bilateral session created.");
  });

  const runReference = () => run("reference", async () => {
    const result = await call({
      action: "run_reference_flow",
      idempotencyKey: newKey("reference"),
      requestId,
      service,
      resultHash
    });
    rememberSession(result.sessionId);
    setVerification(undefined);
    setState(result.state);
    setNotice("Reference flow completed and dual-signed in one server-side run.");
  });

  const event = (label: string, sender: "A" | "B", type: string, payload: any) => run(label, async () => {
    const result = await call({ action: "append_event", sessionId, sender, type, payload, idempotencyKey: `${sessionId}:${type}:${requestId}` });
    setState(result.state);
    setVerification(undefined);
    setNotice(`${friendlyEvent(type)} accepted by the counterparty.`);
  });

  const settle = () => event("payment", "A", "PAYMENT_SETTLED", { paymentHash, sessionId, amount, currency });

  const close = () => run("close", async () => {
    const finalState = { kind: "paid-service", requestId, service, resultHash, paymentHash: has("PAYMENT_SETTLED") ? paymentHash : undefined, completed: true };
    const result = await call({ action: "close_session", sessionId, finalState, idempotencyKey: `${sessionId}:close` });
    setState(result.state);
    setVerification(undefined);
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

  const verifyEvidence = () => run("verify", async () => {
    const result = await call({ action: "verify_evidence", sessionId });
    setVerification(result);
    setNotice(result.ok ? "All available signatures, hashes and transcript links verify." : "Evidence verification found a mismatch.");
  });

  const copyText = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied.`);
  };

  const download = () => {
    const exportBody = {
      preview: {
        product: "EventMesh",
        version: info?.version,
        storage: info?.storage,
        signerMode: info?.signerMode,
        exportedAt: new Date().toISOString()
      },
      session: state?.signedSession,
      events: (state?.events || []).map((row: any) => ({ event: row.event, ack: row.ack })),
      close: state?.close || undefined,
      paymentEvidence: state?.paymentEvidence || [],
      ckbAnchor: state?.anchor || undefined
    };
    const blob = new Blob([JSON.stringify(exportBody, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId || "eventmesh"}-evidence.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startOver = () => {
    rememberSession("");
    setState(undefined);
    setVerification(undefined);
    setError("");
    setNotice("");
    setRequestId(`req-${crypto.randomUUID().slice(0, 8)}`);
  };

  const progress = useMemo(() => {
    if (closed) return 5;
    if (has("SESSION_COMPLETED")) return 4;
    if (has("RESULT_COMMITTED")) return 3;
    if (has("SERVICE_ACCEPTED")) return 2;
    if (has("SERVICE_REQUESTED")) return 1;
    return 0;
  }, [events, closed]);

  const closeBody = state?.close?.close;
  const signerLabel = info?.signerMode === "configured-secret" ? "Configured identity" : "Demo-only identity";

  return <main>
    <nav className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"/><span>EventMesh</span></div>
      <div className="topbar-meta"><span className="network-dot"/><span>{info?.network || "CKB Testnet"}</span><span className="preview-pill">Preview</span></div>
    </nav>

    <header className="hero">
      <div>
        <div className="eyebrow">Bilateral event reconciliation</div>
        <h1>One shared record when systems disagree.</h1>
        <p>Coordinate service events, explicit acknowledgements and final commitments between independent operators with signed, exportable evidence.</p>
        <div className="hero-trust"><span>Signed events</span><span>Explicit acknowledgements</span><span>Evidence verification</span><span>CKB-ready checkpoints</span></div>
      </div>
      <div className="hero-action">
        <button className="primary large" disabled={!!busy || !info?.ok} onClick={create}>{busy === "create" ? "Starting…" : "Start signed session"}</button>
        <button className="secondary large" disabled={!!busy || !info?.ok || !capabilities.referenceFlow} onClick={runReference}>{busy === "reference" ? "Running flow…" : "Run full reference demo"}</button>
        <small>{info?.ok ? "Preview API ready · no database required" : "Preview API unavailable"}</small>
      </div>
    </header>

    <section className="preview-note">
      <div className="preview-icon" aria-hidden="true">i</div>
      <div><b>File-backed preview state</b><span>{info?.storage?.warning || "State is intentionally ephemeral in this deployment."}</span></div>
      <span className="preview-state">{info?.storage?.mode || "ephemeral-json"}</span>
    </section>

    {error && <div className="banner error"><div><b>Unable to complete the action</b><span>{error}</span></div><button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="banner ok"><span className="check">✓</span><span>{notice}</span></div>}

    <section className="participants">
      <div className="section-title"><small>Session participants</small><h2>Independent operator identities</h2></div>
      <div className="grid two">
        <article className="identity-card"><div className="avatar">A</div><div><small>Requester / payer</small><b>{short(info?.operatorA)}</b></div><span className="verified">{signerLabel}</span></article>
        <article className="identity-card"><div className="avatar">B</div><div><small>Provider / receiver</small><b>{short(info?.operatorB)}</b></div><span className="verified">{signerLabel}</span></article>
      </div>
      {info?.signerMode === "public-preview" && <p className="identity-warning">Zero-config mode uses public demo-only signing identities. They are for protocol demonstration only and must never control funds or production authority.</p>}
    </section>

    {!sessionId ? <section className="card onboarding">
      <div className="onboarding-copy"><small>How it works</small><h2>From request to a jointly signed final state</h2><p>Run each step manually, or use the full reference demo to generate a complete evidence bundle in one click.</p></div>
      <div className="onboarding-steps">
        <div><span>01</span><b>Create</b><p>Open a signed bilateral session.</p></div>
        <div><span>02</span><b>Reconcile</b><p>Exchange hash-linked events and ACKs.</p></div>
        <div><span>03</span><b>Verify</b><p>Dual-sign, verify and export the transcript.</p></div>
      </div>
    </section> : <>
      <section className="session card">
        <div className="session-id"><small>Session</small><div className="inline-value"><b title={sessionId}>{short(sessionId, 18)}</b><button className="icon-button" aria-label="Copy session ID" onClick={() => copyText(sessionId, "Session ID")}>Copy</button></div></div>
        <div><small>Status</small><b className={`status ${closed ? "closed" : "active"}`}>{closed ? "Closed" : "Active"}</b></div>
        <div><small>Events</small><b>{events.length}</b></div>
        <div><small>Progress</small><b>{progress}/5</b></div>
        <button className="secondary new-session" onClick={startOver}>New session</button>
      </section>

      <section className="grid workspace">
        <article className="card flow-card">
          <div className="section-head"><div><small>Reference flow</small><h2>Service reconciliation</h2></div><span className="step-count">Step {Math.min(progress + 1, 5)} of 5</span></div>
          <div className="progress-track"><span style={{ width: `${progress * 20}%` }}/></div>
          <div className="form-row"><label>Request ID<input value={requestId} onChange={e => setRequestId(e.target.value)} disabled={events.length > 0}/></label><label>Service<input value={service} onChange={e => setService(e.target.value)} disabled={events.length > 0}/></label></div>
          <div className="flow-actions">
            <button className={progress === 0 ? "next-action" : ""} disabled={!!busy || has("SERVICE_REQUESTED") || closed} onClick={() => event("request", "A", "SERVICE_REQUESTED", { requestId, service })}><span>1</span><div><b>Request service</b><small>Operator A → Operator B</small></div></button>
            <button className={progress === 1 ? "next-action" : ""} disabled={!!busy || !has("SERVICE_REQUESTED") || has("SERVICE_ACCEPTED") || closed} onClick={() => event("accept", "B", "SERVICE_ACCEPTED", { requestId })}><span>2</span><div><b>Accept request</b><small>Operator B acknowledges exact hash</small></div></button>
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
            <div className="section-head"><div><small>Value binding</small><h2>Fiber payment proof</h2></div><span className={`capability ${capabilities.fiberPayments ? "available" : "inactive"}`}>{capabilities.fiberPayments ? "Available" : "Optional"}</span></div>
            {capabilities.fiberPayments ? <>
              <label>Payment hash<input value={paymentHash} onChange={e => setPaymentHash(e.target.value)}/></label>
              <div className="grid two compact"><label>Amount<input value={amount} onChange={e => setAmount(e.target.value)}/></label><label>Currency<select value={currency} onChange={e => setCurrency(e.target.value)}><option>Fibt</option><option>Fibb</option><option>Fibd</option></select></label></div>
              <button disabled={!!busy || has("PAYMENT_SETTLED") || closed} onClick={settle}>{has("PAYMENT_SETTLED") ? "Payment verified" : "Verify receiver-side payment"}</button>
            </> : <p className="subtle">The signed reconciliation flow works without Fiber. Configure a receiver FNN only when you want the receiver to independently verify a real payment claim.</p>}
          </article>

          <article className="card capability-card">
            <div className="section-head"><div><small>Settlement evidence</small><h2>CKB checkpoint</h2></div><span className={`capability ${capabilities.ckbAnchoring ? "available" : "inactive"}`}>{capabilities.ckbAnchoring ? "Available" : "Optional"}</span></div>
            <p className="subtle">The transcript can be verified without CKB. Optionally bind the closed commitment to CKB Testnet for an external checkpoint.</p>
            {capabilities.ckbAnchoring && <button disabled={!!busy || !closed || !!state?.anchor} onClick={anchor}>{state?.anchor ? "Checkpoint submitted" : "Submit checkpoint"}</button>}
            {state?.anchorOperation?.txHash && <div className="checkpoint"><small>Transaction</small><code>{short(state.anchorOperation.txHash, 16)}</code>{capabilities.ckbReconciliation && <button className="text-button" disabled={!!busy} onClick={reconcile}>Verify on CKB</button>}</div>}
          </article>
        </aside>
      </section>

      {closeBody && <section className="commitment-grid">
        <article className="commitment-card"><small>Transcript root</small><code title={closeBody.transcriptRoot}>{short(closeBody.transcriptRoot, 12)}</code><button onClick={() => copyText(closeBody.transcriptRoot, "Transcript root")}>Copy</button></article>
        <article className="commitment-card"><small>Final state hash</small><code title={closeBody.finalStateHash}>{short(closeBody.finalStateHash, 12)}</code><button onClick={() => copyText(closeBody.finalStateHash, "Final state hash")}>Copy</button></article>
        <article className="commitment-card"><small>Payment evidence root</small><code title={closeBody.paymentEvidenceRoot}>{short(closeBody.paymentEvidenceRoot, 12)}</code><button onClick={() => copyText(closeBody.paymentEvidenceRoot, "Payment evidence root")}>Copy</button></article>
      </section>}

      <section className="card evidence-card">
        <div className="section-head evidence-head"><div><small>Evidence</small><h2>Signed event timeline</h2></div><div className="evidence-actions"><button className="secondary" disabled={!!busy || !capabilities.evidenceVerification} onClick={verifyEvidence}>{busy === "verify" ? "Verifying…" : "Verify evidence"}</button><button className="secondary" onClick={download}>Export JSON</button></div></div>
        {verification && <div className={`verification ${verification.ok ? "verified-ok" : "verified-bad"}`}><b>{verification.ok ? "Evidence verified" : "Verification mismatch"}</b><span>{verification.ok ? `${verification.summary.eventCount} events are hash-linked and signatures are valid${verification.summary.closed ? "; the close commitment also matches." : "."}` : verification.verification?.errors?.join(" · ")}</span></div>}
        <div className="timeline">{events.length ? events.map((row: any) => <details className="event" key={row.event.eventHash}><summary><span className="sequence">#{row.event.sequence}</span><div className="event-main"><b>{friendlyEvent(row.event.type)}</b><small>{row.event.sender === info?.operatorA ? "A → B" : "B → A"} · ACK {row.ack?.decision || "—"} · {new Date(row.event.createdAt).toLocaleTimeString()}</small></div><code>{short(row.event.eventHash, 16)}</code></summary><div className="event-detail-grid"><div><small>Previous hash</small><code>{row.event.previousHash}</code></div><div><small>ACK hash</small><code>{row.ack?.ackHash || "—"}</code></div><div className="payload"><small>Payload</small><pre>{JSON.stringify(row.event.payload, null, 2)}</pre></div></div></details>) : <p className="muted">No events yet.</p>}</div>
        {state?.close && <details className="final-details"><summary>View dual-signed final commitment</summary><pre>{JSON.stringify(state.close, null, 2)}</pre></details>}
      </section>
    </>}

    <footer><span>EventMesh</span><span>CKB Testnet preview · File-backed state may reset · Do not use production funds</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
