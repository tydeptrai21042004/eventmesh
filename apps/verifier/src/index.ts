import { readFileSync } from "node:fs";
import {
  acceptedFiberPaymentClaims,
  buildAnchorDataHex,
  canonical,
  verifyTranscript,
  type TranscriptExport
} from "@eventmesh/core";
import { verifyAnchorRpcDetailed } from "@eventmesh/ckb";
import { FiberRpcClient } from "@eventmesh/fiber";
import { paidServiceReferenceAdapter, validateTranscriptWithAdapter } from "@eventmesh/adapter-sdk";

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

const transcript = JSON.parse(readFileSync(file, "utf8")) as TranscriptExport;
const offline = verifyTranscript(transcript);
let failed = !offline.ok;

console.log("EventMesh v0.2 Independent Verification");
console.log(`[${offline.ok ? "PASS" : "FAIL"}] offline transcript invariants`);
for (const error of offline.errors) console.log(`       ${error}`);

const adapterName = flags.get("--adapter");
if (adapterName) {
  if (adapterName !== "paid-service-reference" && adapterName !== "paid-service") {
    console.log(`[FAIL] unknown adapter ${String(adapterName)}`);
    failed = true;
  } else {
    const appResult = validateTranscriptWithAdapter(transcript, paidServiceReferenceAdapter);
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
  if (!claims.length) console.log("[INFO] no accepted PAYMENT_SETTLED events to verify");
  for (const claim of claims) {
    try {
      const checked = await client.verifyReceivedPaymentClaim(claim);
      if (checked.ok) {
        console.log(`[PASS] Fiber receiver evidence ${claim.paymentHash}`);
      } else {
        console.log(`[FAIL] Fiber receiver evidence ${claim.paymentHash}: ${checked.reason}`);
        failed = true;
      }
    } catch (error) {
      console.log(`[FAIL] Fiber receiver evidence ${claim.paymentHash}: ${String(error)}`);
      failed = true;
    }
  }
} else if (flags.has("--require-fiber")) {
  console.log("[FAIL] --require-fiber needs --receiver-fiber-rpc");
  failed = true;
}
if (flags.has("--require-fiber") && !claims.length) {
  console.log("[FAIL] --require-fiber requires at least one accepted PAYMENT_SETTLED event");
  failed = true;
}

const ckbRpc = flags.get("--ckb-rpc");
if (transcript.close && transcript.ckbAnchor) {
  const expected = buildAnchorDataHex(
    transcript.session.session.sessionId,
    transcript.close.close.transcriptRoot,
    transcript.close.close.finalStateHash,
    transcript.close.close.paymentEvidenceRoot
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
    if (!result.ok) failed = true;
  } else if (flags.has("--require-ckb")) {
    console.log("[FAIL] --require-ckb needs --ckb-rpc");
    failed = true;
  }
} else if (flags.has("--require-ckb")) {
  console.log("[FAIL] --require-ckb requires both close and ckbAnchor in transcript");
  failed = true;
}

console.log(failed ? "RESULT: FAILED" : "RESULT: VERIFIED");
if (failed) process.exitCode = 1;
