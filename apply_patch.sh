#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
cd "$ROOT"
patch -p1 < "${2:-EventMesh_CKB_Hardening.patch}"
echo "EventMesh CKB/Fiber hardening patch applied."
