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

DATABASE_URL="${DATABASE_URL:-}"
if [[ -z "$DATABASE_URL" ]]; then
  DATABASE_URL="$(ask 'Neon pooled DATABASE_URL')"
fi
if [[ ! "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
  echo "ERROR: DATABASE_URL must start with postgres:// or postgresql://" >&2
  exit 2
fi

DEMO_MASTER_SECRET="${DEMO_MASTER_SECRET:-$(random_secret)}"
CKB_RPC_URL="${CKB_RPC_URL:-$DEFAULT_CKB_RPC}"
CKB_PRIVATE_KEY="${CKB_PRIVATE_KEY:-}"
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

dotenv_quote() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }
{
  printf 'DATABASE_URL=%s\n' "$(dotenv_quote "$DATABASE_URL")"
  printf 'DEMO_MASTER_SECRET=%s\n' "$(dotenv_quote "$DEMO_MASTER_SECRET")"
  printf 'DEMO_RATE_LIMIT_PER_MINUTE=60\n'
  printf 'CKB_RPC_URL=%s\n' "$(dotenv_quote "$CKB_RPC_URL")"
  printf 'CKB_PRIVATE_KEY=%s\n' "$(dotenv_quote "$CKB_PRIVATE_KEY")"
  printf 'CKB_ANCHOR_CAPACITY_CKB=220\n'
  printf 'FIBER_RECEIVER_RPC_URL=%s\n' "$(dotenv_quote "$FIBER_RECEIVER_RPC_URL")"
  printf 'FIBER_RECEIVER_RPC_TOKEN=%s\n' "$(dotenv_quote "$FIBER_RECEIVER_RPC_TOKEN")"
  printf 'NODE_ENV=production\n'
} > "$OUT"
chmod 600 "$OUT"

echo "Created $OUT (mode 600)."
echo "CKB RPC defaults to Fiber/CKB Testnet; CKB anchoring remains disabled until CKB_PRIVATE_KEY is set."
