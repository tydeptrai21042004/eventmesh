/** Local proof-of-format example. Creates disposable demo keys (NOT production identities). */
import { writeFileSync } from "node:fs";
import { randomPrivateKeyHex, publicKeyFromPrivate, sha256Hex } from "@eventmesh/core";
import { acknowledgeApplicationReceipt, createProviderReceipt, verifyApplicationReceipt } from "@eventmesh/adapter-sdk";

const consumerKey = randomPrivateKeyHex();
const providerKey = randomPrivateKeyHex();
const createdAt = new Date();
const proof = acknowledgeApplicationReceipt(createProviderReceipt({
  version: "eventmesh-app-receipt-v1",
  sessionId: "demo-job-session",
  requestId: "demo-job-1",
  serviceHash: sha256Hex("demo-computation-v1"),
  resultHash: sha256Hex("demo-output"),
  provider: publicKeyFromPrivate(providerKey),
  consumer: publicKeyFromPrivate(consumerKey),
  createdAt: createdAt.toISOString(),
  expiresAt: new Date(createdAt.getTime() + 60_000).toISOString()
}, providerKey), consumerKey, "ACCEPT", new Date(createdAt.getTime() + 1000).toISOString());
const output = process.argv[2] ?? "receipt-example.json";
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
const result = verifyApplicationReceipt(proof, { requireAcceptance: true });
console.log(JSON.stringify({ file: output, result, warning: "Demo-only signatures; no Fiber payment was verified." }, null, 2));
if (!result.ok) process.exitCode = 1;
