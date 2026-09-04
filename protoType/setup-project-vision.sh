#!/usr/bin/env bash
set -euo pipefail
PROTO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$PROTO_DIR/install-native-host.sh" "$@"
