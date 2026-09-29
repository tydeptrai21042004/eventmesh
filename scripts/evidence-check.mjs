import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const manifestPath = resolve(process.argv[2] || "artifacts/funding-evidence/manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Missing funding evidence manifest: ${manifestPath}`);
  console.error("Start from docs/evidence/manifest.example.json and publish the completed evidence bundle with the final report.");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];
const requiredStrings = ["sessionId", "fiberPaymentHash", "ckbTxHash", "transcriptFile", "operatorAUrl", "operatorBUrl"];
for (const field of requiredStrings) {
  if (typeof manifest[field] !== "string" || manifest[field].trim().length === 0) failures.push(`manifest.${field} is required`);
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) failures.push(`${path} is required`);
}
function parsedUrl(value, path) {
  try { return new URL(value); }
  catch { failures.push(`${path} must be a valid URL`); return undefined; }
}

const operatorA = parsedUrl(manifest.operatorAUrl, "operatorAUrl");
const operatorB = parsedUrl(manifest.operatorBUrl, "operatorBUrl");
if (operatorA && operatorB && operatorA.origin === operatorB.origin) failures.push("operatorAUrl and operatorBUrl must have different origins");
if (!/^0x[0-9a-f]{64}$/i.test(manifest.fiberPaymentHash || "")) failures.push("fiberPaymentHash must be a 32-byte 0x hash");
if (!/^0x[0-9a-f]{64}$/i.test(manifest.ckbTxHash || "")) failures.push("ckbTxHash must be a 32-byte 0x hash");

requireString(manifest.externalIntegration?.repository, "externalIntegration.repository");
requireString(manifest.externalIntegration?.commit, "externalIntegration.commit");
requireString(manifest.externalIntegration?.maintainer, "externalIntegration.maintainer");
if (manifest.externalIntegration?.repository) parsedUrl(manifest.externalIntegration.repository, "externalIntegration.repository");

requireString(manifest.failureScenario?.name, "failureScenario.name");
requireString(manifest.failureScenario?.result, "failureScenario.result");
if (manifest.failureScenario?.receiverRestarted !== true) failures.push("failureScenario.receiverRestarted must be true");
if (manifest.failureScenario?.manualDatabaseEdits !== false) failures.push("failureScenario.manualDatabaseEdits must be false");
if (manifest.failureScenario?.exactlyOneBusinessTransition !== true) failures.push("failureScenario.exactlyOneBusinessTransition must be true");
if (!Number.isInteger(manifest.validation?.interviewCount) || manifest.validation.interviewCount < 3) {
  failures.push("validation.interviewCount must be an integer >= 3 for grant-closure evidence");
}
requireString(manifest.validation?.conclusion, "validation.conclusion");

if (typeof manifest.transcriptFile === "string") {
  const transcriptPath = resolve(dirname(manifestPath), manifest.transcriptFile);
  if (!existsSync(transcriptPath)) {
    failures.push(`transcriptFile does not exist: ${transcriptPath}`);
  } else {
    const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
    if (transcript?.session?.session?.sessionId !== manifest.sessionId) failures.push("manifest sessionId does not match transcript");
    if (transcript?.ckbAnchor?.txHash?.toLowerCase() !== manifest.ckbTxHash?.toLowerCase()) failures.push("manifest ckbTxHash does not match transcript anchor");
    const paymentHashes = (transcript?.events || [])
      .filter((row) => row?.event?.type === "PAYMENT_SETTLED" && row?.ack?.decision === "ACCEPT")
      .map((row) => row.event.payload?.paymentHash?.toLowerCase());
    if (!paymentHashes.includes(manifest.fiberPaymentHash?.toLowerCase())) failures.push("manifest fiberPaymentHash is not an accepted PAYMENT_SETTLED event");
    if (!transcript?.close?.signatureA || !transcript?.close?.signatureB) failures.push("transcript is missing a dual-signed close");
    if (transcript?.ckbAnchor?.status !== "COMMITTED") failures.push("transcript CKB anchor is not marked COMMITTED");
  }
}

if (failures.length) {
  console.error("Funding evidence package: FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Funding evidence package: STRUCTURE PASS");
console.log(`session: ${manifest.sessionId}`);
console.log(`Fiber payment: ${manifest.fiberPaymentHash}`);
console.log(`CKB transaction: ${manifest.ckbTxHash}`);
console.log(`external integration: ${manifest.externalIntegration.repository} @ ${manifest.externalIntegration.commit}`);
console.log(`validation interviews: ${manifest.validation.interviewCount}`);
console.log("Next: run the standalone EventMesh verifier against the transcript and independent FNN/CKB RPCs.");
