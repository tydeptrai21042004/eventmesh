/**
 * EventMesh one-workflow funded CKB Pudge Testnet runner.
 *
 * `probe` needs no npm dependencies or signing credentials.
 * `run` uses the dedicated, deliberately public Pudge Testnet key in config/testnet-wallet.json.
 * Never send Mainnet or valuable funds to this wallet.
 * CKB proof = a deterministic synthetic EventMesh commitment anchored on CKB;
 * it is NOT evidence of live Fiber settlement or a two-operator paid service.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RPC = 'https://testnet.ckbapp.dev/';
export const DEFAULT_MIN_CKB = 500;
export const TEST_VERSION = 'eventmesh-automated-checkpoint-v1';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cfg = JSON.parse(readFileSync(resolve(root, 'config/testnet-wallet.json'), 'utf8'));
const dir = resolve(root, 'artifacts/testnet');
const stateDir = resolve(root, '.github-testnet-state');
const statePath = resolve(stateDir, 'anchor.json');
const NO_KEY_MESSAGE = 'CKB Pudge Testnet private key missing from config/testnet-wallet.json';

export function hexSha256(s) { return `0x${createHash('sha256').update(s).digest('hex')}`; }
export function commitment() {
  const sessionId = TEST_VERSION;
  const transcriptRoot = hexSha256(`${TEST_VERSION}:synthetic-transcript-root`);
  const finalStateHash = hexSha256(`${TEST_VERSION}:synthetic-final-state`);
  const paymentEvidenceRoot = hexSha256(`${TEST_VERSION}:NO_FIBER_PAYMENT`);
  const domain = Buffer.from('EVENTMESH_V02').toString('hex');
  const fields = [sessionId, transcriptRoot, finalStateHash, paymentEvidenceRoot];
  const dataHex = `0x${domain}${fields.map((v, i) => (i === 0 ? hexSha256(v) : v).slice(2)).join('')}`;
  return { sessionId, transcriptRoot, finalStateHash, paymentEvidenceRoot, dataHex };
}
export const EXPECTED_DATA = commitment().dataHex;

export async function rpcCall(rpc, method, params, transport = fetch) {
  const response = await transport(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(18000)
  });
  if (!response.ok) throw new Error(`CKB_RPC_HTTP_${response.status}:${method}`);
  const body = await response.json();
  if (body.error) throw new Error(`CKB_RPC_${method}:${body.error.message ?? JSON.stringify(body.error)}`);
  if (body.result == null) throw new Error(`CKB_RPC_NULL_RESULT:${method}`);
  return body.result;
}

// Scan up to 2,000 live cells; if the cap is hit, fail closed rather than resend blindly.
export async function probeTestnet({ rpc = DEFAULT_RPC, transport = fetch } = {}) {
  const key = { script: cfg.lockScript, script_type: 'lock', script_search_mode: 'exact' };
  const capacityResult = await rpcCall(rpc, 'get_cells_capacity', [key], transport);
  if (!/^0x[0-9a-f]+$/i.test(capacityResult.capacity ?? '')) throw new Error('MALFORMED_CAPACITY');
  const capacityShannons = BigInt(capacityResult.capacity);
  const balanceCkb = `${capacityShannons / 100000000n}.${String(capacityShannons % 100000000n).padStart(8, '0')}`;
  const cells = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const params = [key, 'asc', '0x64', ...(cursor ? [cursor] : [])];
    const result = await rpcCall(rpc, 'get_cells', params, transport);
    if (!Array.isArray(result.objects)) throw new Error('MALFORMED_CELL_PAGE');
    for (const cell of result.objects) {
      if (String(cell.output_data).toLowerCase() === EXPECTED_DATA.toLowerCase()) {
        cells.push({ txHash: cell.out_point?.tx_hash, outputData: cell.output_data });
      }
    }
    if (result.objects.length < 100) return { address: cfg.address, balanceCkb, capacityShannons, previousAnchor: cells[0] ?? null, completeScan: true };
    if (!result.last_cursor || result.last_cursor === cursor) throw new Error('INDEXER_CURSOR_NOT_ADVANCING');
    cursor = result.last_cursor;
  }
  throw new Error('TOO_MANY_CELLS_REFUSING_DUPLICATE_BROADCAST');
}

function persistReport(report, name='report.json') {
  mkdirSync(dir, { recursive: true });
  const base = {
    schema: 'eventmesh-testnet-auto-v1',
    note: 'Only a synthetic CKB checkpoint. No live Fiber payment or dual-signed paid-session verified.',
    commitSha: process.env.GITHUB_SHA ?? null,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    checkedAtUtc: new Date().toISOString(),
    ...report
  };
  writeFileSync(resolve(dir, name), `${JSON.stringify(base, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n### EventMesh CKB Testnet\n\nStatus: **${base.status}**  \nAddress: \`${cfg.address}\`  \nBalance: ${base.balanceCkb ?? 'not checked'} CKB  \nTX: \`${base.txHash ?? 'none'}\`  \nScope: synthetic CKB anchor only; no real Fiber payment.\n`);
  return base;
}
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value).replaceAll('\n', '')}\n`);
}
function saveTransactionState(txHash) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ schema: 1, txHash, dataHex: EXPECTED_DATA, address: cfg.address, version: TEST_VERSION, checkedAtUtc: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  output('state_written', 'true');
}
function readTransactionState() {
  if (!existsSync(statePath)) return null;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.version !== TEST_VERSION || state.address !== cfg.address || state.dataHex !== EXPECTED_DATA || !/^0x[0-9a-f]{64}$/i.test(state.txHash)) throw new Error('INVALID_SAVED_TX_STATE');
  return state;
}

export async function execute({ mode='probe', rpc=process.env.CKB_RPC_URL || DEFAULT_RPC, transport=fetch, privateKey=cfg.privateKey || '' } = {}) {
  if (!/^https:\/\//.test(rpc) && !/^http:\/\/127\.0\.0\.1(?::\d+)?\/?$/.test(rpc)) throw new Error('CKB_RPC_URL_MUST_USE_HTTPS');
  const c = commitment();
  let wallet;
  try { wallet = await probeTestnet({ rpc, transport }); }
  catch (error) {
    return persistReport({ status: 'RPC_UNAVAILABLE', error: String(error), rpc, address: cfg.address, expectedDataHex: c.dataHex });
  }
  const minShannons = BigInt(DEFAULT_MIN_CKB) * 100000000n;
  const common = { rpc, balanceCkb: wallet.balanceCkb, minBalanceCkb: DEFAULT_MIN_CKB, address: cfg.address, expectedDataHex: c.dataHex };
  const cached = readTransactionState();
  const priorTxHash = wallet.previousAnchor?.txHash || cached?.txHash;
  if (priorTxHash) {
    // Independent check of an existing transaction (on-chain or retained cache).
    const { inspectAnchorRpc } = await import('@eventmesh/ckb');
    const inspection = await inspectAnchorRpc(rpc, priorTxHash, c.dataHex, 2);
    const status = inspection.ok ? 'CONFIRMED' : inspection.status === 'COMMITTED_UNCONFIRMED' ? 'AWAITING_CONFIRMATIONS' : 'ANCHOR_NEEDS_REVIEW';
    return persistReport({ ...common, status, txHash: priorTxHash, existing: true, inspection });
  }
  if (wallet.capacityShannons < minShannons) return persistReport({ ...common, status: 'WAITING_FOR_FUNDS' });
  if (mode !== 'run') return persistReport({ ...common, status: 'FUNDED_READY_TO_TEST' });
  if (!privateKey) return persistReport({ ...common, status: 'MISSING_TESTNET_KEY', error: NO_KEY_MESSAGE });
  if (!/^(0x)?[0-9a-f]{64}$/i.test(privateKey)) return persistReport({ ...common, status: 'INVALID_TESTNET_KEY_FORMAT' });

  // The signer-derived address must match exactly the declared PUBLIC faucet address.
  const { ccc } = await import('@ckb-ccc/shell');
  const client = new ccc.ClientPublicTestnet({ url: rpc });
  const signer = new ccc.SignerCkbPrivateKey(client, privateKey.replace(/^0x/, ''));
  await signer.connect();
  const derived = await signer.getRecommendedAddress();
  if (derived !== cfg.address) return persistReport({ ...common, status: 'KEY_ADDRESS_MISMATCH', derivedAddress: derived });

  const { CkbAnchorClient, inspectAnchorRpc } = await import('@eventmesh/ckb');
  const anchor = new CkbAnchorClient(privateKey, rpc, 220);
  const prepared = await anchor.prepareAnchor(c);
  // Durable recovery hint before broadcast. No automatic rebroadcast from a new run.
  saveTransactionState(prepared.txHash);
  persistReport({ ...common, status: 'PREPARED', txHash: prepared.txHash, outputCapacityCkb: 220 });
  try {
    await anchor.broadcastPrepared(prepared);
  } catch (error) {
    // Ambiguous broadcast: do not make a second transaction or erase tx hash.
    return persistReport({ ...common, status: 'BROADCAST_UNKNOWN_VERIFY_TX', txHash: prepared.txHash, error: String(error) });
  }
  // CKB confirmations may not arrive before workflow timeout; retain txHash for later runs.
  let inspection = { status: 'PENDING', ok: false };
  for (let n = 0; n < 30; n++) {
    await new Promise(r => setTimeout(r, 10000));
    inspection = await inspectAnchorRpc(rpc, prepared.txHash, c.dataHex, 2);
    if (inspection.ok || ['COMMITMENT_NOT_FOUND', 'TX_REJECTED'].includes(inspection.status)) break;
  }
  return persistReport({ ...common, status: inspection.ok ? 'CONFIRMED' : 'PENDING_REQUIRES_FOLLOWUP', txHash: prepared.txHash, inspection });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'probe';
  if (!['probe','run'].includes(mode)) { console.error('Usage: node scripts/auto-testnet.mjs [probe|run]'); process.exitCode=2; }
  else execute({ mode }).then(report => {
    console.log(`TESTNET_STATUS=${report.status} balance=${report.balanceCkb ?? 'unknown'} tx=${report.txHash ?? 'none'}`);
    if (['RPC_UNAVAILABLE','MISSING_TESTNET_KEY','INVALID_TESTNET_KEY_FORMAT','KEY_ADDRESS_MISMATCH','ANCHOR_NEEDS_REVIEW','BROADCAST_UNKNOWN_VERIFY_TX'].includes(report.status)) process.exitCode=1;
  }).catch(error => { persistReport({status:'RUNNER_EXCEPTION', error: String(error), address: cfg.address }); console.error('RUNNER_EXCEPTION', String(error)); process.exitCode=1; });
}
