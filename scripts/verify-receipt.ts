/** Verify a signed application receipt offline; does NOT query Fiber or CKB. */
import { readFileSync } from "node:fs";
import { verifyApplicationReceipt } from "@eventmesh/adapter-sdk";

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log("Usage: npm run verify:receipt -- receipt.json [--require-acceptance] [--expected-provider 0x...] [--expected-consumer 0x...]");
  process.exitCode = args.includes("--help") ? 0 : 2;
} else {
  const file = args.shift()!;
  const options: { requireAcceptance?: boolean; expectedProvider?: string; expectedConsumer?: string } = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--require-acceptance") options.requireAcceptance = true;
    else if (arg === "--expected-provider" || arg === "--expected-consumer") {
      const key = args[++index];
      if (!key || !/^0x[0-9a-f]{66}$/i.test(key)) throw new Error(`${arg} requires compressed secp256k1 public key`);
      if (arg === "--expected-provider") options.expectedProvider = key;
      else options.expectedConsumer = key;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const receipt: unknown = JSON.parse(readFileSync(file, "utf8"));
  const result = verifyApplicationReceipt(receipt, options);
  console.log(JSON.stringify({
    schema: "eventmesh-application-receipt-assurance-v1",
    ...result,
    note: "Offline signature check only. Payment status, result correctness, global uniqueness and external identity ownership are NOT proven."
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
