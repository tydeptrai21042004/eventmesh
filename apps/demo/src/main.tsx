import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type WorkspaceMode = "demo" | "testnet";
type State = any;

type PublicInfo = {
  ok?: boolean;
  protocol?: string;
  version?: string;
  network?: string;
  storage?: { mode?: string; durable?: boolean; portableRecovery?: boolean };
  workspaces?: {
    demo?: any;
    testnet?: any;
  };
  capabilities?: {
    fiberPayments?: boolean;
    ckbAnchoring?: boolean;
    ckbReconciliation?: boolean;
  };
  security?: Record<string, unknown>;
};

type ApiFailure = Error & { code?: string; status?: number };

const ZERO_HASH = `0x${"00".repeat(32)}`;
const TAB_ID = crypto.randomUUID();
const STORAGE_KEYS: Record<WorkspaceMode, string> = {
  demo: "eventmesh-demo-snapshot-v2",
  testnet: "eventmesh-testnet-snapshot-v2"
};

const newKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

function workspaceStorage(mode: WorkspaceMode) {
  return mode === "demo" ? localStorage : sessionStorage;
}

function readStoredState(mode: WorkspaceMode): State | undefined {
  try {
    return JSON.parse(workspaceStorage(mode).getItem(STORAGE_KEYS[mode]) || "null") || undefined;
  } catch {
    return undefined;
  }
}

function chainPrecondition(snapshot?: State) {
  const events = snapshot?.events || [];
  return {
    expectedEventCount: events.length,
    expectedChainTip: events.at(-1)?.event?.eventHash || ZERO_HASH
  };
}

function safeWorkspaceFromSnapshot(snapshot: any): WorkspaceMode {
  return snapshot?.signedSession?.session?.environment === "TESTNET" || snapshot?.workspaceMode === "testnet"
    ? "testnet"
    : "demo";
}

async function parseApiResponse(response: Response) {
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const failure = new Error(response.status >= 500
      ? "The EventMesh API is temporarily unavailable."
      : "The response could not be parsed.") as ApiFailure;
    failure.status = response.status;
    throw failure;
  }

  if (!response.ok) {
    const code = String(payload?.error || "");
    const safeErrors: Record<string, string> = {
      RATE_LIMITED: "Too many requests. Try again shortly.",
      SESSION_NOT_FOUND: "This server instance no longer has the session cache. Use the signed browser snapshot or import evidence to recover it.",
      TESTNET_WORKSPACE_DISABLED: "Real / Testnet mode is disabled on this deployment.",
      TESTNET_OPERATOR_KEYS_REQUIRED: "Real / Testnet mode requires explicit Operator A and Operator B private keys on the server.",
      TESTNET_ACCESS_KEY_NOT_CONFIGURED: "Real / Testnet access control is not configured on the server.",
      TESTNET_ACCESS_DENIED: "The Testnet access key is missing or incorrect.",
      STATE_PRECONDITION_FAILED: "The session changed since this tab last saw it. Sync from the server before submitting another action.",
      EVENT_TYPE_NOT_ALLOWED: "That event type is not allowed by the service-flow policy.",
      REFERENCE_FLOW_INCOMPLETE: "Complete the four signed service steps before closing the session.",
      CKB_BROADCAST_DISABLED: "CKB broadcasting is disabled. Enable it explicitly for the Real / Testnet workspace.",
      ANCHOR_REQUIRES_TESTNET_WORKSPACE: "CKB checkpoint broadcasting is available only from the Real / Testnet workspace.",
      FIBER_RECEIVER_RPC_REQUIRED_FOR_PAYMENT_ACCEPT: "A receiver-side Fiber RPC is required before PAYMENT_SETTLED can be accepted.",
      FIBER_RECEIVER_UNAVAILABLE: "The receiver-side Fiber service is not reachable.",
      DEMO_MASTER_SECRET_REQUIRED: "Set DEMO_MASTER_SECRET to enable stable demo signing identities.",
      DEMO_MASTER_SECRET_TOO_SHORT: "DEMO_MASTER_SECRET must be at least 32 characters."
    };
    let message = safeErrors[code];
    if (!message && code.startsWith("REFERENCE_FLOW_INCOMPLETE")) message = safeErrors.REFERENCE_FLOW_INCOMPLETE;
    if (!message && code.startsWith("SNAPSHOT_VERIFICATION_FAILED")) message = "The portable snapshot failed signature, hash-chain, or commitment verification.";
    if (!message && code.startsWith("INVALID_")) message = "One or more fields failed server-side validation.";
    if (!message && code.includes("MUST_BE_SENT_BY")) message = "The selected operator is not allowed to submit this event type.";
    const failure = new Error(message || (response.status >= 500 ? "The EventMesh API is temporarily unavailable." : code || "The action could not be completed.")) as ApiFailure;
    failure.code = code;
    failure.status = response.status;
    throw failure;
  }
  return payload;
}

async function apiRequest(options: {
  body?: any;
  sessionId?: string;
  mode?: WorkspaceMode;
  accessKey?: string;
}) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body) headers["content-type"] = "application/json";
  if (options.mode === "testnet" && options.accessKey) headers["x-eventmesh-access-key"] = options.accessKey;
  const response = await fetch(options.sessionId ? `/api/demo?sessionId=${encodeURIComponent(options.sessionId)}` : "/api/demo", {
    method: options.body ? "POST" : "GET",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  return parseApiResponse(response);
}

function short(value?: string, n = 13) {
  if (!value) return "—";
  return value.length <= n * 2 ? value : `${value.slice(0, n)}…${value.slice(-n)}`;
}

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function normalizeImportedSnapshot(value: any) {
  if (value?.signedSession) return value;
  if (value?.session?.session && Array.isArray(value?.events)) {
    const workspaceMode: WorkspaceMode = value?.manifest?.workspace === "testnet" || value.session.session.environment === "TESTNET" ? "testnet" : "demo";
    return {
      sessionId: value.session.session.sessionId,
      workspaceMode,
      status: value.close ? "CLOSED" : "ACTIVE",
      signedSession: value.session,
      events: value.events.map((row: any) => ({ ...row, status: "FINAL" })),
      close: value.close || null,
      anchor: value.ckbAnchor || null,
      anchorOperation: value.anchorOperation || null,
      paymentEvidence: value.paymentEvidence || []
    };
  }
  throw new Error("This JSON file is not an EventMesh evidence snapshot.");
}

function App() {
  const initialMode = (localStorage.getItem("eventmesh-last-workspace") === "testnet" ? "testnet" : "demo") as WorkspaceMode;
  const [mode, setMode] = useState<WorkspaceMode>(initialMode);
  const [info, setInfo] = useState<PublicInfo>();
  const [health, setHealth] = useState<any>();
  const [state, setState] = useState<State>(() => readStoredState(initialMode));
  const [sessionId, setSessionId] = useState(() => state?.sessionId || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [notice, setNotice] = useState(state ? "A signed session was restored from this browser." : "");
  const [accessKey, setAccessKey] = useState("");
  const [showAccessKey, setShowAccessKey] = useState(false);
  const [leaseConflict, setLeaseConflict] = useState(false);
  const [timelineFilter, setTimelineFilter] = useState("");

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
      setInfo(await apiRequest({}));
    } catch (e: any) {
      setInfo({ ok: false, network: "CKB Testnet" });
      setError(e?.message || "The EventMesh API is temporarily unavailable.");
    }
  };

  const loadHealth = async () => {
    try {
      const response = await fetch("/api/health?deep=1", { headers: { accept: "application/json" }, cache: "no-store" });
      setHealth(await parseApiResponse(response));
    } catch (e: any) {
      setHealth({ ok: false, error: e?.message || "Health check unavailable" });
    }
  };

  useEffect(() => { void loadInfo(); }, []);
  useEffect(() => {
    localStorage.setItem("eventmesh-last-workspace", mode);
    if (mode === "testnet") void loadHealth();
  }, [mode]);

  useEffect(() => {
    const storage = workspaceStorage(mode);
    if (state?.sessionId) storage.setItem(STORAGE_KEYS[mode], JSON.stringify(state));
    else storage.removeItem(STORAGE_KEYS[mode]);
  }, [state, mode]);

  useEffect(() => {
    if (!sessionId || state?.status === "CLOSED") {
      setLeaseConflict(false);
      return;
    }
    const leaseKey = `eventmesh-edit-lease:${mode}:${sessionId}`;
    const inspectAndClaim = (force = false) => {
      let existing: any;
      try { existing = JSON.parse(localStorage.getItem(leaseKey) || "null"); } catch { existing = null; }
      const now = Date.now();
      if (!force && existing?.tabId && existing.tabId !== TAB_ID && Number(existing.expiresAt) > now) {
        setLeaseConflict(true);
        return;
      }
      localStorage.setItem(leaseKey, JSON.stringify({ tabId: TAB_ID, expiresAt: now + 15000 }));
      setLeaseConflict(false);
    };
    inspectAndClaim();
    const timer = window.setInterval(() => inspectAndClaim(), 5000);
    const onStorage = (event: StorageEvent) => { if (event.key === leaseKey) inspectAndClaim(); };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      try {
        const existing = JSON.parse(localStorage.getItem(leaseKey) || "null");
        if (existing?.tabId === TAB_ID) localStorage.removeItem(leaseKey);
      } catch { /* no-op */ }
    };
  }, [mode, sessionId, state?.status]);

  const hydrateForm = (next?: State) => {
    const requestEvent = (next?.events || []).find((row: any) => row?.event?.type === "SERVICE_REQUESTED");
    const resultEvent = (next?.events || []).find((row: any) => row?.event?.type === "RESULT_COMMITTED");
    const paymentEvent = (next?.events || []).find((row: any) => row?.event?.type === "PAYMENT_SETTLED");
    setRequestId(requestEvent?.event?.payload?.requestId || next?.close?.finalState?.requestId || `req-${crypto.randomUUID().slice(0, 8)}`);
    setService(requestEvent?.event?.payload?.service || next?.close?.finalState?.service || "dataset-transform");
    setResultHash(resultEvent?.event?.payload?.resultHash || next?.close?.finalState?.resultHash || `0x${"ab".repeat(32)}`);
    setPaymentHash(paymentEvent?.event?.payload?.paymentHash || next?.close?.finalState?.paymentHash || `0x${"11".repeat(32)}`);
  };

  const adoptState = (next: any) => {
    if (!next) return;
    const nextMode = safeWorkspaceFromSnapshot(next);
    if (nextMode !== mode) setMode(nextMode);
    setState(next);
    setSessionId(next.sessionId || next.signedSession?.session?.sessionId || "");
    hydrateForm(next);
    setVerification(undefined);
  };

  const switchMode = (next: WorkspaceMode) => {
    if (next === mode || busy) return;
    const restored = readStoredState(next);
    setMode(next);
    setState(restored);
    setSessionId(restored?.sessionId || "");
    setVerification(undefined);
    setError("");
    setErrorCode("");
    setNotice(restored ? `${next === "demo" ? "Demo" : "Testnet"} session restored in this browser.` : "");
    hydrateForm(restored);
  };

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setError("");
    setErrorCode("");
    setNotice("");
    try {
      return await fn();
    } catch (e: any) {
      setError(e?.message || "The action could not be completed.");
      setErrorCode(e?.code || "");
    } finally {
      setBusy("");
    }
  };

  const post = (body: any, snapshot: any = state, requestMode: WorkspaceMode = mode) => apiRequest({
    mode: requestMode,
    accessKey,
    body: { ...body, ...(snapshot ? { snapshot } : {}) }
  });

  const events = state?.events ?? [];
  const has = (type: string) => events.some((row: any) => row.event.type === type && row.ack?.decision === "ACCEPT");
  const closed = state?.status === "CLOSED";
  const selectedWorkspace = mode === "demo" ? info?.workspaces?.demo : info?.workspaces?.testnet;
  const selectedOperatorA = selectedWorkspace?.operatorA || info?.workspaces?.demo?.operatorA;
  const selectedOperatorB = selectedWorkspace?.operatorB || info?.workspaces?.demo?.operatorB;
  const capabilities = info?.capabilities ?? {};
  const workspaceReady = mode === "demo" ? !!selectedWorkspace?.ready : !!selectedWorkspace?.ready && !!accessKey;
  const mutateBlocked = !!busy || leaseConflict;

  const create = () => run("create", async () => {
    const keyName = `eventmesh-create-idempotency:${mode}`;
    const stored = sessionStorage.getItem(keyName) || newKey(`${mode}-create`);
    sessionStorage.setItem(keyName, stored);
    const result = await apiRequest({
      mode,
      accessKey,
      body: { action: "create_session", mode, idempotencyKey: stored }
    });
    sessionStorage.removeItem(keyName);
    adoptState(result.state || await apiRequest({ sessionId: result.sessionId, mode, accessKey }));
    setNotice(mode === "demo"
      ? "Signed demo session created. Its verified snapshot is recoverable from this browser."
      : "Connected Testnet session created with explicit server-side operator identities.");
  });

  const append = async (snapshot: any, sender: "A" | "B", type: string, payload: any, idemSuffix: string) => {
    const sid = snapshot?.sessionId || sessionId;
    return post({
      action: "append_event",
      sessionId: sid,
      sender,
      type,
      payload,
      idempotencyKey: `${sid}:${idemSuffix}`,
      ...chainPrecondition(snapshot)
    }, snapshot);
  };

  const event = (label: string, sender: "A" | "B", type: string, payload: any, idemSuffix = `${type}:${requestId}`) => run(label, async () => {
    const result = await append(state, sender, type, payload, idemSuffix);
    adoptState(result.state);
    setNotice(`${type.replaceAll("_", " ")} was signed and explicitly acknowledged.`);
  });

  const settle = () => event("payment", "A", "PAYMENT_SETTLED", { paymentHash, sessionId, amount, currency });

  const closeWithSnapshot = (snapshot: any) => {
    const sid = snapshot?.sessionId || sessionId;
    const hasPayment = (snapshot?.events || []).some((row: any) => row.event.type === "PAYMENT_SETTLED" && row.ack?.decision === "ACCEPT");
    const finalState = { kind: "paid-service", requestId, service, resultHash, paymentHash: hasPayment ? paymentHash : undefined, completed: true };
    return post({
      action: "close_session",
      sessionId: sid,
      finalState,
      idempotencyKey: `${sid}:close`,
      ...chainPrecondition(snapshot)
    }, snapshot);
  };

  const close = () => run("close", async () => {
    const result = await closeWithSnapshot(state);
    adoptState(result.state);
    setNotice("Session closed with a dual-signed final commitment.");
  });

  const runReferenceFlow = () => run("reference", async () => {
    if (mode !== "demo") throw new Error("The one-click reference flow is intentionally disabled in Real / Testnet mode.");
    let current = state;
    if (!current || current.status === "CLOSED") {
      const created = await apiRequest({ mode: "demo", body: { action: "create_session", mode: "demo", idempotencyKey: newKey("reference-create") } });
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
    setNotice("The demo reference flow completed end-to-end and the final commitment was dual-signed.");
  });

  const addNote = () => {
    const text = note.trim();
    if (!text) return;
    void run("note", async () => {
      const result = await append(state, "A", "RECONCILIATION_NOTE", { requestId, note: text }, `note:${crypto.randomUUID()}`);
      adoptState(result.state);
      setNote("");
      setNotice("Reconciliation note signed and acknowledged.");
    });
  };

  const anchor = () => run("anchor", async () => {
    const result = await post({ action: "anchor", sessionId }, state);
    adoptState(result.state);
    setNotice("CKB Testnet checkpoint submission started with deterministic transaction identity persisted first.");
  });

  const reconcile = () => run("reconcile", async () => {
    const result = await post({ action: "reconcile_anchor", sessionId }, state);
    adoptState(result.state);
    setNotice(result.ok ? "CKB checkpoint verified on Testnet." : "Checkpoint is not committed yet; no blind rebroadcast was attempted.");
  });

  const verify = () => run("verify", async () => {
    if (!state) throw new Error("Create or import a session first.");
    const result = await apiRequest({ mode, accessKey, body: { action: "verify_snapshot", snapshot: state } });
    setVerification(result);
    setNotice(`Evidence verified: ${result.eventCount} signed event${result.eventCount === 1 ? "" : "s"}, hash chain intact.`);
  });

  const syncFromServer = () => run("sync", async () => {
    if (!sessionId) throw new Error("No active session to sync.");
    const latest = await apiRequest({ sessionId, mode, accessKey });
    adoptState(latest);
    setNotice("Session synchronized with the current server cache.");
  });

  const exportEvidence = () => {
    const transcript = {
      manifest: {
        schemaVersion: 2,
        product: "EventMesh",
        appVersion: info?.version || "0.6.0",
        workspace: mode,
        exportedAt: new Date().toISOString(),
        storage: mode === "demo" ? "browser-local portable snapshot" : "browser-session portable snapshot"
      },
      session: state?.signedSession,
      events: (state?.events || []).map((row: any) => ({ event: row.event, ack: row.ack })),
      ...(state?.close ? { close: state.close } : {}),
      ...(state?.paymentEvidence?.length ? { paymentEvidence: state.paymentEvidence } : {}),
      ...(state?.anchor ? { ckbAnchor: state.anchor } : {}),
      ...(state?.anchorOperation ? { anchorOperation: state.anchorOperation } : {})
    };
    const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId || "eventmesh"}-${mode}-evidence.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importEvidence = async (file?: File) => {
    if (!file) return;
    await run("import", async () => {
      if (file.size > 2 * 1024 * 1024) throw new Error("Evidence files larger than 2 MiB are not accepted by this preview.");
      const parsed = normalizeImportedSnapshot(JSON.parse(await file.text()));
      const guessedMode = safeWorkspaceFromSnapshot(parsed);
      const checked = await apiRequest({ mode: guessedMode, accessKey, body: { action: "verify_snapshot", snapshot: parsed } });
      const importedMode = checked.workspaceMode === "testnet" ? "testnet" : "demo";
      parsed.workspaceMode = importedMode;
      setMode(importedMode);
      setState(parsed);
      setSessionId(parsed.sessionId);
      hydrateForm(parsed);
      setVerification(checked);
      setNotice(`Evidence imported and cryptographically verified for ${short(checked.sessionId, 10)}.`);
    });
    if (importRef.current) importRef.current.value = "";
  };

  const copy = async (value?: string, label = "Value") => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied to clipboard.`);
  };

  const copyAuditSummary = async () => {
    const report = {
      sessionId,
      workspace: mode,
      status: state?.status,
      eventCount: events.length,
      chainTip: events.at(-1)?.event?.eventHash || ZERO_HASH,
      transcriptRoot: state?.close?.close?.transcriptRoot || verification?.transcriptRoot || null,
      expiresAt: state?.signedSession?.session?.expiresAt,
      ckbTxHash: state?.anchorOperation?.txHash || state?.anchor?.txHash || null,
      verifiedAt: verification ? new Date().toISOString() : null
    };
    await copy(JSON.stringify(report, null, 2), "Audit summary");
  };

  const newSession = () => {
    setState(undefined);
    setSessionId("");
    setVerification(undefined);
    hydrateForm(undefined);
    setNotice(`${mode === "demo" ? "Demo" : "Testnet"} workspace cleared in this browser.`);
    setError("");
    setErrorCode("");
  };

  const takeControl = () => {
    if (!sessionId) return;
    localStorage.setItem(`eventmesh-edit-lease:${mode}:${sessionId}`, JSON.stringify({ tabId: TAB_ID, expiresAt: Date.now() + 15000 }));
    setLeaseConflict(false);
    setNotice("This tab now holds the browser edit lease. Avoid editing the same session in another tab.");
  };

  const progress = useMemo(() => {
    if (closed) return 5;
    if (has("SESSION_COMPLETED")) return 4;
    if (has("RESULT_COMMITTED")) return 3;
    if (has("SERVICE_ACCEPTED")) return 2;
    if (has("SERVICE_REQUESTED")) return 1;
    return 0;
  }, [events, closed]);

  const filteredEvents = useMemo(() => {
    const q = timelineFilter.trim().toLowerCase();
    if (!q) return events;
    return events.filter((row: any) => JSON.stringify(row).toLowerCase().includes(q));
  }, [events, timelineFilter]);

  const chainTip = events.at(-1)?.event?.eventHash || ZERO_HASH;
  const transcriptRoot = state?.close?.close?.transcriptRoot || verification?.transcriptRoot;
  const sessionExpiresAt = state?.signedSession?.session?.expiresAt;
  const expiresSoon = sessionExpiresAt && Date.parse(sessionExpiresAt) - Date.now() < 10 * 60 * 1000 && !closed;
  const testnetServerReady = !!info?.workspaces?.testnet?.ready;
  const ckbHealthy = health?.ckb?.reachable;
  const fiberHealthy = health?.fiber?.configured ? health?.fiber?.reachable : undefined;

  return <main className={`app-shell mode-${mode}`}>
    <nav className="topbar">
      <div className="brand"><span className="brand-mark">E</span><span>EventMesh</span><span className="version">v{info?.version || "0.6"}</span></div>
      <div className="workspace-switch" aria-label="Workspace selector">
        <button className={mode === "demo" ? "selected" : ""} onClick={() => switchMode("demo")} disabled={!!busy}>Demo</button>
        <button className={mode === "testnet" ? "selected" : ""} onClick={() => switchMode("testnet")} disabled={!!busy}>Real / Testnet</button>
      </div>
      <div className="topbar-meta"><span className="network-dot"/><span>{info?.network || "CKB Testnet"}</span><span className={`environment-pill ${mode}`}>{mode === "demo" ? "Safe preview" : "Connected"}</span></div>
    </nav>

    <header className="hero">
      <div className="hero-copy">
        <div className="eyebrow">{mode === "demo" ? "Safe bilateral reconciliation demo" : "Connected bilateral reconciliation · CKB Testnet"}</div>
        <h1>{mode === "demo" ? "Understand the protocol without risking funds." : "Operate signed Testnet sessions with explicit safeguards."}</h1>
        <p>{mode === "demo"
          ? "Run the full service lifecycle, inspect every signature and commitment, export evidence, and recover after serverless cold starts—without a database."
          : "Use configured operator identities and real Testnet integrations. Automatic flows are disabled; each state transition is explicit, authenticated, and guarded against stale-session writes."}</p>
        <div className="hero-trust">
          <span>Dual signatures</span><span>Hash-chain preconditions</span><span>Portable recovery</span><span>Strict event policy</span><span>{mode === "demo" ? "No database" : "Access controlled"}</span>
        </div>
      </div>
      <div className="hero-action card-lite">
        {mode === "testnet" && <div className="access-panel">
          <div className="access-title"><span>Testnet access key</span><span className="memory-only">Memory only</span></div>
          <div className="secret-row"><input aria-label="Testnet access key" type={showAccessKey ? "text" : "password"} autoComplete="off" spellCheck={false} value={accessKey} onChange={e => setAccessKey(e.target.value)} placeholder="Enter deployment access key"/><button className="icon-button" onClick={() => setShowAccessKey(value => !value)}>{showAccessKey ? "Hide" : "Show"}</button></div>
          <small>This credential is never written to Local Storage or Session Storage.</small>
        </div>}
        <button className="primary large" disabled={!!busy || !workspaceReady} onClick={create}>{busy === "create" ? "Starting…" : mode === "demo" ? "Start demo session" : "Start Testnet session"}</button>
        {mode === "demo" && <button className="secondary" disabled={!!busy || !selectedWorkspace?.ready} onClick={runReferenceFlow}>{busy === "reference" ? "Running full flow…" : "Run full reference flow"}</button>}
        <div className={`readiness-line ${workspaceReady ? "ready" : "warning"}`}><span/>{mode === "demo"
          ? selectedWorkspace?.ready ? "Demo signing service ready" : "Demo signing setup required"
          : !testnetServerReady ? "Testnet server setup incomplete" : accessKey ? "Testnet workspace unlocked for this tab" : "Enter the Testnet access key to continue"}</div>
      </div>
    </header>

    <section className={`mode-banner ${mode}`}>
      <div><b>{mode === "demo" ? "Demo boundary" : "Real / Testnet boundary"}</b><span>{mode === "demo"
        ? "Uses deterministic preview identities. Fiber settlement is never fabricated, and CKB broadcasting is unavailable from this workspace."
        : "Uses explicitly configured operator keys. This is still Testnet: do not use production funds, and separate operator services for production-grade independence."}</span></div>
      {mode === "testnet" && <button className="text-button" onClick={() => void loadHealth()} disabled={busy === "health"}>Refresh readiness</button>}
    </section>

    {error && <div className="banner error"><div><b>{errorCode === "STATE_PRECONDITION_FAILED" ? "Session changed" : "Unable to complete the action"}</b><span>{error}</span></div><div className="banner-actions">{errorCode === "STATE_PRECONDITION_FAILED" && sessionId && <button onClick={syncFromServer}>Sync now</button>}<button aria-label="Dismiss error" onClick={() => { setError(""); setErrorCode(""); }}>×</button></div></div>}
    {notice && <div className="banner ok"><span className="check">✓</span><span>{notice}</span></div>}
    {leaseConflict && <div className="banner warn"><div><b>Another browser tab is editing this session</b><span>This tab is read-only to reduce accidental forks. You can take control if the other tab is no longer in use.</span></div><button onClick={takeControl}>Take control</button></div>}
    {expiresSoon && <div className="banner warn"><div><b>Session expires soon</b><span>Close or export the signed session before {formatTime(sessionExpiresAt)}.</span></div></div>}

    <section className="participants section-block">
      <div className="section-title"><small>Signing identities</small><h2>{mode === "demo" ? "Deterministic demo participants" : "Configured Testnet participants"}</h2></div>
      <div className="grid two">
        <article className="identity-card"><div className="avatar">A</div><div><small>Requester / payer</small><b title={selectedOperatorA}>{short(selectedOperatorA)}</b></div><span className="verified">Server identity</span></article>
        <article className="identity-card"><div className="avatar">B</div><div><small>Provider / receiver</small><b title={selectedOperatorB}>{short(selectedOperatorB)}</b></div><span className="verified">Server identity</span></article>
      </div>
    </section>

    {mode === "testnet" && <section className="readiness-grid card section-block">
      <div className="section-head"><div><small>Deployment readiness</small><h2>Connected services</h2></div><button className="secondary compact-button" onClick={() => void loadHealth()}>Recheck</button></div>
      <div className="readiness-items">
        <div className={testnetServerReady ? "pass" : "fail"}><span>{testnetServerReady ? "✓" : "!"}</span><div><b>Operator security</b><small>{testnetServerReady ? "Explicit keys + access gate configured" : "Enable Testnet mode, two operator keys and access key"}</small></div></div>
        <div className={ckbHealthy ? "pass" : health ? "fail" : "neutral"}><span>{ckbHealthy ? "✓" : "·"}</span><div><b>CKB RPC</b><small>{ckbHealthy ? `Reachable · tip ${health?.ckb?.tipNumber || "current"}` : "Run readiness check"}</small></div></div>
        <div className={fiberHealthy === true ? "pass" : fiberHealthy === false ? "fail" : "neutral"}><span>{fiberHealthy === true ? "✓" : "·"}</span><div><b>Fiber receiver</b><small>{fiberHealthy === true ? "Reachable" : fiberHealthy === false ? "Configured but unreachable" : "Optional · not configured"}</small></div></div>
        <div className={health?.ckb?.broadcastEnabled ? "pass" : "neutral"}><span>{health?.ckb?.broadcastEnabled ? "✓" : "·"}</span><div><b>CKB broadcaster</b><small>{health?.ckb?.broadcastEnabled ? "Explicitly enabled for Testnet" : "Off by default"}</small></div></div>
      </div>
    </section>}

    {!sessionId ? <>
      <section className="card onboarding section-block">
        <div className="onboarding-copy"><small>{mode === "demo" ? "How the demo works" : "Operator workflow"}</small><h2>From request to a jointly signed final state</h2><p>{mode === "demo"
          ? "The browser carries the verified signed snapshot. Serverless instances reconstruct it after cold starts without Postgres, Neon, Blob, or another database."
          : "The same cryptographic transcript is used, but every mutation requires the Testnet access gate and explicit manual operator actions."}</p></div>
        <div className="onboarding-steps">
          <div><span>01</span><b>Create</b><p>Open a bounded, expiring bilateral session.</p></div>
          <div><span>02</span><b>Reconcile</b><p>Exchange signed events with explicit ACKs.</p></div>
          <div><span>03</span><b>Verify</b><p>Close, export, verify, and optionally checkpoint.</p></div>
        </div>
      </section>
      <section className="card evidence-tools empty-tools section-block">
        <div><small>Portable evidence</small><h2>Resume a verified session</h2><p className="subtle">Import a previous EventMesh JSON export. It is accepted only after signature, hash-chain, and commitment verification.</p></div>
        <div className="tool-actions"><button className="secondary" onClick={() => importRef.current?.click()}>Import evidence</button><input ref={importRef} className="hidden-input" type="file" accept="application/json,.json" onChange={e => void importEvidence(e.target.files?.[0])}/></div>
      </section>
    </> : <>
      <section className="session card section-block">
        <div className="session-id"><small>Session</small><b title={sessionId}>{short(sessionId, 18)}</b><button className="mini-link" onClick={() => void copy(sessionId, "Session ID")}>Copy</button></div>
        <div><small>Workspace</small><b>{mode === "demo" ? "Demo" : "Real / Testnet"}</b></div>
        <div><small>Status</small><b className={`status ${closed ? "closed" : "active"}`}>{closed ? "Closed" : "Active"}</b></div>
        <div><small>Events</small><b>{events.length}</b></div>
        <div><small>Progress</small><b>{progress}/5</b></div>
        <div><small>Expires</small><b className="time-value">{formatTime(sessionExpiresAt)}</b></div>
        <div className="session-actions"><button className="secondary" disabled={!!busy} onClick={syncFromServer}>Sync</button><button className="secondary" onClick={newSession}>New</button></div>
      </section>

      <section className="grid workspace section-block">
        <article className="card flow-card">
          <div className="section-head"><div><small>Signed state machine</small><h2>Service reconciliation</h2></div><span className="step-count">{closed ? "Complete" : `Step ${Math.min(progress + 1, 5)} of 5`}</span></div>
          <div className="flow-intro"><span className="security-dot"/>Every mutation includes the last event count and chain tip. Stale writes are rejected instead of silently forking this browser session.</div>
          <div className="form-row"><label>Request ID<input value={requestId} maxLength={96} onChange={e => setRequestId(e.target.value)} disabled={events.length > 0}/></label><label>Service<input value={service} maxLength={120} onChange={e => setService(e.target.value)} disabled={events.length > 0}/></label></div>
          <div className="flow-actions">
            <button className={progress === 0 ? "next-action" : ""} disabled={mutateBlocked || has("SERVICE_REQUESTED") || closed} onClick={() => event("request", "A", "SERVICE_REQUESTED", { requestId, service })}><span>1</span><div><b>Request service</b><small>A → B · binds request + service</small></div></button>
            <button className={progress === 1 ? "next-action" : ""} disabled={mutateBlocked || !has("SERVICE_REQUESTED") || has("SERVICE_ACCEPTED") || closed} onClick={() => event("accept", "B", "SERVICE_ACCEPTED", { requestId })}><span>2</span><div><b>Accept request</b><small>B → A · explicit acknowledgement</small></div></button>
          </div>
          <label>Result commitment<input value={resultHash} spellCheck={false} onChange={e => setResultHash(e.target.value)} disabled={has("RESULT_COMMITTED") || closed}/></label>
          <div className="flow-actions">
            <button className={progress === 2 ? "next-action" : ""} disabled={mutateBlocked || !has("SERVICE_ACCEPTED") || has("RESULT_COMMITTED") || closed} onClick={() => event("result", "B", "RESULT_COMMITTED", { requestId, resultHash })}><span>3</span><div><b>Commit result</b><small>B → A · binds output hash</small></div></button>
            <button className={progress === 3 ? "next-action" : ""} disabled={mutateBlocked || !has("RESULT_COMMITTED") || has("SESSION_COMPLETED") || closed} onClick={() => event("complete", "B", "SESSION_COMPLETED", { requestId })}><span>4</span><div><b>Complete service</b><small>B → A · delivery complete</small></div></button>
          </div>
          <button className="primary close-action" disabled={mutateBlocked || !has("SESSION_COMPLETED") || closed} onClick={close}><span>5</span>{closed ? "Session closed" : "Close with dual signatures"}</button>

          <div className="note-box">
            <div><small>Reconciliation note</small><p className="subtle">Attach a signed operational note without changing the four-step service progress.</p></div>
            <div className="note-row"><input value={note} maxLength={500} disabled={closed || mutateBlocked} placeholder="e.g. receiver retried after an RPC timeout" onChange={e => setNote(e.target.value)}/><button className="secondary" disabled={!note.trim() || closed || mutateBlocked} onClick={addNote}>Add note</button></div>
          </div>
        </article>

        <aside className="side-stack">
          <article className="card capability-card">
            <div className="section-head"><div><small>Integrity</small><h2>Portable verification</h2></div><span className="capability available">Built in</span></div>
            <p className="subtle">Re-check session signatures, event hashes, previous-hash links, ACKs, and the final commitment.</p>
            <button disabled={!!busy} onClick={verify}>{busy === "verify" ? "Verifying…" : "Verify current evidence"}</button>
            <div className="checkpoint"><small>Chain tip</small><code title={chainTip}>{short(chainTip, 16)}</code>{transcriptRoot && <><small>Transcript root</small><code title={transcriptRoot}>{short(transcriptRoot, 16)}</code></>}</div>
          </article>

          <article className="card capability-card">
            <div className="section-head"><div><small>Concurrency</small><h2>Fork guard</h2></div><span className={`capability ${leaseConflict ? "warning" : "available"}`}>{leaseConflict ? "Read only" : "Protected"}</span></div>
            <p className="subtle">Optimistic chain preconditions run on the API. A short browser edit lease also reduces accidental same-browser concurrent edits.</p>
            <div className="mini-metrics"><div><small>Expected events</small><b>{events.length}</b></div><div><small>Tab lease</small><b>{leaseConflict ? "Other tab" : "This tab"}</b></div></div>
          </article>

          <article className="card capability-card">
            <div className="section-head"><div><small>Value binding</small><h2>Fiber payment proof</h2></div><span className={`capability ${capabilities.fiberPayments ? "available" : "inactive"}`}>{capabilities.fiberPayments ? "Available" : "Not enabled"}</span></div>
            {capabilities.fiberPayments ? <>
              <label>Payment hash<input value={paymentHash} spellCheck={false} onChange={e => setPaymentHash(e.target.value)}/></label>
              <div className="grid two compact"><label>Amount<input value={amount} onChange={e => setAmount(e.target.value)}/></label><label>Currency<select value={currency} onChange={e => setCurrency(e.target.value)}><option>Fibt</option><option>Fibb</option><option>Fibd</option></select></label></div>
              <button disabled={mutateBlocked || has("PAYMENT_SETTLED") || has("SESSION_COMPLETED") || closed || !has("RESULT_COMMITTED")} onClick={settle}>{has("PAYMENT_SETTLED") ? "Payment verified" : "Verify receiver payment proof"}</button>
            </> : <p className="subtle">Receiver-side Fiber verification is disabled. EventMesh will not manufacture a PAYMENT_SETTLED event.</p>}
          </article>

          <article className="card capability-card">
            <div className="section-head"><div><small>Settlement evidence</small><h2>CKB checkpoint</h2></div><span className={`capability ${mode === "testnet" && capabilities.ckbAnchoring ? "available" : "inactive"}`}>{mode === "testnet" && capabilities.ckbAnchoring ? "Broadcast enabled" : "No broadcast"}</span></div>
            <p className="subtle">A closed commitment can be bound to CKB Testnet only from the connected workspace and only after explicit server opt-in.</p>
            {mode === "testnet" && capabilities.ckbAnchoring && <button disabled={mutateBlocked || !closed || !!state?.anchor} onClick={anchor}>{state?.anchor ? "Checkpoint submitted" : "Submit Testnet checkpoint"}</button>}
            {state?.anchorOperation?.txHash && <div className="checkpoint"><small>Transaction</small><code>{short(state.anchorOperation.txHash, 16)}</code>{capabilities.ckbReconciliation && <button className="text-button" disabled={!!busy} onClick={reconcile}>Verify on CKB</button>}</div>}
          </article>
        </aside>
      </section>

      <section className="card evidence-card section-block">
        <div className="section-head evidence-heading"><div><small>Audit trail</small><h2>Signed event timeline</h2><p className="subtle">Search, inspect, export, and independently verify the exact event/ACK chain.</p></div><div className="tool-actions"><button className="secondary" onClick={() => importRef.current?.click()}>Import</button><button className="secondary" onClick={exportEvidence}>Export JSON</button><button className="secondary" onClick={() => void copyAuditSummary()}>Copy summary</button><input ref={importRef} className="hidden-input" type="file" accept="application/json,.json" onChange={e => void importEvidence(e.target.files?.[0])}/></div></div>
        <div className="timeline-toolbar"><input aria-label="Filter timeline" value={timelineFilter} onChange={e => setTimelineFilter(e.target.value)} placeholder="Filter by event type, hash, request ID…"/><span>{filteredEvents.length}/{events.length} events</span></div>
        <div className="timeline">{filteredEvents.length ? filteredEvents.map((row: any) => <details className="event" key={row.event.eventHash}><summary><span className="sequence">#{row.event.sequence}</span><div className="event-main"><b>{row.event.type.replaceAll("_", " ")}</b><small>{row.event.sender === selectedOperatorA ? "A → B" : "B → A"} · ACK {row.ack?.decision || "—"}</small></div><code title={row.event.eventHash}>{short(row.event.eventHash, 16)}</code></summary><div className="event-detail"><div><small>Previous hash</small><code>{row.event.previousHash}</code></div><div><small>Created</small><span>{formatTime(row.event.createdAt)}</span></div><div className="event-payload"><small>Payload</small><pre>{JSON.stringify(row.event.payload, null, 2)}</pre></div></div></details>) : <p className="muted">No matching events.</p>}</div>
        {verification && <div className="verification-result"><span className="check">✓</span><div><b>Evidence verified</b><small>{verification.eventCount} events · {verification.status} · transcript {short(verification.transcriptRoot, 12)}</small></div></div>}
        {state?.close && <details className="final-commitment"><summary>View final commitment</summary><pre>{JSON.stringify(state.close, null, 2)}</pre></details>}
      </section>
    </>}

    <footer><span>EventMesh v{info?.version || "0.6"}</span><span>{mode === "demo" ? "Database-free demo workspace" : "Connected CKB Testnet workspace"} · Do not use production funds</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
