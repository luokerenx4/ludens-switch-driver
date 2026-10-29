#!/bin/bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/config.sh"
executable="$app/Contents/MacOS/Ryujinx"
if [ ! -x "$executable" ]; then
  echo "Patched Ryubing not found: $executable. Run emulator:build or set RSA_RYUBING_APP." >&2
  exit 1
fi
export RSA_BRIDGE_PORT="${RSA_BRIDGE_PORT:-47663}"
export DOTNET_DefaultStackSize="${DOTNET_DefaultStackSize:-200000}"
exec "$executable" "$@"
