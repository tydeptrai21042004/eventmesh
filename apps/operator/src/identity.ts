import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicKeyFromPrivate, randomPrivateKeyHex } from "@eventmesh/core";

export function loadIdentity(dataDir: string, envKey?: string, publicMode = false) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "operator.key");
  const pinnedPath = join(dataDir, "operator.public");
  let privateKey = envKey?.trim();
  if (privateKey && existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (publicKeyFromPrivate(stored) !== publicKeyFromPrivate(privateKey)) {
      throw new Error("OPERATOR_IDENTITY_CONFLICT_WITH_KEY_FILE");
    }
  }
  if (!privateKey) {
    try { privateKey = readFileSync(path, "utf8").trim(); }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      if (existsSync(pinnedPath)) throw new Error("OPERATOR_IDENTITY_KEY_MISSING_RESTORE_REQUIRED");
      if (publicMode) throw new Error("PUBLIC_MODE_REQUIRES_EXISTING_OPERATOR_IDENTITY");
      privateKey = randomPrivateKeyHex();
      // Never overwrite a concurrently created identity.
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, privateKey, "utf8"); fsyncSync(fd); }
      finally { closeSync(fd); }
    }
  }
  const publicKey = publicKeyFromPrivate(privateKey);
  if (existsSync(pinnedPath)) {
    if (readFileSync(pinnedPath, "utf8").trim() !== publicKey) throw new Error("OPERATOR_IDENTITY_CHANGED_RESTORE_REQUIRED");
  } else {
    try {
      const fd = openSync(pinnedPath, "wx", 0o600);
      try { writeFileSync(fd, publicKey, "utf8"); fsyncSync(fd); }
      finally { closeSync(fd); }
    } catch (error: any) {
      if (error?.code !== "EEXIST" || readFileSync(pinnedPath, "utf8").trim() !== publicKey) throw error;
    }
  }
  return { privateKey, publicKey };
}
