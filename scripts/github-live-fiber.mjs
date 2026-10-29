/**
 * GitHub Actions real-Pudge integration orchestrator.
 * No node provisioning, channel funding, or simulated payment.
 * In `run` mode requires a persistent self-hosted runner journal and two
 * separately configured, already-running FNN-backed EventMesh operators.
 * Never log access tokens, invoice strings, wallet keys, or raw HTTP bodies.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { runTwoFnn, request, assertOperatorEndpoint } from './two-fnn-testnet.mjs';

const TX = /^0x[0-9a-f]{64}$/i;
const now = () => new Date().toISOString();
const allowed = ['preflight', 'run', 'reconcile'];
const stage = (name, fields = {}) => {
  const entry = { at: now(), stage: name, ...fields };
  mkdirSync(reportDir, { recursive: true });
  appendFileSync(join(reportDir, 'trace.ndjson'), JSON.stringify(entry) + '\n');
  console.log(`[EVENTMESH_LIVE] ${entry.at} ${name} ${JSON.stringify(fields)}`);
};
const summary = (line) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };
const reportDir = resolve('artifacts/real-fiber-testnet');
function record(stageName, data = {}) {
  mkdirSync(reportDir, { recursive: true });
  const doc = { schema: 'eventmesh-real-fiber-ci-v1', at: now(), stage: stageName, ...data };
  writeFileSync(join(reportDir, 'status.json'), JSON.stringify(doc, null, 2) + '\n');
  stage(stageName, data);
  summary(`| ${stageName} | ${data.status ?? 'Recorded'} | ${data.txHash ?? '—'} |`);
  return doc;
}
function diagnosticCode(err) {
  const raw = String(err?.message ?? err);
  // One error code only: never emit the server response, invoice or credentials.
  return (raw.match(/^[A-Z][A-Z0-9_]{2,70}/)?.[0] ?? 'UNCLASSIFIED_ERROR');
}
function requireEndpoints(env) {
  if (!env.OPERATOR_A_URL || !env.OPERATOR_B_URL) throw new Error('OPERATOR_URLS_MISSING');
  const a = assertOperatorEndpoint(env.OPERATOR_A_URL);
  const b = assertOperatorEndpoint(env.OPERATOR_B_URL);
  if (a === b) throw new Error('OPERATOR_ENDPOINTS_MUST_DIFFER');
  if (!env.OPERATOR_A_TOKEN || !env.OPERATOR_B_TOKEN) throw new Error('OPERATOR_ADMIN_TOKENS_MISSING');
  return { a, b };
}

/** A hosted GitHub runner is ephemeral; never spend from a journal under its workspace/temp. */
export function verifyDurableDirectory(raw, env = process.env) {
  if (!raw || !isAbsolute(raw)) throw new Error('ABSOLUTE_DURABLE_STATE_DIR_REQUIRED');
  const dir = resolve(raw);
  if (dir === '/' || dir === '/tmp' || dir.startsWith(`/tmp${sep}`)) throw new Error('TEMP_DIR_NOT_DURABLE');
  for (const key of ['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE']) {
    if (!env[key]) continue;
    const path = resolve(env[key]);
    if (dir === path || dir.startsWith(path + sep)) throw new Error('JOURNAL_INSIDE_EPHEMERAL_RUNNER_DIRECTORY');
  }
  if (!existsSync(dir)) throw new Error('DURABLE_STATE_DIR_NOT_PROVISIONED');
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('DURABLE_STATE_DIR_UNSAFE');
  const canonical = realpathSync(dir);
  if (canonical !== dir) throw new Error('DURABLE_STATE_DIR_REDIRECTED');
  if ((lstatSync(dir).mode & 0o077) !== 0) throw new Error('DURABLE_STATE_DIR_MUST_BE_PRIVATE_0700');
  return dir;
}

async function getSummary(a, token, sessionId, transport) {
  const id = encodeURIComponent(sessionId);
  return request(a, token, 'GET', `/admin/sessions/${id}/evidence-summary`, undefined, transport);
}

export async function executeLive({ mode = 'preflight', env = process.env, transport = fetch, run = runTwoFnn } = {}) {
  if (!allowed.includes(mode)) throw new Error('INVALID_LIVE_MODE');
  const { a, b } = requireEndpoints(env);
  if (mode === 'run' && env.EVENTMESH_LIVE_APPROVAL !== 'RUN_ONE_TESTNET_PAYMENT_AND_ANCHOR') {
    throw new Error('EXPLICIT_MANUAL_LIVE_APPROVAL_REQUIRED');
  }
  const cfg = { ...env };
  if (mode !== 'preflight') {
    const dir = verifyDurableDirectory(env.EVENTMESH_DURABLE_STATE_DIR, env);
    cfg.EVENTMESH_RUN_STATE = join(dir, 'two-fnn-state.json');
    cfg.EVENTMESH_EVIDENCE_OUT = join(reportDir, 'evidence.json');
    if (mode === 'reconcile') {
      if (!existsSync(cfg.EVENTMESH_RUN_STATE)) throw new Error('NO_PRIOR_RUN_TO_RECONCILE');
      const prior = JSON.parse(readFileSync(cfg.EVENTMESH_RUN_STATE, 'utf8'));
      if (prior.step !== 'CLOSED' || prior.paymentSendAttempts > 1) throw new Error('RECONCILE_REQUIRES_ALREADY_CLOSED_PAYMENT_JOURNAL');
    }
    stage('DURABLE_JOURNAL', { present: existsSync(cfg.EVENTMESH_RUN_STATE), pathConfigured: true });
  }
  stage('PREFLIGHT_STARTED', { mode, operatorA: new URL(a).hostname, operatorB: new URL(b).hostname });
  const check = await run({ env: cfg, args: ['--preflight'], transport });
  if (check.status !== 'PREFLIGHT_ONLY') throw new Error('PREFLIGHT_UNEXPECTED_RESULT');
  const health = await request(a, env.OPERATOR_A_TOKEN, 'GET', '/health', undefined, transport);
  record('PREFLIGHT_OK', { status: 'PASS', twoFnnIdentitiesDistinct: check.fnnPubkeys?.[0] !== check.fnnPubkeys?.[1], ckbAnchorEnabled: health.ckbAnchorEnabled === true,
    operatorStoresPersistent: 'REQUIRES_OPERATOR_ADMIN_CONFIRMATION', independentlyVerifiedTestnetNetwork: false });
  if (mode === 'preflight') return { status: 'PREFLIGHT_ONLY' };
  if (health.ckbAnchorEnabled !== true || health.ckbVerificationEnabled !== true) throw new Error('OPERATOR_A_CKB_ANCHOR_NOT_CONFIGURED');
  let evidence;
  if (mode === 'run') stage('FIBER_PAYMENT_PHASE', { capShannons: cfg.EVENTMESH_MAX_PAYMENT_SHANNONS || '100000000' });
  // Reconcile mode can only read an already CLOSED persistent journal.
  // Existing code resumes it without initiating another payment.
  evidence = await run({ env: cfg, args: ['--run', '--allow-payment'], transport });
  if (evidence.status !== 'DUAL_SIGNED_RECEIVER_VERIFIED' || evidence.paymentSendAttempts !== 1 || !evidence.paymentHash || !evidence.receiverEvidenceHash) {
    throw new Error('REAL_FIBER_EVIDENCE_INCOMPLETE');
  }
  record('DUAL_SIGNED_RECEIVER_VERIFIED', { status: 'PASS', sessionId: evidence.sessionId, paymentHash: evidence.paymentHash, receiverEvidenceHash: evidence.receiverEvidenceHash });
  const sessionId = evidence.sessionId;
  const sessionPath = `/admin/sessions/${encodeURIComponent(sessionId)}`;
  let current = await getSummary(a, env.OPERATOR_A_TOKEN, sessionId, transport);
  if (current.status !== 'CLOSED' || current.close?.dualSigned !== true || current.payments?.evidenceComplete !== true) {
    throw new Error('CLOSED_AND_RECEIVER_VERIFIED_PROOF_REQUIRED');
  }
  if (current.ckb?.txHash && !TX.test(current.ckb.txHash)) throw new Error('INVALID_EXISTING_ANCHOR_HASH');
  if (!current.ckb?.txHash) {
    if (mode === 'reconcile') throw new Error('NO_ANCHOR_EXISTS_RECONCILE_ONLY');
    // Operator persists exact signed transaction before broadcast and recovers by hash.
    record('ANCHOR_SUBMISSION_INTENT', { status: 'REQUESTED', sessionId });
    const response = await request(a, env.OPERATOR_A_TOKEN, 'POST', `${sessionPath}/anchor`, {}, transport);
    if (!TX.test(response.anchor?.txHash ?? '')) throw new Error('ANCHOR_REQUEST_RETURNED_NO_TX_HASH');
    stage('ANCHOR_SUBMITTED', { txHash: response.anchor.txHash, anchorStatus: response.anchor.status });
  } else {
    stage('EXISTING_ANCHOR_REUSED', { txHash: current.ckb.txHash, anchorStatus: current.ckb.anchorStatus });
  }
  // No new transaction is prepared here. Reconcile by the persisted tx hash.
  const maxPolls = Math.min(12, Math.max(1, Number(env.EVENTMESH_CKB_RECONCILE_POLLS || 6)));
  for (let i = 0; i < maxPolls; i++) {
    const r = await request(a, env.OPERATOR_A_TOKEN, 'POST', `${sessionPath}/anchor/reconcile`, {}, transport);
    current = await getSummary(a, env.OPERATOR_A_TOKEN, sessionId, transport);
    stage('ANCHOR_RECONCILIATION', { attempt: i + 1, status: current.ckb?.anchorStatus, txHash: current.ckb?.txHash,
      verificationStatus: r.verification?.status || 'UNKNOWN' });
    if (current.ckb?.anchorStatus === 'CONFIRMED' && current.readiness?.ckbConfirmed) break;
    if (i < maxPolls - 1) await new Promise((done) => setTimeout(done, 10000));
  }
  const confirmed = current.ckb?.anchorStatus === 'CONFIRMED' && current.readiness?.ckbConfirmed === true;
  const result = record(confirmed ? 'LIVE_FIBER_AND_CKB_CONFIRMED' : 'CKB_PENDING_CONFIRMATIONS', {
    status: confirmed ? 'PASS' : 'PENDING', sessionId, paymentHash: evidence.paymentHash,
    txHash: current.ckb?.txHash || null, ckbAnchorStatus: current.ckb?.anchorStatus || 'NONE',
    realFiber: true, independentNetworkAttestation: false, syntheticComputationResult: true
  });
  if (!confirmed) throw new Error('CKB_CONFIRMATION_PENDING_OR_UNVERIFIED');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const mode = process.argv[2] || 'preflight';
  rmSync(reportDir, { recursive: true, force: true }); // Never publish stale evidence from a prior CI attempt.
  summary('\n### EventMesh genuine Fiber/CKB integration\n');
  summary('| Stage | Result | CKB TX |\n|---|---|---|');
  executeLive({ mode }).catch((err) => {
    const code = diagnosticCode(err);
    let journal = null;
    try {
      if (process.env.EVENTMESH_DURABLE_STATE_DIR) {
        const p = join(process.env.EVENTMESH_DURABLE_STATE_DIR, 'two-fnn-state.json');
        if (existsSync(p)) { const state = JSON.parse(readFileSync(p, 'utf8')); journal = { step: state.step, paymentSendAttempts: state.paymentSendAttempts, sessionId: state.sessionId || null }; }
      }
    } catch {}
    record('LIVE_WORKFLOW_STOPPED', { status: 'FAIL', code, journal, recovery: 'Inspect the persistent journal, operator evidence summary and CKB TX before rerunning; never reset a payment journal blindly.' });
    console.error(`[EVENTMESH_LIVE] FAIL_CLOSED code=${code}`);
    process.exitCode = 1;
  });
}
