import { readFileSync } from "node:fs";
import { verifyTranscript, type TranscriptExport } from "@eventmesh/core";
import { verifyAnchorRpc } from "@eventmesh/ckb";

const file = process.argv[2];
if (!file) { console.error("Usage: npm run verify -- <transcript.json> [ckb-rpc-url]"); process.exit(2); }
const transcript = JSON.parse(readFileSync(file, "utf8")) as TranscriptExport;
const result = verifyTranscript(transcript);
console.log("EventMesh v0.1 Transcript Verification");
console.log("Session:", transcript.session.session.sessionId);
console.log("Events:", transcript.events.length);
console.log("Protocol checks:", result.ok ? "PASS" : "FAIL");
for (const error of result.errors) console.log(" -", error);
if (transcript.ckbAnchor) {
  const rpc = process.argv[3];
  if (!rpc) console.log("CKB anchor: PRESENT (RPC verification skipped; pass RPC URL as second argument)");
  else {
    const ok = await verifyAnchorRpc(rpc, transcript.ckbAnchor.txHash, transcript.ckbAnchor.dataHex);
    console.log("CKB anchor RPC verification:", ok ? "PASS" : "FAIL");
    if (!ok) process.exitCode = 1;
  }
} else console.log("CKB anchor: NONE (expected in local mode)");
if (!result.ok) process.exitCode = 1;
