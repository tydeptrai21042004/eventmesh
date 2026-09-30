#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-.env.local}"
TARGET="${VERCEL_TARGET:-production}"

env_get() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  ENV_KEY="$key" node - "$ENV_FILE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const key = process.env.ENV_KEY;
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const i = trimmed.indexOf("=");
  if (i < 0 || trimmed.slice(0, i).trim() !== key) continue;
  let value = trimmed.slice(i + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch {}
  } else if (value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }
  process.stdout.write(value);
  process.exit(0);
}
NODE
}

DEMO_MASTER_SECRET="${DEMO_MASTER_SECRET:-$(env_get DEMO_MASTER_SECRET)}"
DEMO_RATE_LIMIT_PER_MINUTE="${DEMO_RATE_LIMIT_PER_MINUTE:-$(env_get DEMO_RATE_LIMIT_PER_MINUTE)}"
CKB_RPC_URL="${CKB_RPC_URL:-$(env_get CKB_RPC_URL)}"
CKB_PRIVATE_KEY="${CKB_PRIVATE_KEY:-$(env_get CKB_PRIVATE_KEY)}"
CKB_ANCHOR_CAPACITY_CKB="${CKB_ANCHOR_CAPACITY_CKB:-$(env_get CKB_ANCHOR_CAPACITY_CKB)}"
FIBER_RECEIVER_RPC_URL="${FIBER_RECEIVER_RPC_URL:-$(env_get FIBER_RECEIVER_RPC_URL)}"
FIBER_RECEIVER_RPC_TOKEN="${FIBER_RECEIVER_RPC_TOKEN:-$(env_get FIBER_RECEIVER_RPC_TOKEN)}"
DEMO_ALLOW_CKB_BROADCAST="${DEMO_ALLOW_CKB_BROADCAST:-$(env_get DEMO_ALLOW_CKB_BROADCAST)}"

DEMO_RATE_LIMIT_PER_MINUTE="${DEMO_RATE_LIMIT_PER_MINUTE:-60}"
CKB_RPC_URL="${CKB_RPC_URL:-https://testnet.ckbapp.dev/}"
CKB_ANCHOR_CAPACITY_CKB="${CKB_ANCHOR_CAPACITY_CKB:-220}"
DEMO_ALLOW_CKB_BROADCAST="${DEMO_ALLOW_CKB_BROADCAST:-false}"

if [[ -n "$DEMO_MASTER_SECRET" && ${#DEMO_MASTER_SECRET} -lt 32 ]]; then
  echo "ERROR: DEMO_MASTER_SECRET must be at least 32 characters when supplied" >&2
  exit 2
fi

if command -v vercel >/dev/null 2>&1; then
  VC=(vercel)
else
  VC=(npx --yes vercel@latest)
fi

npm install --no-audit --no-fund
npm run check
"${VC[@]}" link --yes

push_env() {
  local name="$1" value="$2" sensitive="${3:-0}"
  [[ -z "$value" ]] && return 0
  if [[ "$sensitive" == "1" ]]; then
    printf '%s' "$value" | "${VC[@]}" env add "$name" "$TARGET" --force --sensitive
  else
    printf '%s' "$value" | "${VC[@]}" env add "$name" "$TARGET" --force
  fi
}

# DEMO_MASTER_SECRET is optional. Without it, EventMesh uses explicitly public,
# demo-only deterministic identities so the preview works immediately.
push_env DEMO_MASTER_SECRET "$DEMO_MASTER_SECRET" 1
push_env DEMO_RATE_LIMIT_PER_MINUTE "$DEMO_RATE_LIMIT_PER_MINUTE" 0
push_env CKB_RPC_URL "$CKB_RPC_URL" 0
push_env CKB_PRIVATE_KEY "${CKB_PRIVATE_KEY:-}" 1
push_env DEMO_ALLOW_CKB_BROADCAST "$DEMO_ALLOW_CKB_BROADCAST" 0
push_env CKB_ANCHOR_CAPACITY_CKB "$CKB_ANCHOR_CAPACITY_CKB" 0
push_env FIBER_RECEIVER_RPC_URL "${FIBER_RECEIVER_RPC_URL:-}" 0
push_env FIBER_RECEIVER_RPC_TOKEN "${FIBER_RECEIVER_RPC_TOKEN:-}" 1

if [[ "$TARGET" == "production" ]]; then
  DEPLOY_URL="$("${VC[@]}" deploy --prod --yes)"
else
  DEPLOY_URL="$("${VC[@]}" deploy --yes)"
fi

echo "Deployment: $DEPLOY_URL"
node scripts/verify-deployment.mjs "$DEPLOY_URL"
echo "PASS: EventMesh zero-database preview deployment smoke test completed."
