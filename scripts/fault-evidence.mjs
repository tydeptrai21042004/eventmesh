import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const dir = 'artifacts/fault-matrix';
mkdirSync(dir, { recursive: true });
const file = `${dir}/faults.log`;
const digest = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const result = process.env.TEST_OUTCOME === 'success' ? 'PASS' : 'FAIL';
const payload = {
  schema: 'eventmesh-fault-evidence-v1',
  scope: 'SIMULATED_DETERMINISTIC_TESTS_ONLY', result,
  commit: process.env.GITHUB_SHA ?? null,
  run: process.env.GITHUB_RUN_ID ?? null,
  logSha256: digest,
  realFiberPaymentVerified: false,
  liveCkbAnchoringVerified: false,
  checkedAtUtc: new Date().toISOString()
};
writeFileSync(`${dir}/manifest.json`, JSON.stringify(payload, null, 2) + '\n');
console.log(`Fault matrix evidence: ${result}, log SHA-256=${digest ?? 'missing'}`);
