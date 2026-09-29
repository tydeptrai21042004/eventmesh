import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const A = import.meta.env.VITE_OPERATOR_A_URL ?? "http://localhost:4001";
const B = import.meta.env.VITE_OPERATOR_B_URL ?? "http://localhost:4002";

type Side = "A" | "B";

function App() {
  const [health, setHealth] = useState<any>({});
  const [sessionId, setSessionId] = useState("");
  const [session, setSession] = useState<any>();
  const [summary, setSummary] = useState<any>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem("eventmesh-admin-token") ?? "");
  const [requestId, setRequestId] = useState(() => `req-${crypto.randomUUID().slice(0, 8)}`);
  const [service, setService] = useState("dataset-transform");
  const [resultHash, setResultHash] = useState(`0x${"ab".repeat(32)}`);
  const [amount, setAmount] = useState("100000000");
  const [currency, setCurrency] = useState("Fibt");
  const [invoice, setInvoice] = useState<any>();
  const [payment, setPayment] = useState<any>();

  const api = async (url: string, options?: RequestInit, privileged = true) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    Object.assign(headers, options?.headers ?? {});
    if (privileged && adminToken) headers["x-eventmesh-admin-token"] = adminToken;
    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text }; }
    if (!response.ok) throw new Error(body.detail || body.error || text || `HTTP ${response.status}`);
    return body;
  };

  const run = async (label: string, action: () => Promise<void>) => {
    try {
      setBusy(label); setError(""); setNotice("");
      await action();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy("");
    }
  };

  const refresh = async (id = sessionId) => {
    if (!id) return;
    const [nextSession, nextSummary] = await Promise.all([
      api(`${A}/admin/sessions/${id}`),
      api(`${A}/admin/sessions/${id}/evidence-summary`)
    ]);
    setSession(nextSession);
    setSummary(nextSummary);
  };

  useEffect(() => {
    Promise.all([api(`${A}/health`, undefined, false), api(`${B}/health`, undefined, false)])
      .then(([a, b]) => setHealth({ a, b }))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => refresh().catch(() => undefined), 1800);
    return () => clearInterval(timer);
  }, [sessionId, adminToken]);

  const events: any[] = session?.events ?? [];
  const has = (type: string) => events.some((row) => row.event.type === type && row.ack?.decision === "ACCEPT");
  const last = events.at(-1);
  const fiberReady = !!health.a?.fiberEnabled && !!health.b?.fiberEnabled;
  const ckbReady = !!health.a?.ckbAnchorEnabled && !!health.b?.ckbVerificationEnabled;

  const paymentClaim = useMemo(() => {
    const fromEvent = events.find((row) => row.event.type === "PAYMENT_SETTLED")?.event.payload;
    return fromEvent ?? invoice?.eventMeshClaim;
  }, [events, invoice]);

  const create = () => run("create", async () => {
    const signed = await api(`${A}/admin/sessions`, { method: "POST", body: "{}" });
    const id = signed.session.sessionId;
    setSessionId(id);
    setRequestId(`req-${crypto.randomUUID().slice(0, 8)}`);
    setInvoice(undefined); setPayment(undefined);
    await refresh(id);
    setNotice("Two independently keyed operators signed the session.");
  });

  const acceptedEvent = async (sender: Side, type: string, payload: unknown) => {
    const senderBase = sender === "A" ? A : B;
    const receiverBase = sender === "A" ? B : A;
    const event = await api(`${senderBase}/admin/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ type, payload })
    });
    const ack = await api(`${receiverBase}/admin/sessions/${sessionId}/events/${event.eventHash}/ack`, {
      method: "POST",
      body: JSON.stringify({ decision: "ACCEPT" })
    });
    await refresh();
    return { event, ack };
  };

  const step = (label: string, sender: Side, type: string, payload: unknown) => run(label, async () => {
    await acceptedEvent(sender, type, payload);
    setNotice(`${type} was signed by ${sender} and explicitly ACCEPTed by the counterparty.`);
  });

  const createInvoice = () => run("invoice", async () => {
    const result = await api(`${B}/admin/fiber/new-invoice`, {
      method: "POST",
      body: JSON.stringify({ sessionId, amount, currency, description: `paid-service:${requestId}` })
    });
    setInvoice(result);
    setNotice("Receiver B created a Fiber invoice bound to this EventMesh session.");
  });

  const payInvoice = () => run("pay", async () => {
    if (!invoice?.invoice_address) throw new Error("Receiver invoice has no invoice_address");
    const result = await api(`${A}/admin/fiber/send-payment`, {
      method: "POST",
      body: JSON.stringify({ invoice: invoice.invoice_address })
    });
    setPayment(result);
    setNotice("Sender A submitted the Fiber payment. Wait until receiver FNN reports Paid before settling the EventMesh event.");
  });

  const settlePayment = () => run("settle", async () => {
    if (!invoice?.eventMeshClaim) throw new Error("Create the receiver invoice first");
    await acceptedEvent("A", "PAYMENT_SETTLED", invoice.eventMeshClaim);
    setNotice("PAYMENT_SETTLED accepted: B independently re-queried its own FNN before signing ACCEPT.");
  });

  const complete = () => step("complete", "B", "SESSION_COMPLETED", { requestId });

  const close = () => run("close", async () => {
    await api(`${A}/admin/sessions/${sessionId}/close`, {
      method: "POST",
      body: JSON.stringify({
        finalState: {
          kind: "paid-service",
          requestId,
          service,
          resultHash,
          ...(paymentClaim?.paymentHash ? { paymentHash: paymentClaim.paymentHash } : {}),
          completed: true
        }
      })
    });
    await refresh();
    setNotice("Both operators signed the same final transcript/state commitment.");
  });

  const anchor = () => run("anchor", async () => {
    await api(`${A}/admin/sessions/${sessionId}/anchor`, { method: "POST", body: "{}" });
    await refresh();
    setNotice("CKB anchor broadcast. PENDING is expected until the transaction is committed.");
  });

  const reconcileAnchor = () => run("reconcile", async () => {
    await api(`${A}/admin/sessions/${sessionId}/anchor/reconcile`, { method: "POST", body: "{}" });
    await refresh();
    setNotice("Anchor reconciled against CKB RPC and notified to the peer when committed.");
  });

  const replayAck = () => run("replay", async () => {
    if (!last?.ack) throw new Error("No acknowledged event to replay");
    const receiver = last.event.sender === health.a?.publicKey ? B : A;
    const result = await api(`${receiver}/admin/sessions/${sessionId}/events/${last.event.eventHash}/ack`, {
      method: "POST",
      body: JSON.stringify({ decision: last.ack.decision })
    });
    if (!result.duplicate) throw new Error("Expected idempotent duplicate ACK result");
    await refresh();
    setNotice("Duplicate ACK replayed safely: the original signed evidence remained canonical.");
  });

  const retryDelivery = () => run("retry", async () => {
    if (!last) throw new Error("No event to retry");
    const sender = last.event.sender === health.a?.publicKey ? A : B;
    await api(`${sender}/admin/sessions/${sessionId}/events/${last.event.eventHash}/retry`, { method: "POST", body: "{}" });
    await refresh();
    setNotice("Sender retry completed without creating a second application event.");
  });

  const download = () => run("export", async () => {
    const transcript = await api(`${A}/admin/sessions/${sessionId}/transcript`);
    const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${sessionId}.json`; anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Transcript exported for standalone verification.");
  });

  const saveToken = (value: string) => {
    setAdminToken(value);
    if (value) sessionStorage.setItem("eventmesh-admin-token", value);
    else sessionStorage.removeItem("eventmesh-admin-token");
  };

  return <main>
    <header className="hero">
      <div>
        <div className="eyebrow">CKB + Fiber · cross-operator reconciliation</div>
        <h1>EventMesh <span>v0.2</span></h1>
        <p className="lede">Fiber can prove value moved. EventMesh proves which application event both independent operators accepted when retries, crashes, or partial failures make local state uncertain.</p>
      </div>
      <button className="primary" onClick={create} disabled={!!busy}>{busy === "create" ? "Creating…" : "Start reconciliation session"}</button>
    </header>

    <section className="pain-grid">
      <div className="pain"><b>Failure to cure</b><span>Payment = Paid</span><span>Operator A = completed</span><span>Operator B = uncertain</span></div>
      <div className="arrow">→</div>
      <div className="pain solved"><b>EventMesh outcome</b><span>same signed event</span><span>same explicit ACK</span><span>same final proof</span></div>
    </section>

    <details className="settings">
      <summary>Reviewer / local admin settings</summary>
      <p>Leave blank in local development mode. For a protected reviewer deployment, enter the admin token here; it is stored only in this browser tab/session and is never compiled into the app.</p>
      <input type="password" value={adminToken} onChange={(e) => saveToken(e.target.value)} placeholder="x-eventmesh-admin-token" />
    </details>

    {error && <div className="banner error"><b>Action failed</b>{error}</div>}
    {notice && <div className="banner notice">{notice}</div>}

    <section className="operators">
      <Operator title="Operator A · requester/payer" h={health.a} />
      <Operator title="Operator B · provider/receiver" h={health.b} />
    </section>

    {!sessionId ? <section className="empty"><b>No shared database. No shared operator key.</b><p>Start a session to see both operators explicitly reconcile one paid-service workflow.</p></section> : <>
      <section className="session-bar">
        <div><small>SESSION</small><b>{sessionId}</b></div>
        <div><small>STATE</small><b>{session?.status ?? "loading"}</b></div>
        <div><small>PATH</small><b>{fiberReady ? "Fiber-capable" : "Local bilateral"}</b></div>
      </section>

      <section className="workspace">
        <div className="scenario panel">
          <div className="section-title"><div><span>Reference scenario</span><h2>Paid cross-operator service</h2></div><small>Guided, not generic JSON</small></div>
          <div className="form-row"><label>Request ID<input value={requestId} onChange={(e) => setRequestId(e.target.value)} disabled={events.length > 0} /></label><label>Service<input value={service} onChange={(e) => setService(e.target.value)} disabled={events.length > 0} /></label></div>

          <Step n="1" title="Request service" detail="A signs the business request; B explicitly accepts the exact event hash." done={has("SERVICE_REQUESTED")} disabled={events.length > 0 || !!busy} onClick={() => step("request", "A", "SERVICE_REQUESTED", { requestId, service })} />
          <Step n="2" title="Provider accepts" detail="B records that it accepted this request; A acknowledges B's event." done={has("SERVICE_ACCEPTED")} disabled={!has("SERVICE_REQUESTED") || has("SERVICE_ACCEPTED") || !!busy} onClick={() => step("accept", "B", "SERVICE_ACCEPTED", { requestId })} />
          <div className="hash-row"><label>Result commitment<input value={resultHash} onChange={(e) => setResultHash(e.target.value)} /></label></div>
          <Step n="3" title="Commit result" detail="Only a result hash enters the bilateral transcript; application payload stays outside EventMesh." done={has("RESULT_COMMITTED")} disabled={!has("SERVICE_ACCEPTED") || has("RESULT_COMMITTED") || !!busy} onClick={() => step("result", "B", "RESULT_COMMITTED", { requestId, resultHash })} />

          <div className={`fiber-box ${fiberReady ? "ready" : "offline"}`}>
            <div className="section-title"><div><span>Optional value binding</span><h3>Real Fiber receiver proof</h3></div><small>{fiberReady ? "Both FNNs enabled" : "Enable both FNNs for funded proof"}</small></div>
            <div className="form-row"><label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label><label>Currency<select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>Fibt</option><option>Fibb</option><option>Fibd</option></select></label></div>
            <div className="button-row">
              <button onClick={createInvoice} disabled={!fiberReady || !has("RESULT_COMMITTED") || !!invoice || !!busy}>A. Receiver creates invoice</button>
              <button onClick={payInvoice} disabled={!invoice?.invoice_address || !!payment || !!busy}>B. Sender pays invoice</button>
              <button onClick={settlePayment} disabled={!invoice?.eventMeshClaim || has("PAYMENT_SETTLED") || !!busy}>C. Verify + accept settlement</button>
            </div>
            {invoice?.invoice_address && <code className="long">invoice {invoice.invoice_address}</code>}
            {payment?.payment_hash && <code className="long">sender payment {payment.payment_hash} · {payment.status}</code>}
            {invoice?.eventMeshClaim?.paymentHash && <code className="long">receiver-bound claim {invoice.eventMeshClaim.paymentHash}</code>}
          </div>

          <Step n="4" title="Complete business session" detail={fiberReady ? "For the funding-grade path, do this only after PAYMENT_SETTLED is accepted." : "Local mode can complete without payment; it proves bilateral reconciliation only."} done={has("SESSION_COMPLETED")} disabled={!has("RESULT_COMMITTED") || (fiberReady && !has("PAYMENT_SETTLED")) || has("SESSION_COMPLETED") || !!busy} onClick={complete} />
          <Step n="5" title="Dual-sign final state" detail="A derives the transcript roots; B independently checks its local transcript before signing the same close." done={!!summary?.close?.dualSigned} disabled={!has("SESSION_COMPLETED") || !!summary?.close?.present || !!busy} onClick={close} />
        </div>

        <div className="proof panel">
          <div className="section-title"><div><span>Machine-readable evidence</span><h2>Reconciliation proof</h2></div><small>/evidence-summary</small></div>
          <ProofRow label="Bilateral session signatures" value={summary?.readiness?.bilateralSession} />
          <ProofRow label="All application events final" value={summary?.readiness?.allEventsFinal} />
          <ProofRow label="All events explicitly accepted" value={summary?.readiness?.allEventsAccepted} />
          <ProofRow label="No recorded conflicts" value={summary?.readiness?.noRecordedConflicts} />
          <ProofRow label="Receiver Fiber evidence" value={summary?.payments?.acceptedClaims ? summary?.readiness?.receiverPaymentEvidenceComplete : undefined} detail={summary?.payments?.acceptedClaims ? `${summary.payments.receiverEvidence}/${summary.payments.acceptedClaims} accepted payment(s)` : "not bound in this session"} />
          <ProofRow label="Dual-signed close" value={summary?.readiness?.closeDualSigned} />
          <ProofRow label="CKB committed" value={summary?.readiness?.ckbCommitted} detail={summary?.ckb?.anchorStatus ?? "NONE"} />
          {summary?.close?.transcriptRoot && <div className="root-card"><small>TRANSCRIPT ROOT</small><code>{summary.close.transcriptRoot}</code></div>}
          {summary?.close?.paymentEvidenceRoot && <div className="root-card"><small>PAYMENT EVIDENCE ROOT</small><code>{summary.close.paymentEvidenceRoot}</code></div>}
          <div className="button-stack">
            <button className="secondary" onClick={download} disabled={!!busy}>Export transcript</button>
            <button onClick={anchor} disabled={!ckbReady || !summary?.close?.dualSigned || summary?.ckb?.anchorStatus !== "NONE" || !!busy}>Broadcast CKB commitment</button>
            <button onClick={reconcileAnchor} disabled={!ckbReady || summary?.ckb?.anchorStatus !== "PENDING" || !!busy}>Reconcile CKB commitment</button>
          </div>
          {!ckbReady && <p className="hint">Full proof requires A to broadcast and B to independently verify against a CKB Testnet RPC.</p>}
        </div>
      </section>

      <section className="panel failure-lab">
        <div className="section-title"><div><span>Failure lab</span><h2>Show why reconciliation exists</h2></div><small>safe replay tests</small></div>
        <div className="failure-grid">
          <button className="secondary" onClick={replayAck} disabled={!last?.ack || !!busy}>Replay last ACK</button>
          <button className="secondary" onClick={retryDelivery} disabled={!last || !!busy}>Retry last event delivery</button>
          <div className="recipe"><b>Funding-grade crash test</b><span>1. Pay Fiber invoice</span><span>2. Stop receiver before application ACK</span><span>3. Restart from the same SQLite volume</span><span>4. Re-run settlement ACK</span><span>5. Prove exactly one accepted business transition</span></div>
        </div>
      </section>

      <section className="timeline panel">
        <div className="section-title"><div><span>Immutable transcript</span><h2>What both sides accepted</h2></div><small>{events.length} event(s)</small></div>
        {events.length ? events.map((row: any) => <article key={row.event.eventHash}>
          <div className="seq">#{row.event.sequence}</div>
          <div className="event"><b>{row.event.type}</b><code>{JSON.stringify(row.event.payload)}</code><small>{row.event.sender === health.a?.publicKey ? "A" : "B"} · {row.event.eventHash.slice(0, 22)}…</small></div>
          <div className={`status ${row.status.toLowerCase()}`}>{row.ack?.decision ?? row.status}</div>
        </article>) : <div className="empty inner">No events yet.</div>}
      </section>
    </>}

    <footer>EventMesh does not replace Fiber, wallets, access control, escrow, application execution, routing, or consensus. It reconciles evidence between independently operated applications.</footer>
  </main>;
}

function Operator({ title, h }: { title: string; h: any }) {
  return <div className="operator-card"><div className="operator-title"><span className={h?.status === "ok" ? "dot on" : "dot"} />{title}</div><code>{h?.publicKey ? h.publicKey.slice(0, 34) + "…" : "offline"}</code><div className="chips"><span>Fiber {h?.fiberEnabled ? "ON" : "OFF"}</span><span>CKB anchor {h?.ckbAnchorEnabled ? "ON" : "OFF"}</span><span>CKB verify {h?.ckbVerificationEnabled ? "ON" : "OFF"}</span></div></div>;
}

function Step({ n, title, detail, done, disabled, onClick }: { n: string; title: string; detail: string; done: boolean; disabled: boolean; onClick: () => void }) {
  return <div className={`step ${done ? "done" : ""}`}><div className="step-num">{done ? "✓" : n}</div><div><b>{title}</b><p>{detail}</p></div><button onClick={onClick} disabled={disabled}>{done ? "Accepted" : "Run"}</button></div>;
}

function ProofRow({ label, value, detail }: { label: string; value?: boolean; detail?: string }) {
  const state = value === undefined ? "na" : value ? "pass" : "wait";
  return <div className="proof-row"><span className={`proof-dot ${state}`} /> <div><b>{label}</b>{detail && <small>{detail}</small>}</div><strong>{value === undefined ? "N/A" : value ? "PASS" : "WAIT"}</strong></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
