import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicKeyFromPrivate, randomPrivateKeyHex } from "@eventmesh/core";

export function loadIdentity(dataDir: string, envKey?: string) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "operator.key");
  let privateKey = envKey?.trim();
  if (!privateKey) {
    try { privateKey = readFileSync(path, "utf8").trim(); }
    catch {
      privateKey = randomPrivateKeyHex();
      writeFileSync(path, privateKey, { mode: 0o600 });
    }
  }
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}
