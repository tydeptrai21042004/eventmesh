/**
 * Dependency-free CI evidence record. It only records what GitHub actually ran.
 * Never turn a missing/failed check into a PASS or claim this verifies Testnet.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('artifacts/ci');
mkdirSync(dir, { recursive: true });
const path = resolve(dir, 'check.log');
const hash = existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex')
  : null;
const install = process.env.INSTALL_OUTCOME || 'unknown';
const verify = process.env.CHECK_OUTCOME || 'unknown';
const faults = process.env.FAULT_OUTCOME || 'unknown';
const comparison = process.env.COMPARE_OUTCOME || 'unknown';
const success = install === 'success' && verify === 'success' && faults === 'success' && comparison === 'success';
const lock = resolve('package-lock.json');
const lockSha256 = existsSync(lock) ? createHash('sha256').update(readFileSync(lock)).digest('hex') : null;
const version = (executable, args) => {
  try { return execFileSync(executable, args, { encoding: 'utf8' }).trim(); }
  catch { return 'unavailable'; }
};
const manifest = {
  schema: 'eventmesh-ci-evidence-v1',
  scope: 'BUILD_TYPECHECK_VITEST_FAULT_COMPARISON_DEMO_ONLY',
  result: success ? 'PASS' : 'FAIL',
  checks: { install, npmRunCheckAll: verify, faultMatrix: faults, alternativesComparison: comparison },
  reproducibleInstall: process.env.REPRODUCIBLE_INSTALL === 'true',
  dependencyLockSha256: lockSha256,
  repository: process.env.GITHUB_REPOSITORY || null,
  commitSha: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  node: process.version,
  npm: version('npm', ['--version']),
  checkedAtUtc: new Date().toISOString(),
  logs: hash ? { file: 'check.log', sha256: hash } : null,
  liveFiberVerified: false,
  liveCkbVerified: false
};
writeFileSync(resolve(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`CI evidence manifest: ${manifest.result} (${manifest.scope})`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### EventMesh CI\n\nOutcome: **${manifest.result}**  \nCommit: \`${manifest.commitSha || 'unavailable'}\`  \nLog SHA-256: \`${hash || 'no log'}\`\n\n**Scope:** compile, typecheck, Vitest, fault regression, comparison, Node regression tests and demo build. No Fiber/CKB live proof.\n`);
}
