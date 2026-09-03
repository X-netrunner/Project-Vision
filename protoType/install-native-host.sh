#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.projectvision.local_server"
PROTO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${2:-$(cd "$PROTO_DIR/.." && pwd)}"
EXTENSION_ID="${1:-}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo "Usage: $0 EXTENSION_ID [PROJECT_ROOT]" >&2
  exit 2
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$(uname -s)" == "Linux" ]]; then
  HOST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome/NativeMessagingHosts"
else
  echo "This installer supports macOS and Linux. Use install-native-host.ps1 on Windows." >&2
  exit 1
fi

PYTHON=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON="$(command -v "$candidate")"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "Python 3 was not found on PATH." >&2
  exit 1
fi

INSTALL_DIR="$HOME/.project-vision/native-host"
mkdir -p "$INSTALL_DIR" "$HOST_DIR"
HOST_PY="$INSTALL_DIR/native_host.py"
WRAPPER="$INSTALL_DIR/native_host.sh"
MANIFEST="$HOST_DIR/$HOST_NAME.json"

cp "$PROTO_DIR/native_host.py" "$HOST_PY"
chmod 700 "$HOST_PY"

cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
export PROJECT_VISION_ROOT=$(printf '%q' "$PROJECT_ROOT")
export PROJECT_VISION_APP=$(printf '%q' "$PROJECT_ROOT/varun/app.py")
exec $(printf '%q' "$PYTHON") -B $(printf '%q' "$HOST_PY") "\$@"
EOF
chmod 700 "$WRAPPER"

python3 - "$MANIFEST" "$HOST_NAME" "$EXTENSION_ID" "$WRAPPER" <<'PY'
import json, sys
manifest_path, name, extension_id, wrapper = sys.argv[1:]
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump({
        "name": name,
        "description": "Project-Vision local server launcher",
        "path": wrapper,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }, f, indent=2)
    f.write("\n")
PY

chmod 600 "$MANIFEST"
echo "Project-Vision native host registered."
echo "Extension ID: $EXTENSION_ID"
echo "Project root: $PROJECT_ROOT"
echo "Python:       $PYTHON"
echo "Host:         $MANIFEST"
echo "Restart Chrome, then reload the extension."
