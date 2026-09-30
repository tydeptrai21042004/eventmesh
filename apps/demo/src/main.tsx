import React, { useEffect, useMemo, useRef, useState } from "react";
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
  storage?: { mode?: string; durable?: boolean; portableRecovery?: boolean };
  capabilities?: {
    fiberPayments?: boolean;
    ckbAnchoring?: boolean;
    ckbReconciliation?: boolean;
  };
};

const SNAPSHOT_KEY = "eventmesh-portable-snapshot-v1";
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
      ? "The preview endpoint is temporarily unavailable."
      : "The request could not be completed.");
  }
  if (!response.ok) {
    const safeErrors: Record<string, string> = {
      RATE_LIMITED: "Too many requests. Please try again shortly.",
      SESSION_NOT_FOUND: "The server cache was recycled. Your browser snapshot can restore the session on the next action.",
      METHOD_NOT_ALLOWED: "This action is not available.",
      PAYMENT_VERIFICATION_UNAVAILABLE: "Payment verification is currently unavailable.",
      FIBER_RECEIVER_UNAVAILABLE: "The payment verification service is currently unavailable.",
      DEMO_MASTER_SECRET_REQUIRED: "Set DEMO_MASTER_SECRET in Vercel to enable server-side signing.",
      DEMO_MASTER_SECRET_TOO_SHORT: "DEMO_MASTER_SECRET must be at least 32 characters."
    };
    const code = String(payload?.error || "");
    throw new Error(safeErrors[code] || (code.startsWith("SNAPSHOT_VERIFICATION_FAILED")
      ? "The portable session snapshot failed signature or hash-chain verification."
      : response.status >= 500
        ? "The preview endpoint is temporarily unavailable."
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

function normalizeImportedSnapshot(value: any) {
  if (value?.signedSession) return value;
  if (value?.session?.session && Array.isArray(value?.events)) {
    return {
      sessionId: value.session.session.sessionId,
      status: value.close ? "CLOSED" : "ACTIVE",
      signedSession: value.session,
      events: value.events.map((row: any) => ({ ...row, status: "FINAL" })),
      close: value.close || null,
      anchor: value.ckbAnchor || null,
      paymentEvidence: value.paymentEvidence || []
    };
  }
  throw new Error("This JSON file is not an EventMesh evidence snapshot.");
}

function App() {
  const [info, setInfo] = useState<PublicInfo>();
  const [state, setState] = useState<State>(() => {
    try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null") || undefined; }
    catch { return undefined; }
  });
  const [sessionId, setSessionId] = useState(() => state?.sessionId || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(state ? "Portable signed session resumed from this browser." : "");
  const restoredRequest = state?.events?.find((row: any) => row?.event?.type === "SERVICE_REQUESTED")?.event?.payload;
  const restoredResult = state?.events?.find((row: any) => row?.event?.type === "RESULT_COMMITTED")?.event?.payload;
  const restoredPayment = state?.events?.find((row: any) => row?.event?.type === "PAYMENT_SETTLED")?.event?.payload;
  const [requestId, setRequestId] = useState(() => restoredRequest?.requestId || state?.close?.finalState?.requestId || `req-${crypto.randomUUID().slice(0, 8)}`);
  const [service, setService] = useState(() => restoredRequest?.service || state?.close?.finalState?.service || "dataset-transform");
  const [resultHash, setResultHash] = useState(() => restoredResult?.resultHash || state?.close?.finalState?.resultHash || `0x${"ab".repeat(32)}`);
  const [paymentHash, setPaymentHash] = useState(() => restoredPayment?.paymentHash || state?.close?.finalState?.paymentHash || `0x${"11".repeat(32)}`);
  const [amount, setAmount] = useState("100000000");
  const [currency, setCurrency] = useState("Fibt");
  const [note, setNote] = useState("");
  const [verification, setVerification] = useState<any>();
  const importRef = useRef<HTMLInputElement>(null);

  const loadInfo = async () => {
    try {
      const result = await call();
      setInfo(result);
    } catch (e: any) {
      setInfo({ ok: false, network: "CKB Testnet" });
      setError(e?.message || "The preview endpoint is temporarily unavailable.");
    }
  };

  useEffect(() => { void loadInfo(); }, []);
  useEffect(() => {
    if (state?.sessionId) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(state));
    else localStorage.removeItem(SNAPSHOT_KEY);
  }, [state]);

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try { return await fn(); }
    catch (e: any) { setError(e?.message || "The action could not be completed."); }
    finally { setBusy(""); }
  };

  const post = (body: any, snapshot: any = state) => call({ ...body, ...(snapshot ? { snapshot } : {}) });
  const adoptState = (next: any) => {
    if (!next) return;
    setState(next);
    setSessionId(next.sessionId || next.signedSession?.session?.sessionId || "");
    const requestEvent = (next.events || []).find((row: any) => row?.event?.type === "SERVICE_REQUESTED");
    const resultEvent = (next.events || []).find((row: any) => row?.event?.type === "RESULT_COMMITTED");
    const paymentEvent = (next.events || []).find((row: any) => row?.event?.type === "PAYMENT_SETTLED");
    if (requestEvent?.event?.payload?.requestId) setRequestId(requestEvent.event.payload.requestId);
    if (requestEvent?.event?.payload?.service) setService(requestEvent.event.payload.service);
    if (resultEvent?.event?.payload?.resultHash) setResultHash(resultEvent.event.payload.resultHash);
    if (paymentEvent?.event?.payload?.paymentHash) setPaymentHash(paymentEvent.event.payload.paymentHash);
    setVerification(undefined);
  };

  const events = state?.events ?? [];
  const has = (type: string) => events.some((row: any) => row.event.type === type && row.ack?.decision === "ACCEPT");
  const closed = state?.status === "CLOSED";
  const capabilities = info?.capabilities ?? {};

  const create = () => run("create", async () => {
    const result = await call({ action: "create_session", idempotencyKey: createKey() });
    sessionStorage.removeItem("eventmesh-create-idempotency");
    adoptState(result.state || await call(undefined, result.sessionId));
    setNotice("Signed session created. The portable snapshot is saved in this browser.");
  });

  const append = async (snapshot: any, sender: "A" | "B", type: string, payload: any, idemSuffix: string) => {
    const sid = snapshot?.sessionId || sessionId;
    return post({ action: "append_event", sessionId: sid, sender, type, payload, idempotencyKey: `${sid}:${idemSuffix}` }, snapshot);
  };

  const event = (label: string, sender: "A" | "B", type: string, payload: any, idemSuffix = `${type}:${requestId}`) => run(label, async () => {
    const result = await append(state, sender, type, payload, idemSuffix);
    adoptState(result.state);
    setNotice(`${type.replaceAll("_", " ")} accepted and signed by both participants.`);
  });

  const settle = () => event("payment", "A", "PAYMENT_SETTLED", { paymentHash, sessionId, amount, currency });

  const closeWithSnapshot = (snapshot: any) => {
    const sid = snapshot?.sessionId || sessionId;
    const hasPayment = (snapshot?.events || []).some((row: any) => row.event.type === "PAYMENT_SETTLED" && row.ack?.decision === "ACCEPT");
    const finalState = { kind: "paid-service", requestId, service, resultHash, paymentHash: hasPayment ? paymentHash : undefined, completed: true };
    return post({ action: "close_session", sessionId: sid, finalState, idempotencyKey: `${sid}:close` }, snapshot);
  };

  const close = () => run("close", async () => {
    const result = await closeWithSnapshot(state);
    adoptState(result.state);
    setNotice("Session closed with a jointly signed final commitment.");
  });

  const runReferenceFlow = () => run("reference", async () => {
    let current = state;
    if (!current || current.status === "CLOSED") {
      const created = await call({ action: "create_session", idempotencyKey: newKey("reference-create") });
      current = created.state;
    }
    if (!(current.events || []).some((row: any) => row.event.type === "SERVICE_REQUESTED")) {
      current = (await append(current, "A", "SERVICE_REQUESTED", { requestId, service }, `reference-request:${requestId}`)).state;
    }
    if (!(current.events || []).some((row: any) => row.event.type === "SERVICE_ACCEPTED")) {
      current = (await append(current, "B", "SERVICE_ACCEPTED", { requestId }, `reference-accept:${requestId}`)).state;
    }
    if (!(current.events || []).some((row: any) => row.event.type === "RESULT_COMMITTED")) {
      current = (await append(current, "B", "RESULT_COMMITTED", { requestId, resultHash }, `reference-result:${requestId}`)).state;
    }
    if (!(current.events || []).some((row: any) => row.event.type === "SESSION_COMPLETED")) {
      current = (await append(current, "B", "SESSION_COMPLETED", { requestId }, `reference-complete:${requestId}`)).state;
    }
    if (current.status !== "CLOSED") current = (await closeWithSnapshot(current)).state;
    adoptState(current);
    setNotice("Reference flow completed end-to-end and the final commitment was signed by both operators.");
  });

  const addNote = () => {
    const text = note.trim();
    if (!text) return;
    void run("note", async () => {
      const result = await append(state, "A", "RECONCILIATION_NOTE", { requestId, note: text.slice(0, 500) }, `note:${crypto.randomUUID()}`);
      adoptState(result.state);
      setNote("");
      setNotice("Reconciliation note signed and acknowledged.");
    });
  };

  const anchor = () => run("anchor", async () => {
    const result = await post({ action: "anchor", sessionId }, state);
    adoptState(result.state);
    setNotice("Checkpoint submitted to CKB Testnet.");
  });

  const reconcile = () => run("reconcile", async () => {
    const result = await post({ action: "reconcile_anchor", sessionId }, state);
    adoptState(result.state);
    setNotice(result.ok ? "CKB checkpoint verified." : "Checkpoint confirmation is still pending.");
  });

  const verify = () => run("verify", async () => {
    if (!state) throw new Error("Create or import a session first.");
    const result = await call({ action: "verify_snapshot", snapshot: state });
    setVerification(result);
    setNotice(`Evidence verified: ${result.eventCount} signed event${result.eventCount === 1 ? "" : "s"}, hash chain intact.`);
  });

  const download = () => {
    const transcript = {
      session: state?.signedSession,
      events: (state?.events || []).map((row: any) => ({ event: row.event, ack: row.ack })),
      ...(state?.close ? { close: state.close } : {}),
      ...(state?.paymentEvidence?.length ? { paymentEvidence: state.paymentEvidence } : {}),
      ...(state?.anchor ? { ckbAnchor: state.anchor } : {})
    };
    const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId || "eventmesh"}-evidence.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importEvidence = async (file?: File) => {
    if (!file) return;
    await run("import", async () => {
      const parsed = normalizeImportedSnapshot(JSON.parse(await file.text()));
      const checked = await call({ action: "verify_snapshot", snapshot: parsed });
      adoptState(parsed);
      setVerification(checked);
      setNotice(`Evidence imported and verified for session ${short(checked.sessionId, 10)}.`);
    });
    if (importRef.current) importRef.current.value = "";
  };

  const copy = async (value?: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setNotice("Copied to clipboard.");
  };

  const newSession = () => {
    setState(undefined);
    setSessionId("");
    setVerification(undefined);
    setRequestId(`req-${crypto.randomUUID().slice(0, 8)}`);
    setNotice("Local preview cleared. Start a new signed session when ready.");
    setError("");
  };

  const progress = useMemo(() => {
    if (closed) return 5;
    if (has("SESSION_COMPLETED")) return 4;
    if (has("RESULT_COMMITTED")) return 3;
    if (has("SERVICE_ACCEPTED")) return 2;
    if (has("SERVICE_REQUESTED")) return 1;
    return 0;
  }, [events, closed]);

  const storageLabel = info?.storage?.mode === "ephemeral-preview" ? "Database-free preview" : "Local signed preview";
  const chainTip = events.at(-1)?.event?.eventHash;
  const transcriptRoot = state?.close?.close?.transcriptRoot || verification?.transcriptRoot;

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
        <div className="hero-trust"><span>Signed events</span><span>Explicit acknowledgements</span><span>{storageLabel}</span><span>Portable recovery</span><span>CKB-ready checkpoints</span></div>
      </div>
      <div className="hero-action">
        <button className="primary large" disabled={!!busy || !info?.ok} onClick={create}>{busy === "create" ? "Starting…" : "Start signed session"}</button>
        <button className="secondary" disabled={!!busy || !info?.ok} onClick={runReferenceFlow}>{busy === "reference" ? "Running full flow…" : "Run full reference flow"}</button>
        <small>{info?.ok ? "Signing service ready · no database required" : "Signing setup required"}</small>
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

    {!sessionId ? <>
      <section className="card onboarding">
        <div className="onboarding-copy"><small>How it works</small><h2>From request to a jointly signed final state</h2><p>The browser carries a portable signed snapshot. Serverless instances can reconstruct it after cold starts without Postgres, Neon, Blob, or another state service.</p></div>
        <div className="onboarding-steps">
          <div><span>01</span><b>Create</b><p>Open a signed bilateral session.</p></div>
          <div><span>02</span><b>Reconcile</b><p>Exchange signed events and explicit acknowledgements.</p></div>
          <div><span>03</span><b>Verify</b><p>Close, validate, export, and optionally checkpoint.</p></div>
        </div>
      </section>
      <section className="card evidence-tools empty-tools">
        <div><small>Portable evidence</small><h2>Resume from an exported snapshot</h2><p className="subtle">Import a previous EventMesh JSON file. It is accepted only after signature and hash-chain verification.</p></div>
        <div className="tool-actions"><button className="secondary" onClick={() => importRef.current?.click()}>Import evidence</button><input ref={importRef} className="hidden-input" type="file" accept="application/json,.json" onChange={e => void importEvidence(e.target.files?.[0])}/></div>
      </section>
    </> : <>
      <section className="session card">
        <div className="session-id"><small>Session</small><b title={sessionId}>{short(sessionId, 18)}</b><button className="mini-link" onClick={() => void copy(sessionId)}>Copy</button></div>
        <div><small>Status</small><b className={`status ${closed ? "closed" : "active"}`}>{closed ? "Closed" : "Active"}</b></div>
        <div><small>Events</small><b>{events.length}</b></div>
        <div><small>Progress</small><b>{progress}/5</b></div>
        <button className="secondary new-session" onClick={newSession}>New preview</button>
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

          <div className="note-box">
            <div><small>Reconciliation note</small><p className="subtle">Attach an accepted operator note without changing the reference-flow progress.</p></div>
            <div className="note-row"><input value={note} maxLength={500} disabled={closed || !!busy} placeholder="e.g. receiver retried after timeout" onChange={e => setNote(e.target.value)}/><button className="secondary" disabled={!note.trim() || closed || !!busy} onClick={addNote}>Add note</button></div>
          </div>
        </article>

        <aside className="side-stack">
          <article className="card capability-card">
            <div className="section-head"><div><small>Integrity</small><h2>Portable verification</h2></div><span className="capability available">Built in</span></div>
            <p className="subtle">Re-verify both operator signatures, event hashes, previous-hash links, acknowledgements, and the final commitment.</p>
            <button disabled={!!busy} onClick={verify}>{busy === "verify" ? "Verifying…" : "Verify current evidence"}</button>
            <div className="checkpoint"><small>Chain tip</small><code title={chainTip}>{short(chainTip, 16)}</code>{transcriptRoot && <><small>Transcript root</small><code title={transcriptRoot}>{short(transcriptRoot, 16)}</code></>}</div>
          </article>

          <article className="card capability-card">
            <div className="section-head"><div><small>Value binding</small><h2>Fiber payment proof</h2></div><span className={`capability ${capabilities.fiberPayments ? "available" : "inactive"}`}>{capabilities.fiberPayments ? "Available" : "Not enabled"}</span></div>
            {capabilities.fiberPayments ? <>
              <label>Payment hash<input value={paymentHash} onChange={e => setPaymentHash(e.target.value)}/></label>
              <div className="grid two compact"><label>Amount<input value={amount} onChange={e => setAmount(e.target.value)}/></label><label>Currency<select value={currency} onChange={e => setCurrency(e.target.value)}><option>Fibt</option><option>Fibb</option><option>Fibd</option></select></label></div>
              <button disabled={!!busy || has("PAYMENT_SETTLED") || closed} onClick={settle}>{has("PAYMENT_SETTLED") ? "Payment verified" : "Verify payment proof"}</button>
            </> : <p className="subtle">Optional receiver-side Fiber verification is disabled. EventMesh never fabricates PAYMENT_SETTLED in preview mode.</p>}
          </article>

          <article className="card capability-card">
            <div className="section-head"><div><small>Settlement evidence</small><h2>CKB checkpoint</h2></div><span className={`capability ${capabilities.ckbAnchoring ? "available" : "inactive"}`}>{capabilities.ckbAnchoring ? "Available" : "Read-only"}</span></div>
            <p className="subtle">Optionally bind a closed commitment to CKB Testnet. Broadcasting remains disabled unless a server-side testnet key is explicitly configured.</p>
            {capabilities.ckbAnchoring && <button disabled={!!busy || !closed || !!state?.anchor} onClick={anchor}>{state?.anchor ? "Checkpoint submitted" : "Submit checkpoint"}</button>}
            {state?.anchorOperation?.txHash && <div className="checkpoint"><small>Transaction</small><code>{short(state.anchorOperation.txHash, 16)}</code>{capabilities.ckbReconciliation && <button className="text-button" disabled={!!busy} onClick={reconcile}>Verify on CKB</button>}</div>}
          </article>
        </aside>
      </section>

      <section className="card evidence-card">
        <div className="section-head"><div><small>Evidence</small><h2>Signed event timeline</h2></div><div className="tool-actions"><button className="secondary" onClick={() => importRef.current?.click()}>Import</button><button className="secondary" onClick={download}>Export</button><input ref={importRef} className="hidden-input" type="file" accept="application/json,.json" onChange={e => void importEvidence(e.target.files?.[0])}/></div></div>
        <div className="timeline">{events.length ? events.map((row: any) => <div className="event" key={row.event.eventHash}><span>#{row.event.sequence}</span><div className="event-main"><b>{row.event.type.replaceAll("_", " ")}</b><small>{row.event.sender === info?.operatorA ? "A → B" : "B → A"} · Accepted</small></div><code title={row.event.eventHash}>{short(row.event.eventHash, 16)}</code></div>) : <p className="muted">No events yet.</p>}</div>
        {verification && <div className="verification-result"><span className="check">✓</span><div><b>Evidence verified</b><small>{verification.eventCount} events · {verification.status} · transcript {short(verification.transcriptRoot, 12)}</small></div></div>}
        {state?.close && <details><summary>View final commitment</summary><pre>{JSON.stringify(state.close, null, 2)}</pre></details>}
      </section>
    </>}

    <footer><span>EventMesh v{info?.version || "0.5"}</span><span>Database-free Testnet preview · Do not use production funds</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
