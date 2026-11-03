#!/bin/bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/config.sh"
if [ ! -d "$source_dir/.git" ]; then
  echo "Set RSA_RYUBING_SOURCE to an existing checkout of $revision; this check never downloads source." >&2
  exit 1
fi
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]; then
  echo "Source must be pinned to $revision." >&2
  exit 1
fi
if git -C "$source_dir" apply --check "$script_dir/ryubing.patch" 2>/dev/null; then
  echo "Patch applies cleanly to $revision."
else
  git -C "$source_dir" apply --reverse --check "$script_dir/ryubing.patch"
  echo "Patch is already applied to $revision and can be reversed cleanly."
fi
