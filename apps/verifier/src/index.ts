import { readFileSync, writeFileSync } from "node:fs";
import {
  acceptedFiberPaymentClaims,
  buildAnchorDataHex,
  canonical,
  finalStateHashFrom,
  deriveGenericBilateralFinalState,
  GENERIC_BILATERAL_PROFILE,
  CLOSE_COMMITMENT_VERSION,
  verifyTranscript,
  type TranscriptExport
} from "@eventmesh/core";
import { verifyAnchorRpcDetailed } from "@eventmesh/ckb";
import { FiberRpcClient } from "@eventmesh/fiber";
import { PAID_SERVICE_PROFILE, PAID_SERVICE_V2_PROFILE, paidServiceReferenceAdapter, paidServiceStrictAdapter, validateTranscriptWithAdapter } from "@eventmesh/adapter-sdk";

function usage() {
  console.error(`Usage:
  npm run verify -- <transcript.json> [options]

Options:
  --ckb-rpc <url>              Independently query CKB get_transaction
  --ckb-confirmations <n>      Require at least n CKB confirmations (default: 0)
  --receiver-fiber-rpc <url>   Independently query receiver FNN get_invoice
  --fiber-token <token>        Optional FNN bearer token
  --adapter <name>             Validate application semantics (paid-service-reference)
  --require-close              Fail unless a dual-signed close exists
  --require-fiber              Fail unless at least one Fiber claim exists and all are receiver-verified
  --require-ckb                Fail unless a committed matching CKB anchor is independently verified
  --expected-operator-a <pub>  Pin expected A secp256k1 public key (0x-prefixed 33 bytes)
  --expected-operator-b <pub>  Pin expected B secp256k1 public key (0x-prefixed 33 bytes)
  --json-report <file>         Write machine-readable assurance report (without secrets)
`);
}

const args = process.argv.slice(2);
const file = args.shift();
if (!file) {
  usage();
  process.exit(2);
}

const flags = new Map<string, string | true>();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (!arg.startsWith("--")) {
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  if (["--require-close", "--require-fiber", "--require-ckb"].includes(arg)) {
    flags.set(arg, true);
    continue;
  }
  const value = args[++index];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for ${arg}`);
    process.exit(2);
  }
  flags.set(arg, value);
}

const ckbConfirmationsRaw = flags.get("--ckb-confirmations");
const ckbConfirmations = ckbConfirmationsRaw === undefined ? 0 : Number(ckbConfirmationsRaw);
if (!Number.isInteger(ckbConfirmations) || ckbConfirmations < 0) {
  console.error("--ckb-confirmations must be a non-negative integer");
  process.exit(2);
}

for (const flag of flags.keys()) {
  if (!["--ckb-rpc", "--ckb-confirmations", "--receiver-fiber-rpc", "--fiber-token", "--adapter", "--require-close", "--require-fiber", "--require-ckb", "--expected-operator-a", "--expected-operator-b", "--json-report"].includes(flag)) {
    console.error(`Unknown option: ${flag}`);
    process.exit(2);
  }
}
for (const option of ["--expected-operator-a", "--expected-operator-b"]) {
  const expected = flags.get(option);
  if (expected !== undefined && (typeof expected !== "string" || !/^0x[0-9a-f]{66}$/i.test(expected))) {
    console.error(`${option} must be a 33-byte compressed secp256k1 public key`);
    process.exit(2);
  }
}

const transcript = JSON.parse(readFileSync(file, "utf8")) as TranscriptExport;
const offline = verifyTranscript(transcript);
let failed = !offline.ok;
const assurance = {
  offlineSignatures: offline.ok,
  dualSignedClose: offline.ok && !!transcript.close,
  operatorAIdentityPinned: false,
  operatorBIdentityPinned: false,
  fiber: "NOT_REQUESTED" as "NOT_REQUESTED" | "NO_CLAIMS" | "VERIFIED" | "FAILED",
  ckb: "NOT_REQUESTED" as "NOT_REQUESTED" | "COMMITTED" | "CONFIRMED" | "FAILED",
  applicationProfile: "NOT_PRESENT" as "NOT_PRESENT" | "VERIFIED" | "FAILED"
};
for (const [option, label, actual, field] of [
  ["--expected-operator-a", "A", transcript.session.session.operatorA, "operatorAIdentityPinned"],
  ["--expected-operator-b", "B", transcript.session.session.operatorB, "operatorBIdentityPinned"]
] as const) {
  const expected = flags.get(option);
  if (typeof expected !== "string") continue;
  const matches = actual.toLowerCase() === expected.toLowerCase();
  assurance[field] = matches;
  console.log(`[${matches ? "PASS" : "FAIL"}] pinned operator ${label} public key`);
  if (!matches) failed = true;
}

console.log("EventMesh v0.2 Independent Verification");
console.log(`[${offline.ok ? "PASS" : "FAIL"}] offline transcript invariants`);
for (const error of offline.errors) console.log(`       ${error}`);

const signedProfile = transcript.session.session.applicationProfile;
if (signedProfile) {
  const profileMatches = (expected: typeof GENERIC_BILATERAL_PROFILE) =>
    signedProfile.id === expected.id
    && signedProfile.version === expected.version
    && signedProfile.rulesHash.toLowerCase() === expected.rulesHash.toLowerCase();
  if (profileMatches(PAID_SERVICE_PROFILE) || profileMatches(PAID_SERVICE_V2_PROFILE)) {
    const appResult = validateTranscriptWithAdapter(transcript,
      profileMatches(PAID_SERVICE_V2_PROFILE) ? paidServiceStrictAdapter : paidServiceReferenceAdapter);
    if (!appResult.ok) {
      console.log("[FAIL] signed paid-service application profile");
      for (const error of appResult.errors) console.log(`       ${error}`);
      failed = true;
      assurance.applicationProfile = "FAILED";
    } else if (profileMatches(PAID_SERVICE_V2_PROFILE) && transcript.close && transcript.close.finalState === undefined) {
      // A v2 verifier must not describe unprovided application state as verified.
      // Signed-hash-only historical closes remain valid at the core layer.
      assurance.applicationProfile = "FAILED";
      console.log("[FAIL] strict paid-service close must disclose verifiable finalState");
      failed = true;
    } else if (transcript.close?.finalState !== undefined && (
      canonical(transcript.close.finalState) !== canonical(appResult.finalState)
      || finalStateHashFrom(appResult.finalState).toLowerCase() !== transcript.close.close.finalStateHash.toLowerCase()
    )) {
      assurance.applicationProfile = "FAILED";
      console.log("[FAIL] signed-profile final state does not match the close commitment");
      failed = true;
    } else {
      console.log("[PASS] signed paid-service profile semantics" + (transcript.close ? " and committed final state" : " (no close supplied)"));
      assurance.applicationProfile = "VERIFIED";
    }
  } else if (profileMatches(GENERIC_BILATERAL_PROFILE)) {
    const finalItems = transcript.events.flatMap((row) => row.ack ? [{ event: row.event, ack: row.ack }] : []);
    const derived = deriveGenericBilateralFinalState(finalItems);
    if (transcript.close?.finalState !== undefined && canonical(transcript.close.finalState) !== canonical(derived)) {
      console.log("[FAIL] close finalState differs from generic deterministic derivation");
      assurance.applicationProfile = "FAILED";
      failed = true;
    } else {
      console.log("[PASS] signed generic-bilateral profile and deterministic final state");
      assurance.applicationProfile = "VERIFIED";
    }
  } else {
    console.log("[FAIL] unknown or rulesHash-mismatched signed application profile");
    assurance.applicationProfile = "FAILED";
    failed = true;
  }
}

const adapterName = flags.get("--adapter");
if (adapterName) {
  if (!["paid-service-reference", "paid-service", "paid-service-v2", "paid-service-strict"].includes(String(adapterName))) {
    console.log(`[FAIL] unknown adapter ${String(adapterName)}`);
    failed = true;
  } else {
    const appResult = validateTranscriptWithAdapter(transcript,
      adapterName === "paid-service-v2" || adapterName === "paid-service-strict"
        ? paidServiceStrictAdapter : paidServiceReferenceAdapter);
    if (!appResult.ok) {
      console.log("[FAIL] paid-service application semantics");
      for (const error of appResult.errors) console.log(`       ${error}`);
      failed = true;
    } else {
      console.log("[PASS] paid-service application event semantics");
      if (transcript.close?.finalState !== undefined && canonical(transcript.close.finalState) !== canonical(appResult.finalState)) {
        console.log("[FAIL] close finalState differs from adapter-derived final state");
        failed = true;
      } else if (transcript.close?.finalState !== undefined) {
        console.log("[PASS] close finalState matches adapter-derived final state");
      }
    }
  }
}

if (flags.has("--require-close") && !transcript.close) {
  console.log("[FAIL] dual-signed close required but missing");
  failed = true;
} else if (transcript.close) {
  console.log("[PASS] close present and covered by offline signature/root checks");
}

const claims = acceptedFiberPaymentClaims(transcript.events);
const receiverFiberRpc = flags.get("--receiver-fiber-rpc");
if (receiverFiberRpc && typeof receiverFiberRpc === "string") {
  const client = new FiberRpcClient(
    receiverFiberRpc,
    typeof flags.get("--fiber-token") === "string" ? String(flags.get("--fiber-token")) : undefined
  );
  if (!claims.length) {
    console.log("[INFO] no accepted PAYMENT_SETTLED events to verify");
    assurance.fiber = "NO_CLAIMS";
  } else assurance.fiber = "VERIFIED";
  for (const claim of claims) {
    try {
      const checked = await client.verifyReceivedPaymentClaim(claim);
      if (checked.ok) {
        console.log(`[PASS] Fiber receiver evidence ${claim.paymentHash}`);
      } else {
        console.log(`[FAIL] Fiber receiver evidence ${claim.paymentHash}: ${checked.reason}`);
        failed = true;
        assurance.fiber = "FAILED";
      }
    } catch (error) {
      console.log(`[FAIL] Fiber receiver evidence ${claim.paymentHash}: ${String(error)}`);
      failed = true;
      assurance.fiber = "FAILED";
    }
  }
} else if (flags.has("--require-fiber")) {
  console.log("[FAIL] --require-fiber needs --receiver-fiber-rpc");
  failed = true;
  assurance.fiber = "FAILED";
}
if (flags.has("--require-fiber") && !claims.length) {
  console.log("[FAIL] --require-fiber requires at least one accepted PAYMENT_SETTLED event");
  failed = true;
  assurance.fiber = "FAILED";
}

const ckbRpc = flags.get("--ckb-rpc");
if (transcript.close && transcript.ckbAnchor) {
  const close = transcript.close.close;
  const expected = buildAnchorDataHex(
    transcript.session.session.sessionId,
    close.transcriptRoot,
    close.finalStateHash,
    close.paymentEvidenceRoot,
    close.commitmentVersion === CLOSE_COMMITMENT_VERSION
      && close.paymentObservationRoot
      && close.applicationProfileHash
      && close.chainContextHash
      ? {
          paymentObservationRoot: close.paymentObservationRoot,
          applicationProfileHash: close.applicationProfileHash,
          chainContextHash: close.chainContextHash
        }
      : undefined
  );
  if (transcript.ckbAnchor.dataHex.toLowerCase() !== expected.toLowerCase()) {
    console.log("[FAIL] CKB commitment bytes mismatch local derivation");
    failed = true;
  } else {
    console.log("[PASS] CKB commitment bytes locally derived");
  }

  if (ckbRpc && typeof ckbRpc === "string") {
    const result = await verifyAnchorRpcDetailed(ckbRpc, transcript.ckbAnchor.txHash, expected, ckbConfirmations);
    console.log(`[${result.ok ? "PASS" : "FAIL"}] CKB RPC ${result.status}`);
    assurance.ckb = result.ok ? (result.status === "CONFIRMED" ? "CONFIRMED" : "COMMITTED") : "FAILED";
    if (!result.ok) failed = true;
  } else if (flags.has("--require-ckb")) {
    console.log("[FAIL] --require-ckb needs --ckb-rpc");
    assurance.ckb = "FAILED";
    failed = true;
  }
} else if (flags.has("--require-ckb")) {
  console.log("[FAIL] --require-ckb requires both close and ckbAnchor in transcript");
  assurance.ckb = "FAILED";
  failed = true;
}

console.log(`ASSURANCE: offline=${assurance.offlineSignatures ? "PASS" : "FAIL"}; close=${assurance.dualSignedClose ? "PASS" : "NOT_VERIFIED"}; receiverFiber=${assurance.fiber}; ckb=${assurance.ckb}; application=${assurance.applicationProfile}`);
console.log(failed ? "RESULT: FAILED" : "RESULT: VERIFIED (requested checks only)");
const reportPath = flags.get("--json-report");
if (typeof reportPath === "string") {
  writeFileSync(reportPath, `${JSON.stringify({
    schema: "eventmesh-assurance-v1",
    result: failed ? "FAILED" : "VERIFIED_REQUESTED_CHECKS",
    sessionId: transcript.session.session.sessionId,
    assurance,
    requirements: {
      close: flags.has("--require-close"),
      fiber: flags.has("--require-fiber"),
      ckb: flags.has("--require-ckb"),
      ckbConfirmations
    },
    checkedAtUtc: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
}
if (failed) process.exitCode = 1;
