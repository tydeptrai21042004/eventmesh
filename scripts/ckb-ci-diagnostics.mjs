/** Read-only diagnostics: deliberately never signs or sends CKB/Fiber transactions. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { execute, DEFAULT_RPC, rpcCall } from './auto-testnet.mjs';
const now = () => new Date().toISOString();
const summary = (line) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };
const result = { schema: 'eventmesh-ckb-diagnostics-v1', at: now(), scope: 'READ_ONLY; NO FIBER PAYMENT; NO TX BROADCAST', checks: {} };
const rpc = process.env.CKB_RPC_URL || DEFAULT_RPC;
const url = new URL(rpc);
// Do not log request query, credentials, raw body or private key.
const host = url.hostname;
const check = async (name, fn) => {
  try { result.checks[name] = { status: 'PASS', detail: await fn() }; }
  catch (err) {
    const errorName = String(err?.name || 'Error');
    const code = String(err?.cause?.code || err?.code || 'UNKNOWN').slice(0, 48);
    result.checks[name] = { status: 'FAIL', errorType: errorName, errorCode: code };
  }
  console.log(`[CKB_DIAG] ${name} ${JSON.stringify(result.checks[name])}`);
};
await check('dns', async () => ({ hostname: host, addressFamilies: [...new Set((await lookup(host, { all: true })).map(x => x.family))] }));
await check('chain_rpc', async () => ({ tipBlockNumber: await rpcCall(rpc, 'get_tip_block_number', []) }));
await check('indexer_rpc', async () => {
  const tip = await rpcCall(rpc, 'get_indexer_tip', []);
  return { hasIndexerTip: !!tip, blockNumber: tip?.block_number || null };
});
await check('wallet_probe', async () => {
  const r = await execute({ mode: 'probe', rpc });
  return { status: r.status, balanceCkb: r.balanceCkb ?? null, address: r.address ?? null,
    errorCategory: r.status === 'RPC_UNAVAILABLE' ? 'INDEXER_OR_NETWORK' : null };
});
result.checks.signingSecret = { status: 'INFO', present: Boolean(process.env.CKB_TESTNET_PRIVATE_KEY),
  note: 'This is only a presence check; live anchoring is signed by Operator A, not this CI job.' };
mkdirSync('artifacts/testnet', { recursive: true });
writeFileSync('artifacts/testnet/diagnostics.json', JSON.stringify(result, null, 2) + '\n');
summary('\n### EventMesh CKB RPC diagnostics (read-only)\n');
summary('| Check | Status | Detail |\n|---|---|---|');
for (const [k, v] of Object.entries(result.checks)) summary(`| ${k} | ${v.status} | ${v.errorCode || v.detail?.status || v.detail?.tipBlockNumber || '—'} |`);
if (['chain_rpc', 'indexer_rpc', 'wallet_probe'].some(k => result.checks[k]?.status === 'FAIL')) {
  console.error('[CKB_DIAG] RPC_DIAGNOSTICS_FAILED: see artifacts/testnet/diagnostics.json');
  // The monitoring job remains an observation, not a payment gate.
}
