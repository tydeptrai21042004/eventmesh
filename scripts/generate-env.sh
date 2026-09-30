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
DEMO_RATE_LIMIT_PER_MINUTE="${DEMO_RATE_LIMIT_PER_MINUTE:-60}"
EVENTMESH_PUBLIC_ORIGIN="${EVENTMESH_PUBLIC_ORIGIN:-}"
EVENTMESH_TESTNET_MODE="${EVENTMESH_TESTNET_MODE:-false}"
EVENTMESH_TESTNET_ACCESS_KEY="${EVENTMESH_TESTNET_ACCESS_KEY:-}"
TESTNET_RATE_LIMIT_PER_MINUTE="${TESTNET_RATE_LIMIT_PER_MINUTE:-30}"
OPERATOR_A_PRIVATE_KEY="${OPERATOR_A_PRIVATE_KEY:-}"
OPERATOR_B_PRIVATE_KEY="${OPERATOR_B_PRIVATE_KEY:-}"
CKB_RPC_URL="${CKB_RPC_URL:-$DEFAULT_CKB_RPC}"
CKB_PRIVATE_KEY="${CKB_PRIVATE_KEY:-}"
TESTNET_ALLOW_CKB_BROADCAST="${TESTNET_ALLOW_CKB_BROADCAST:-false}"
FIBER_RECEIVER_RPC_URL="${FIBER_RECEIVER_RPC_URL:-}"
FIBER_RECEIVER_RPC_TOKEN="${FIBER_RECEIVER_RPC_TOKEN:-}"

if [[ "$EVENTMESH_TESTNET_MODE" == "true" && -z "$EVENTMESH_TESTNET_ACCESS_KEY" ]]; then
  EVENTMESH_TESTNET_ACCESS_KEY="$(random_secret)"
fi

if [[ "$NON_INTERACTIVE" != "1" ]]; then
  EVENTMESH_TESTNET_MODE="$(ask 'Enable Real / Testnet workspace? (true/false)' "$EVENTMESH_TESTNET_MODE")"
  EVENTMESH_PUBLIC_ORIGIN="$(ask 'Pinned public origin (optional, e.g. https://app.vercel.app)' "$EVENTMESH_PUBLIC_ORIGIN")"
  if [[ "$EVENTMESH_TESTNET_MODE" == "true" ]]; then
    [[ -z "$EVENTMESH_TESTNET_ACCESS_KEY" ]] && EVENTMESH_TESTNET_ACCESS_KEY="$(random_secret)"
    [[ -z "$OPERATOR_A_PRIVATE_KEY" ]] && OPERATOR_A_PRIVATE_KEY="$(ask 'Operator A Testnet private key (0x + 64 hex)')"
    [[ -z "$OPERATOR_B_PRIVATE_KEY" ]] && OPERATOR_B_PRIVATE_KEY="$(ask 'Operator B Testnet private key (0x + 64 hex)')"
    [[ -z "$CKB_PRIVATE_KEY" ]] && CKB_PRIVATE_KEY="$(ask 'CKB Testnet anchor private key (optional, 0x + 64 hex)')"
    [[ -z "$FIBER_RECEIVER_RPC_URL" ]] && FIBER_RECEIVER_RPC_URL="$(ask 'Receiver FNN RPC URL (optional)')"
    if [[ -n "$FIBER_RECEIVER_RPC_URL" && -z "$FIBER_RECEIVER_RPC_TOKEN" ]]; then
      FIBER_RECEIVER_RPC_TOKEN="$(ask 'Receiver FNN RPC token (optional)')"
    fi
  fi
fi

[[ "$EVENTMESH_TESTNET_MODE" == "true" || "$EVENTMESH_TESTNET_MODE" == "false" ]] || {
  echo "ERROR: EVENTMESH_TESTNET_MODE must be true or false" >&2; exit 2;
}
[[ "$TESTNET_ALLOW_CKB_BROADCAST" == "true" || "$TESTNET_ALLOW_CKB_BROADCAST" == "false" ]] || {
  echo "ERROR: TESTNET_ALLOW_CKB_BROADCAST must be true or false" >&2; exit 2;
}

validate_key() {
  local name="$1" value="$2"
  if [[ -n "$value" && ! "$value" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    echo "ERROR: $name must be 0x followed by 64 hex characters" >&2
    exit 2
  fi
}
validate_key OPERATOR_A_PRIVATE_KEY "$OPERATOR_A_PRIVATE_KEY"
validate_key OPERATOR_B_PRIVATE_KEY "$OPERATOR_B_PRIVATE_KEY"
validate_key CKB_PRIVATE_KEY "$CKB_PRIVATE_KEY"

if [[ "$EVENTMESH_TESTNET_MODE" == "true" ]]; then
  [[ -n "$OPERATOR_A_PRIVATE_KEY" && -n "$OPERATOR_B_PRIVATE_KEY" ]] || {
    echo "ERROR: Testnet mode requires OPERATOR_A_PRIVATE_KEY and OPERATOR_B_PRIVATE_KEY" >&2; exit 2;
  }
  [[ ${#EVENTMESH_TESTNET_ACCESS_KEY} -ge 32 ]] || {
    echo "ERROR: EVENTMESH_TESTNET_ACCESS_KEY must be at least 32 characters" >&2; exit 2;
  }
fi

if [[ -n "$EVENTMESH_PUBLIC_ORIGIN" && ! "$EVENTMESH_PUBLIC_ORIGIN" =~ ^https?:// ]]; then
  echo "ERROR: EVENTMESH_PUBLIC_ORIGIN must be http(s)://" >&2; exit 2
fi
if [[ -n "$FIBER_RECEIVER_RPC_URL" && ! "$FIBER_RECEIVER_RPC_URL" =~ ^https?:// ]]; then
  echo "ERROR: FIBER_RECEIVER_RPC_URL must be http(s)://" >&2; exit 2
fi
if [[ "$TESTNET_ALLOW_CKB_BROADCAST" == "true" && -z "$CKB_PRIVATE_KEY" ]]; then
  echo "ERROR: TESTNET_ALLOW_CKB_BROADCAST=true requires CKB_PRIVATE_KEY" >&2; exit 2
fi

dotenv_quote() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }
{
  printf 'DEMO_MASTER_SECRET=%s\n' "$(dotenv_quote "$DEMO_MASTER_SECRET")"
  printf 'DEMO_RATE_LIMIT_PER_MINUTE=%s\n' "$DEMO_RATE_LIMIT_PER_MINUTE"
  printf 'DEMO_STATE_MAX_BYTES=4194304\n'
  printf 'EVENTMESH_PUBLIC_ORIGIN=%s\n' "$(dotenv_quote "$EVENTMESH_PUBLIC_ORIGIN")"
  printf 'EVENTMESH_TESTNET_MODE=%s\n' "$EVENTMESH_TESTNET_MODE"
  printf 'EVENTMESH_TESTNET_ACCESS_KEY=%s\n' "$(dotenv_quote "$EVENTMESH_TESTNET_ACCESS_KEY")"
  printf 'TESTNET_RATE_LIMIT_PER_MINUTE=%s\n' "$TESTNET_RATE_LIMIT_PER_MINUTE"
  printf 'OPERATOR_A_PRIVATE_KEY=%s\n' "$(dotenv_quote "$OPERATOR_A_PRIVATE_KEY")"
  printf 'OPERATOR_B_PRIVATE_KEY=%s\n' "$(dotenv_quote "$OPERATOR_B_PRIVATE_KEY")"
  printf 'CKB_RPC_URL=%s\n' "$(dotenv_quote "$CKB_RPC_URL")"
  printf 'CKB_PRIVATE_KEY=%s\n' "$(dotenv_quote "$CKB_PRIVATE_KEY")"
  printf 'TESTNET_ALLOW_CKB_BROADCAST=%s\n' "$TESTNET_ALLOW_CKB_BROADCAST"
  printf 'CKB_ANCHOR_CAPACITY_CKB=220\n'
  printf 'FIBER_RECEIVER_RPC_URL=%s\n' "$(dotenv_quote "$FIBER_RECEIVER_RPC_URL")"
  printf 'FIBER_RECEIVER_RPC_TOKEN=%s\n' "$(dotenv_quote "$FIBER_RECEIVER_RPC_TOKEN")"
  printf 'NODE_ENV=production\n'
} > "$OUT"
chmod 600 "$OUT"

echo "Created $OUT (mode 600)."
echo "Demo remains database-free. Real / Testnet mode is explicit and access-controlled."
echo "CKB broadcast is disabled unless TESTNET_ALLOW_CKB_BROADCAST=true and CKB_PRIVATE_KEY is configured."
