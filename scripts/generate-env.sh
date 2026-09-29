#!/usr/bin/env bash
set -euo pipefail

OUT="${1:-.env.local}"
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
DEFAULT_CKB_RPC="https://testnet.ckbapp.dev/"

if [[ -f "$OUT" ]]; then
  cp "$OUT" "$OUT.bak.$(date +%Y%m%d%H%M%S)"
fi

random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  fi
}

ask() {
  local prompt="$1" default="${2:-}" value=""
  if [[ "$NON_INTERACTIVE" == "1" ]]; then printf '%s' "$default"; return; fi
  read -r -p "$prompt${default:+ [$default]}: " value
  printf '%s' "${value:-$default}"
}

DEMO_MASTER_SECRET="${DEMO_MASTER_SECRET:-$(random_secret)}"
CKB_RPC_URL="${CKB_RPC_URL:-$DEFAULT_CKB_RPC}"
CKB_PRIVATE_KEY="${CKB_PRIVATE_KEY:-}"
DEMO_ALLOW_CKB_BROADCAST="${DEMO_ALLOW_CKB_BROADCAST:-false}"
FIBER_RECEIVER_RPC_URL="${FIBER_RECEIVER_RPC_URL:-}"
FIBER_RECEIVER_RPC_TOKEN="${FIBER_RECEIVER_RPC_TOKEN:-}"

if [[ "$NON_INTERACTIVE" != "1" ]]; then
  [[ -z "$CKB_PRIVATE_KEY" ]] && CKB_PRIVATE_KEY="$(ask 'CKB Testnet private key (optional, 0x + 64 hex)')"
  [[ -z "$FIBER_RECEIVER_RPC_URL" ]] && FIBER_RECEIVER_RPC_URL="$(ask 'Receiver FNN RPC URL (optional)')"
  if [[ -n "$FIBER_RECEIVER_RPC_URL" && -z "$FIBER_RECEIVER_RPC_TOKEN" ]]; then
    FIBER_RECEIVER_RPC_TOKEN="$(ask 'Receiver FNN RPC token (optional)')"
  fi
fi

if [[ -n "$CKB_PRIVATE_KEY" && ! "$CKB_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: CKB_PRIVATE_KEY must be 0x followed by 64 hex characters" >&2
  exit 2
fi
if [[ -n "$FIBER_RECEIVER_RPC_URL" && ! "$FIBER_RECEIVER_RPC_URL" =~ ^https?:// ]]; then
  echo "ERROR: FIBER_RECEIVER_RPC_URL must be http(s)://" >&2
  exit 2
fi

# CKB broadcast stays off unless explicitly enabled after the Testnet key is funded.
[[ "$DEMO_ALLOW_CKB_BROADCAST" == "true" || "$DEMO_ALLOW_CKB_BROADCAST" == "false" ]] || {
  echo "ERROR: DEMO_ALLOW_CKB_BROADCAST must be true or false" >&2
  exit 2
}

dotenv_quote() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }
{
  printf 'DEMO_MASTER_SECRET=%s\n' "$(dotenv_quote "$DEMO_MASTER_SECRET")"
  printf 'DEMO_RATE_LIMIT_PER_MINUTE=60\n'
  printf 'DEMO_STATE_MAX_BYTES=4194304\n'
  printf 'CKB_RPC_URL=%s\n' "$(dotenv_quote "$CKB_RPC_URL")"
  printf 'CKB_PRIVATE_KEY=%s\n' "$(dotenv_quote "$CKB_PRIVATE_KEY")"
  printf 'DEMO_ALLOW_CKB_BROADCAST=%s\n' "$DEMO_ALLOW_CKB_BROADCAST"
  printf 'CKB_ANCHOR_CAPACITY_CKB=220\n'
  printf 'FIBER_RECEIVER_RPC_URL=%s\n' "$(dotenv_quote "$FIBER_RECEIVER_RPC_URL")"
  printf 'FIBER_RECEIVER_RPC_TOKEN=%s\n' "$(dotenv_quote "$FIBER_RECEIVER_RPC_TOKEN")"
  printf 'NODE_ENV=production\n'
} > "$OUT"
chmod 600 "$OUT"

echo "Created $OUT (mode 600)."
echo "No database is required. Vercel demo state uses ephemeral JSON in /tmp."
echo "CKB broadcast is disabled by default even when CKB_PRIVATE_KEY is configured."
