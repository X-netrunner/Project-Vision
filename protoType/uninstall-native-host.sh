#!/usr/bin/env bash
set -euo pipefail
HOST_NAME="com.projectvision.local_server"
if [[ "$(uname -s)" == "Darwin" ]]; then
  HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$(uname -s)" == "Linux" ]]; then
  HOST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome/NativeMessagingHosts"
else
  echo "Use uninstall-native-host.ps1 on Windows." >&2
  exit 1
fi
rm -f "$HOST_DIR/$HOST_NAME.json"
rm -rf "$HOME/.project-vision/native-host"
echo "Project-Vision native host unregistered."
