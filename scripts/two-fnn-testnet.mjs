/**
 * Real two-FNN paid-service evidence runner for existing EventMesh operators.
 * NO automatic funding, channel opening, sending on retry, or CKB anchoring.
 * Payment requires both explicit CLI approval and a testnet-only environment gate.
 * A journal is committed BEFORE the one and only send_payment attempt.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => `0x${createHash('sha256').update(value).digest('hex')}`;
const HASH = /^0x[0-9a-f]{64}$/i;
const PUBKEY = /^0x[0-9a-f]{66}$/i;
const FN_PUBKEY = /^[0-9a-f]{66}$/i;
const STEP = [
  'INIT', 'CREATE_INTENT', 'SESSION', 'SERVICE_REQUESTED', 'SERVICE_ACCEPTED',
  'RESULT_COMMITTED', 'INVOICE', 'PAYMENT_SEND_INTENT', 'PAID',
  'PAYMENT_SETTLED', 'SESSION_COMPLETED', 'CLOSED'
];
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function assertOperatorEndpoint(raw) {
  const uri = new URL(raw);
  if (uri.username || uri.password || uri.search || uri.hash || !['', '/'].includes(uri.pathname)) {
    throw new Error('OPERATOR_URL_MUST_BE_BARE_ORIGIN');
  }
  if (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname))) {
    throw new Error('OPERATOR_URL_MUST_BE_HTTPS_OR_LOCAL_LOOPBACK');
  }
  return uri.origin;
}
export function validateApproval({ executePayment, env, amount }) {
  if (!executePayment) return;
  if (env.EVENTMESH_TESTNET_NETWORK_CONFIRM !== 'TESTNET_ONLY') throw new Error('TESTNET_CONFIRMATION_REQUIRED');
  if (env.EVENTMESH_ALLOW_FIBER_PAYMENT !== 'YES_ONE_TESTNET_PAYMENT') throw new Error('PAYMENT_OPT_IN_REQUIRED');
  const cap = env.EVENTMESH_MAX_PAYMENT_SHANNONS ?? '100000000';
  if (!/^\d+$/.test(String(amount)) || BigInt(amount) < 1n || !/^\d+$/.test(cap) || BigInt(amount) > BigInt(cap)) {
    throw new Error('AMOUNT_EXCEEDS_CONFIGURED_TESTNET_CAP');
  }
}
export function persist(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(state, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}
export function newJournal(amount, service) {
  return { version: 1, step: 'INIT', runId: randomUUID(), requestId: `reviewer-${randomUUID()}`,
    service, resultHash: sha256(`eventmesh-review-result:${service}`), amount: String(amount),
    currency: 'Fibt', paymentSendAttempts: 0, createdAt: new Date().toISOString() };
}
export function setStep(state, step) {
  if (STEP.indexOf(step) < STEP.indexOf(state.step)) throw new Error('JOURNAL_STEP_REGRESSION');
  if (!STEP.includes(step)) throw new Error('UNKNOWN_JOURNAL_STEP');
  state.step = step;
  return state;
}
export function markPaymentAttempt(state) {
  if (state.paymentSendAttempts !== 0 || !state.invoice?.paymentHash || state.step !== 'INVOICE') {
    throw new Error('PAYMENT_ALREADY_ATTEMPTED_OR_INVOICE_MISSING');
  }
  state.paymentSendAttempts = 1;
  return setStep(state, 'PAYMENT_SEND_INTENT');
}
export async function request(base, token, method, path, payload, transport = fetch) {
  const response = await transport(`${base}${path}`, {
    method, redirect: 'error', headers: {
      'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {})
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OPERATOR_HTTP_${response.status}:${method}:${path}:${data.error ?? data.detail ?? 'UNKNOWN'}`);
  return data;
}
export async function preflight(a, b, tokens, transport = fetch) {
  const [ah, bh, ai, bi, af, bf] = await Promise.all([
    request(a, tokens.a, 'GET', '/health', undefined, transport),
    request(b, tokens.b, 'GET', '/health', undefined, transport),
    request(a, tokens.a, 'GET', '/identity', undefined, transport),
    request(b, tokens.b, 'GET', '/identity', undefined, transport),
    request(a, tokens.a, 'GET', '/admin/fiber/node-info', undefined, transport),
    request(b, tokens.b, 'GET', '/admin/fiber/node-info', undefined, transport)
  ]);
  if (!ah.fiberEnabled || !bh.fiberEnabled) throw new Error('BOTH_OPERATORS_MUST_HAVE_FIBER_ENABLED');
  if (!PUBKEY.test(ai.publicKey) || !PUBKEY.test(bi.publicKey) || ai.publicKey === bi.publicKey) throw new Error('OPERATORS_MUST_HAVE_DISTINCT_IDENTITIES');
  if (!FN_PUBKEY.test(af.pubkey ?? '') || !FN_PUBKEY.test(bf.pubkey ?? '') || af.pubkey === bf.pubkey) {
    throw new Error('FNN_MUST_BE_TWO_DISTINCT_NODE_PUBKEYS');
  }
  if (ai.selfUrl !== a || bi.selfUrl !== b) throw new Error('OPERATOR_SELF_URL_MISMATCH');
  return { operators: [ai.publicKey, bi.publicKey], fnnPubkeys: [af.pubkey, bf.pubkey],
    fiberEnabled: true, testnetIndependentlyVerified: false };
}

// Read signed events from the operator's own durable store when a CLI response
// may have been lost; never create a second event with an ambiguous outcome.
async function durableEvent(base, token, sessionId, type, sender, payload, transport) {
  const path = `/admin/sessions/${encodeURIComponent(sessionId)}`;
  const before = await request(base, token, 'GET', path, undefined, transport);
  const prior = before.events?.filter((row) => row.event?.type === type) ?? [];
  if (prior.length > 1) throw new Error(`DUPLICATE_${type}_EVIDENCE`);
  if (prior.length === 1) {
    // Retry only delivery of the SAME immutable signed event, never sign a new event.
    if (prior[0].status === 'PROPOSED') {
      await request(base, token, 'POST', `${path}/events/${prior[0].event.eventHash}/retry`, {}, transport);
    }
    return prior[0].event;
  }
  const proposed = await request(base, token, 'POST', `${path}/events`, { type, payload }, transport);
  if (!HASH.test(proposed.eventHash) || proposed.sender?.toLowerCase() !== sender.toLowerCase()) {
    throw new Error(`INVALID_${type}_PROPOSAL`);
  }
  return proposed;
}
async function ackEvent(base, token, sessionId, eventHash, transport) {
  const path = `/admin/sessions/${encodeURIComponent(sessionId)}/events/${eventHash}/ack`;
  const result = await request(base, token, 'POST', path, { decision: 'ACCEPT' }, transport);
  if (!HASH.test(result.ackHash) && !result.duplicate) throw new Error('ACK_NOT_SIGNED');
  return result;
}
function remember(state, path, update) { Object.assign(state, update); persist(path, state); }

export async function runTwoFnn({ env = process.env, args = process.argv.slice(2), transport = fetch, verify } = {}) {
  const onlyPreflight = !args.includes('--run');
  const executePayment = args.includes('--allow-payment');
  const injectLostPaymentResponse = args.includes('--inject-lost-payment-response');
  const a = assertOperatorEndpoint(env.OPERATOR_A_URL ?? 'http://127.0.0.1:4001');
  const b = assertOperatorEndpoint(env.OPERATOR_B_URL ?? 'http://127.0.0.1:4002');
  if (a === b) throw new Error('OPERATOR_ENDPOINTS_MUST_DIFFER');
  const tokens = { a: env.OPERATOR_A_TOKEN ?? '', b: env.OPERATOR_B_TOKEN ?? '' };
  const amount = env.EVENTMESH_PAYMENT_SHANNONS ?? '100000000';
  const service = env.EVENTMESH_SERVICE ?? 'reviewer-paid-computation';
  if (args.some((arg) => !['--run', '--preflight', '--allow-payment', '--inject-lost-payment-response'].includes(arg))) {
    throw new Error('UNKNOWN_ARGUMENT');
  }
  if (!onlyPreflight && !executePayment) throw new Error('RUN_REQUIRES_ALLOW_PAYMENT');
  validateApproval({ executePayment, env, amount });
  const prepared = await preflight(a, b, tokens, transport);
  if (env.EVENTMESH_VERBOSE_DIAGNOSTICS === 'true') {
    console.log('[FNN_FLOW] PREFLIGHT_IDENTITIES_OK', JSON.stringify({ operators: prepared.operators, fnnPubkeys: prepared.fnnPubkeys, networkIndependentlyVerified: false }));
  }
  if (onlyPreflight) return { status: 'PREFLIGHT_ONLY', ...prepared, warning: 'No payment or session was created. Verify each FNN is on Pudge Testnet out of band.' };

  const path = resolve(env.EVENTMESH_RUN_STATE ?? 'artifacts/reviewer-two-fnn/state.json');
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : newJournal(amount, service);
  if (state.version !== 1 || state.amount !== amount || state.service !== service || state.currency !== 'Fibt' || !STEP.includes(state.step)) {
    throw new Error('INCOMPATIBLE_EXISTING_JOURNAL_REFUSING_NEW_PAYMENT');
  }
  const save = (step, fields = {}) => {
    setStep(state, step); remember(state, path, fields);
    if (env.EVENTMESH_VERBOSE_DIAGNOSTICS === 'true') {
      console.log('[FNN_FLOW] JOURNAL_SAVED', JSON.stringify({ step: state.step, sessionId: state.sessionId ?? null, paymentSendAttempts: state.paymentSendAttempts }));
    }
  };
  if (state.operatorIdentityPin) {
    if (JSON.stringify(state.operatorIdentityPin.operators) !== JSON.stringify(prepared.operators)
      || JSON.stringify(state.operatorIdentityPin.fnnPubkeys) !== JSON.stringify(prepared.fnnPubkeys)
      || state.operatorIdentityPin.a !== a || state.operatorIdentityPin.b !== b) {
      throw new Error('OPERATOR_OR_FNN_IDENTITY_CHANGED_SINCE_JOURNAL_CREATION');
    }
  } else if (state.step === 'INIT') {
    remember(state, path, { operatorIdentityPin: { operators: prepared.operators, fnnPubkeys: prepared.fnnPubkeys, a, b } });
  } else {
    throw new Error('EXISTING_JOURNAL_MISSING_IDENTITY_PIN');
  }
  if (!existsSync(path)) persist(path, state);
  const A = (method, url, payload) => request(a, tokens.a, method, url, payload, transport);
  const B = (method, url, payload) => request(b, tokens.b, method, url, payload, transport);

  if (!state.sessionId) {
    if (state.step === 'CREATE_INTENT') throw new Error('SESSION_CREATE_RESPONSE_UNKNOWN_INSPECT_A_SESSIONS_MANUALLY');
    save('CREATE_INTENT'); // No automatic repeated session creation on ambiguous HTTP outcomes.
    const session = await A('POST', '/admin/sessions', { peerUrl: b, applicationProfile: 'paid-service-v2', expiresInSeconds: 3600 });
    const id = session.session?.sessionId ?? session.session?.session?.sessionId;
    if (!id) throw new Error('SESSION_ID_NOT_RETURNED_RESOLVE_WITH_A_SESSIONS');
    save('SESSION', { sessionId: id });
  }
  const id = state.sessionId;
  if (state.step === 'CREATE_INTENT') throw new Error('MANUAL_SESSION_ID_RECOVERY_REQUIRED');
  const idPath = `/admin/sessions/${encodeURIComponent(id)}`;
  const signed = await A('GET', idPath);
  if (signed.status === 'CREATING') { await A('POST', `${idPath}/join/retry`, {}); }
  if (state.step === 'SESSION') {
    const event = await durableEvent(a, tokens.a, id, 'SERVICE_REQUESTED', prepared.operators[0], { requestId: state.requestId, service }, transport);
    await ackEvent(b, tokens.b, id, event.eventHash, transport);
    save('SERVICE_REQUESTED', { serviceRequestedEventHash: event.eventHash });
  }
  if (state.step === 'SERVICE_REQUESTED') {
    const event = await durableEvent(b, tokens.b, id, 'SERVICE_ACCEPTED', prepared.operators[1], { requestId: state.requestId }, transport);
    await ackEvent(a, tokens.a, id, event.eventHash, transport);
    save('SERVICE_ACCEPTED', { serviceAcceptedEventHash: event.eventHash });
  }
  if (state.step === 'SERVICE_ACCEPTED') {
    const event = await durableEvent(b, tokens.b, id, 'RESULT_COMMITTED', prepared.operators[1], { requestId: state.requestId, resultHash: state.resultHash }, transport);
    await ackEvent(a, tokens.a, id, event.eventHash, transport);
    save('RESULT_COMMITTED', { resultEventHash: event.eventHash });
  }
  if (state.step === 'RESULT_COMMITTED') {
    // Invoice is generated only once. An ambiguous response MUST be reconciled manually.
    save('RESULT_COMMITTED', { invoiceCreateIntent: true });
    if (state.invoiceCreateIntent && state.invoiceCreateAttempted) throw new Error('INVOICE_CREATE_AMBIGUOUS_INSPECT_B_FNN');
    remember(state, path, { invoiceCreateAttempted: true });
    const invoice = await B('POST', '/admin/fiber/new-invoice', {
      sessionId: id, amount, currency: 'Fibt', description: 'EventMesh review paid computation',
      obligationId: state.requestId, settlesEventHash: state.resultEventHash,
      expectedPayeePublicKey: prepared.fnnPubkeys[1]
    });
    const paymentHash = invoice.eventMeshClaim?.paymentHash;
    const address = invoice.invoice_address;
    if (!HASH.test(paymentHash ?? '') || typeof address !== 'string' || !address.startsWith('fibt')) {
      throw new Error('FNN_RETURNED_INVALID_TESTNET_INVOICE');
    }
    save('INVOICE', { invoice: { paymentHash, invoiceAddress: address, claim: invoice.eventMeshClaim } });
  }
  if (state.step === 'INVOICE') {
    // Try observation BEFORE the send. This also prevents paying an invoice that
    // already became Paid in a previous manual/externally initiated run.
    const observed = await B('GET', `/admin/fiber/invoices/${state.invoice.paymentHash}`);
    if (observed.status === 'Paid') save('PAID');
    else {
      if (observed.status !== 'Open') throw new Error(`FNN_INVOICE_NOT_OPEN:${observed.status}`);
      markPaymentAttempt(state);
      persist(path, state); // durable payment intent comes BEFORE sending
      const payment = await A('POST', '/admin/fiber/send-payment', { invoice: state.invoice.invoiceAddress });
      if (payment.payment_hash && payment.payment_hash.toLowerCase() !== state.invoice.paymentHash.toLowerCase()) {
        throw new Error('SENDER_PAYMENT_HASH_MISMATCH');
      }
      if (injectLostPaymentResponse && !state.injectedLostResponse) {
        remember(state, path, { injectedLostResponse: true });
        throw new Error('INJECTED_LOST_PAYMENT_RESPONSE_RESUME_WITHOUT_RESEND');
      }
    }
  }
  if (state.step === 'PAYMENT_SEND_INTENT') {
    // A second invocation NEVER sends again even if the sender reported an error.
    const until = Date.now() + Number(env.EVENTMESH_PAYMENT_WAIT_MS ?? 90000);
    let observed;
    do {
      observed = await B('GET', `/admin/fiber/invoices/${state.invoice.paymentHash}`);
      if (observed.status === 'Paid') { save('PAID'); break; }
      if (['Expired', 'Cancelled'].includes(observed.status)) break;
      if (Date.now() >= until) break;
      await new Promise((done) => setTimeout(done, 2000));
    } while (true);
    if (state.step !== 'PAID') {
      throw new Error(`PAYMENT_OUTCOME_NOT_PROVEN_NO_RESEND:${observed?.status ?? 'UNKNOWN'}`);
    }
  }
  if (state.step === 'PAID') {
    const event = await durableEvent(a, tokens.a, id, 'PAYMENT_SETTLED', prepared.operators[0], state.invoice.claim, transport);
    const ack = await ackEvent(b, tokens.b, id, event.eventHash, transport);
    if (!ack.paymentEvidence?.evidence?.verifier || ack.paymentEvidence.evidence.verifier !== 'RECEIVER_FNN') {
      throw new Error('RECEIVER_SIGNED_FNN_EVIDENCE_MISSING');
    }
    save('PAYMENT_SETTLED', { settlementEventHash: event.eventHash, receiverEvidenceHash: ack.paymentEvidence.evidenceHash });
  }
  if (state.step === 'PAYMENT_SETTLED') {
    const event = await durableEvent(b, tokens.b, id, 'SESSION_COMPLETED', prepared.operators[1], { requestId: state.requestId }, transport);
    await ackEvent(a, tokens.a, id, event.eventHash, transport);
    save('SESSION_COMPLETED', { completionEventHash: event.eventHash });
  }
  if (state.step === 'SESSION_COMPLETED') {
    await A('POST', `${idPath}/close`, {});
    save('CLOSED');
  }
  const [transcriptA, transcriptB, summary] = await Promise.all([
    A('GET', `${idPath}/transcript`), B('GET', `${idPath}/transcript`), A('GET', `${idPath}/evidence-summary`)
  ]);
  // This is a real cryptographic verification, not merely HTTP 200 or a hash comparison.
  const verifier = verify ?? (await import('@eventmesh/core')).verifyTranscript;
  const verifiedA = verifier(transcriptA);
  const verifiedB = verifier(transcriptB);
  const sdk = await import('@eventmesh/adapter-sdk');
  const applicationA = sdk.validateTranscriptWithAdapter(transcriptA, sdk.paidServiceStrictAdapter);
  const applicationB = sdk.validateTranscriptWithAdapter(transcriptB, sdk.paidServiceStrictAdapter);
  if (!applicationA.ok || !applicationB.ok) {
    throw new Error(`STRICT_APPLICATION_PROFILE_VERIFICATION_FAILED:${JSON.stringify([applicationA.errors, applicationB.errors])}`);
  }
  if (applicationA.finalState?.resultHash?.toLowerCase() !== state.resultHash.toLowerCase()
    || applicationA.finalState?.paymentHash?.toLowerCase() !== state.invoice.paymentHash.toLowerCase()) {
    throw new Error('FINAL_APPLICATION_STATE_MISMATCH');
  }
  if (!verifiedA.ok || !verifiedB.ok) throw new Error(`TRANSCRIPT_CRYPTO_VERIFICATION_FAILED:${JSON.stringify([verifiedA, verifiedB])}`);
  if (JSON.stringify(transcriptA.close) !== JSON.stringify(transcriptB.close)) throw new Error('OPERATOR_CLOSE_PROOFS_DIVERGE');
  if (summary.status !== 'CLOSED' || !transcriptA.close?.signatureA || !transcriptA.close?.signatureB) throw new Error('DUAL_SIGNED_CLOSE_NOT_PROVEN');
  const report = { schema: 'eventmesh-two-fnn-evidence-v1', status: 'DUAL_SIGNED_RECEIVER_VERIFIED',
    testnetIndependentlyVerified: false, manuallyDeclaredNetwork: 'Pudge Testnet',
    sessionId: id, requestId: state.requestId, resultHash: state.resultHash,
    paymentHash: state.invoice.paymentHash, paymentSendAttempts: state.paymentSendAttempts,
    operators: prepared.operators, fnnPubkeys: prepared.fnnPubkeys,
    receiverEvidenceHash: state.receiverEvidenceHash, verifiedA, verifiedB,
    strictApplicationValidation: { a: applicationA.ok, b: applicationB.ok },
    syntheticComputationResult: true,
    eventCount: transcriptA.events.length,
    limitations: ['Testnet network identity is declared by operator administrators; FNN node_info does not authenticate the CKB network.',
      'No on-chain checkpoint is implied.', 'The computation result hash is a deterministic test fixture, not proof of service delivery.',
      'Signatures prove acknowledgement, not result correctness or delivery.',
      'An already-successful paid invoice may exist even if this runner never invoked send_payment.'] };
  const reportPath = resolve(env.EVENTMESH_EVIDENCE_OUT ?? 'artifacts/reviewer-two-fnn/evidence.json');
  persist(reportPath, { report, transcriptA, transcriptB, summary });
  return { ...report, reportPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTwoFnn().then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error(`TWO_FNN_FAIL_CLOSED: ${String(error.message ?? error)}`);
    process.exitCode = 1;
  });
}
