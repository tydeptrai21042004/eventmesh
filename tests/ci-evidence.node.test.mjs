import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/ci-evidence.mjs');
function collect(env, addLog = false) {
  const dir = mkdtempSync(join(tmpdir(), 'eventmesh-ci-proof-'));
  try {
    mkdirSync(join(dir, 'artifacts/ci'), { recursive: true });
    if (addLog) writeFileSync(join(dir, 'artifacts/ci/check.log'), 'FAKE UNIT FIXTURE: sample log\n');
    const run = spawnSync(process.execPath, [script], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, INSTALL_OUTCOME: 'unknown', CHECK_OUTCOME: 'unknown', ...env }
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(readFileSync(join(dir, 'artifacts/ci/manifest.json'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('CI evidence fails closed without verified check outcomes', () => {
  const result = collect({}, false);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.logs, null);
  assert.equal(result.liveFiberVerified, false);
  assert.equal(result.liveCkbVerified, false);
});
test('CI evidence hashes logs and marks only explicitly successful checks as PASS', () => {
  const result = collect({ INSTALL_OUTCOME: 'success', CHECK_OUTCOME: 'success', REPRODUCIBLE_INSTALL: 'false' }, true);
  assert.equal(result.result, 'PASS');
  assert.equal(result.reproducibleInstall, false);
  assert.equal(result.logs.sha256, createHash('sha256').update('FAKE UNIT FIXTURE: sample log\n').digest('hex'));
  assert.equal(result.liveFiberVerified, false);
  assert.equal(result.liveCkbVerified, false);
});
test('one failed check must produce a FAIL report even if a log exists', () => {
  const result = collect({ INSTALL_OUTCOME: 'success', CHECK_OUTCOME: 'failure' }, true);
  assert.equal(result.result, 'FAIL');
});
