#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-.env.local}"
TARGET="${VERCEL_TARGET:-production}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE not found. Run ./scripts/generate-env.sh first." >&2
  exit 2
fi

env_get() {
  local key="$1"
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
  if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value); } catch {} }
  else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  process.stdout.write(value);
  process.exit(0);
}
NODE
}

read_env() { local name="$1"; printf '%s' "${!name:-$(env_get "$name")}"; }

DEMO_MASTER_SECRET="$(read_env DEMO_MASTER_SECRET)"
DEMO_RATE_LIMIT_PER_MINUTE="$(read_env DEMO_RATE_LIMIT_PER_MINUTE)"
EVENTMESH_PUBLIC_ORIGIN="$(read_env EVENTMESH_PUBLIC_ORIGIN)"
EVENTMESH_TESTNET_MODE="$(read_env EVENTMESH_TESTNET_MODE)"
EVENTMESH_TESTNET_ACCESS_KEY="$(read_env EVENTMESH_TESTNET_ACCESS_KEY)"
TESTNET_RATE_LIMIT_PER_MINUTE="$(read_env TESTNET_RATE_LIMIT_PER_MINUTE)"
OPERATOR_A_PRIVATE_KEY="$(read_env OPERATOR_A_PRIVATE_KEY)"
OPERATOR_B_PRIVATE_KEY="$(read_env OPERATOR_B_PRIVATE_KEY)"
CKB_RPC_URL="$(read_env CKB_RPC_URL)"
CKB_PRIVATE_KEY="$(read_env CKB_PRIVATE_KEY)"
TESTNET_ALLOW_CKB_BROADCAST="$(read_env TESTNET_ALLOW_CKB_BROADCAST)"
CKB_ANCHOR_CAPACITY_CKB="$(read_env CKB_ANCHOR_CAPACITY_CKB)"
FIBER_RECEIVER_RPC_URL="$(read_env FIBER_RECEIVER_RPC_URL)"
FIBER_RECEIVER_RPC_TOKEN="$(read_env FIBER_RECEIVER_RPC_TOKEN)"

: "${DEMO_MASTER_SECRET:?DEMO_MASTER_SECRET missing from $ENV_FILE}"
DEMO_RATE_LIMIT_PER_MINUTE="${DEMO_RATE_LIMIT_PER_MINUTE:-60}"
EVENTMESH_TESTNET_MODE="${EVENTMESH_TESTNET_MODE:-false}"
TESTNET_RATE_LIMIT_PER_MINUTE="${TESTNET_RATE_LIMIT_PER_MINUTE:-30}"
CKB_RPC_URL="${CKB_RPC_URL:-https://testnet.ckbapp.dev/}"
CKB_ANCHOR_CAPACITY_CKB="${CKB_ANCHOR_CAPACITY_CKB:-220}"
TESTNET_ALLOW_CKB_BROADCAST="${TESTNET_ALLOW_CKB_BROADCAST:-false}"

if command -v vercel >/dev/null 2>&1; then VC=(vercel); else VC=(npx --yes vercel@latest); fi

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

push_env DEMO_MASTER_SECRET "$DEMO_MASTER_SECRET" 1
push_env DEMO_RATE_LIMIT_PER_MINUTE "$DEMO_RATE_LIMIT_PER_MINUTE" 0
push_env EVENTMESH_PUBLIC_ORIGIN "$EVENTMESH_PUBLIC_ORIGIN" 0
push_env EVENTMESH_TESTNET_MODE "$EVENTMESH_TESTNET_MODE" 0
push_env EVENTMESH_TESTNET_ACCESS_KEY "$EVENTMESH_TESTNET_ACCESS_KEY" 1
push_env TESTNET_RATE_LIMIT_PER_MINUTE "$TESTNET_RATE_LIMIT_PER_MINUTE" 0
push_env OPERATOR_A_PRIVATE_KEY "$OPERATOR_A_PRIVATE_KEY" 1
push_env OPERATOR_B_PRIVATE_KEY "$OPERATOR_B_PRIVATE_KEY" 1
push_env CKB_RPC_URL "$CKB_RPC_URL" 0
push_env CKB_PRIVATE_KEY "$CKB_PRIVATE_KEY" 1
push_env TESTNET_ALLOW_CKB_BROADCAST "$TESTNET_ALLOW_CKB_BROADCAST" 0
push_env CKB_ANCHOR_CAPACITY_CKB "$CKB_ANCHOR_CAPACITY_CKB" 0
push_env FIBER_RECEIVER_RPC_URL "$FIBER_RECEIVER_RPC_URL" 0
push_env FIBER_RECEIVER_RPC_TOKEN "$FIBER_RECEIVER_RPC_TOKEN" 1

if [[ "$TARGET" == "production" ]]; then DEPLOY_URL="$("${VC[@]}" deploy --prod --yes)"; else DEPLOY_URL="$("${VC[@]}" deploy --yes)"; fi

echo "Deployment: $DEPLOY_URL"
node scripts/verify-deployment.mjs "$DEPLOY_URL"
echo "PASS: EventMesh v0.6 Vercel deployment smoke test completed."
