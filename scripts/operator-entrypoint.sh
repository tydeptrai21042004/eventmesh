#!/bin/sh
set -eu

# Seamless migration from earlier EventMesh operator images which ran as root:
# existing Docker named volumes may still contain root-owned 0700 directories.
if [ "$(id -u)" = "0" ]; then
  data_dir="${DATA_DIR:-/data}"
  case "$data_dir" in
    /data|/data/*) ;;
    *) echo "DATA_DIR must be within /data in the operator image" >&2; exit 1 ;;
  esac
  mkdir -p "$data_dir"
  chown -R node:node /data
  exec gosu node "$@"
fi
exec "$@"
