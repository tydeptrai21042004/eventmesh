/**
 * Funding-evidence structure/linkage preflight, intentionally NOT a cryptographic
 * signature, Fiber invoice, or CKB chain verifier. Run `npm run verify` separately.
 * Every successful output is explicitly labeled STRUCTURE_ONLY.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute, sep } from 'node:path';

const manifestPath = resolve(process.argv[2] || 'artifacts/funding-evidence/manifest.json');
const errors = [];
function loadJson(path, label) {
  if (!existsSync(path)) { errors.push(`${label} not found: ${path}`); return undefined; }
  try {
    if (statSync(path).size > 8 * 1024 * 1024) throw new Error('file exceeds 8 MiB');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) { errors.push(`${label} invalid JSON or file: ${String(e.message ?? e)}`); return undefined; }
}
const manifest = loadJson(manifestPath, 'manifest');
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
  console.error('Funding evidence: STRUCTURE FAILED');
  errors.forEach((e) => console.error(`- ${e}`));
  process.exit(1);
}
const present = (x) => typeof x === 'string' && x.trim().length > 0;
for (const name of ['sessionId', 'fiberPaymentHash', 'ckbTxHash', 'transcriptFile', 'operatorAUrl', 'operatorBUrl']) {
  if (!present(manifest[name])) errors.push(`manifest.${name} is required`);
}
const h32 = (x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
for (const name of ['fiberPaymentHash', 'ckbTxHash']) if (!h32(manifest[name])) errors.push(`${name} must be a 32-byte 0x hash`);
function checkedUrl(value, label) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported scheme');
    return url;
  } catch { errors.push(`${label} must be a valid http(s) URL`); }
}
const a = checkedUrl(manifest.operatorAUrl, 'operatorAUrl');
const b = checkedUrl(manifest.operatorBUrl, 'operatorBUrl');
if (a && b && a.origin === b.origin) errors.push('operatorAUrl and operatorBUrl must have different origins (not proof of independence)');
for (const name of ['repository', 'commit', 'maintainer']) {
  if (!present(manifest.externalIntegration?.[name])) errors.push(`externalIntegration.${name} is required`);
}
if (present(manifest.externalIntegration?.repository)) checkedUrl(manifest.externalIntegration.repository, 'externalIntegration.repository');
for (const name of ['name', 'result']) if (!present(manifest.failureScenario?.[name])) errors.push(`failureScenario.${name} is required`);
for (const [name, expected] of [['receiverRestarted', true], ['manualDatabaseEdits', false], ['exactlyOneBusinessTransition', true]]) {
  if (manifest.failureScenario?.[name] !== expected) errors.push(`failureScenario.${name} must be ${expected}`);
}
if (!Number.isInteger(manifest.validation?.interviewCount) || manifest.validation.interviewCount < 3) errors.push('validation.interviewCount must be at least 3');
if (!present(manifest.validation?.conclusion)) errors.push('validation.conclusion is required');

if (present(manifest.transcriptFile)) {
  const name = manifest.transcriptFile;
  const directory = realpathSync(dirname(manifestPath));
  if (isAbsolute(name)) errors.push('transcriptFile must be relative to manifest directory');
  else {
    const file = resolve(directory, name);
    const rel = relative(directory, file);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) errors.push('transcriptFile must stay inside manifest directory');
    else if (!existsSync(file)) errors.push(`transcriptFile not found: ${name}`);
    else {
      const real = realpathSync(file);
      const realRel = relative(directory, real);
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) errors.push('transcriptFile symlink escapes evidence directory');
      else {
        const bytes = readFileSync(real);
        if (present(manifest.transcriptSha256)) {
          const hash = createHash('sha256').update(bytes).digest('hex');
          if (hash.toLowerCase() !== manifest.transcriptSha256.toLowerCase()) errors.push('transcriptSha256 does not match file');
        }
        const t = loadJson(real, 'transcript');
        if (t) {
          if (t.session?.session?.sessionId !== manifest.sessionId) errors.push('sessionId differs from transcript');
          if (t.ckbAnchor?.txHash?.toLowerCase() !== manifest.ckbTxHash?.toLowerCase()) errors.push('CKB tx hash differs from transcript');
          if (!['COMMITTED', 'CONFIRMED'].includes(t.ckbAnchor?.status)) errors.push('CKB anchor must be COMMITTED or CONFIRMED');
          if (!t.close?.signatureA || !t.close?.signatureB) errors.push('dual-signed close missing');
          const hashes = (Array.isArray(t.events) ? t.events : [])
            .filter((row) => row?.event?.type === 'PAYMENT_SETTLED' && row?.ack?.decision === 'ACCEPT')
            .map((row) => row.event.payload?.paymentHash?.toLowerCase());
          if (!hashes.includes(manifest.fiberPaymentHash?.toLowerCase())) errors.push('accepted Fiber payment claim not found');
        }
      }
    }
  }
}
if (errors.length) {
  console.error('Funding evidence: STRUCTURE FAILED (NOT independently verified)');
  errors.forEach((e) => console.error(`- ${e}`));
  process.exit(1);
}
console.log('Funding evidence: STRUCTURE PASS (NOT cryptographically/live verified)');
console.log(`session: ${manifest.sessionId}`);
console.log(`Fiber payment: ${manifest.fiberPaymentHash}`);
console.log(`CKB transaction: ${manifest.ckbTxHash}`);
console.log('NEXT: independent transcript verifier + receiver-owned FNN RPC + CKB RPC required.');
