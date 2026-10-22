import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sha = (char) => `0x${char.repeat(64)}`;
function fixture(dir, anchorStatus = 'CONFIRMED') {
  const evidence = join(dir, 'proof');
  mkdirSync(evidence);
  const transcript = {
    session: { session: { sessionId: 'ses-evidence-test' } },
    events: [{ event: { type: 'PAYMENT_SETTLED', payload: { paymentHash: sha('a') } }, ack: { decision: 'ACCEPT' } }],
    close: { signatureA: 'placeholder', signatureB: 'placeholder' },
    ckbAnchor: { txHash: sha('b'), status: anchorStatus }
  };
  writeFileSync(join(evidence, 'proof.json'), JSON.stringify(transcript));
  const manifest = {
    sessionId: 'ses-evidence-test', fiberPaymentHash: sha('a'), ckbTxHash: sha('b'),
    transcriptFile: 'proof.json', operatorAUrl: 'https://a.example', operatorBUrl: 'https://b.example',
    externalIntegration: { repository: 'https://example.org/repo', commit: 'abc', maintainer: 'test' },
    failureScenario: { name: 'restart', result: 'recovered', receiverRestarted: true, manualDatabaseEdits: false, exactlyOneBusinessTransition: true },
    validation: { interviewCount: 3, conclusion: 'fixture' }
  };
  const manifestPath = join(evidence, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath };
}
function check(path) {
  return spawnSync(process.execPath, ['scripts/evidence-check.mjs', path], { cwd: root, encoding: 'utf8' });
}
test('CONFIRMED status passes structure check without claiming cryptographic verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'em-evidence-'));
  try {
    const { manifestPath } = fixture(dir);
    const result = check(manifestPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STRUCTURE PASS \(NOT cryptographically\/live verified\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('rejects pending anchor and path traversal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'em-evidence-'));
  try {
    const { manifest, manifestPath } = fixture(dir, 'PENDING');
    assert.equal(check(manifestPath).status, 1);
    manifest.transcriptFile = '../sensitive.json';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const traversal = check(manifestPath);
    assert.equal(traversal.status, 1);
    assert.match(traversal.stderr, /inside manifest directory/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('rejects dishonest transcript hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'em-evidence-'));
  try {
    const { manifest, manifestPath } = fixture(dir);
    manifest.transcriptSha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = check(manifestPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /transcriptSha256/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
