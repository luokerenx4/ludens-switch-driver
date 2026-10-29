#!/bin/bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/config.sh"
# RSA_RYUBING_APP selects an existing app for launch only. Builds never install
# over that app; their only output bundle is inside the explicit build directory.
app="$build_dir/Ryujinx.app"

# Install a .NET 10 SDK separately, or point RSA_DOTNET at an existing dotnet.
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "The packaged emulator build currently supports macOS arm64 only." >&2
  exit 1
fi
if ! command -v "$sdk" >/dev/null 2>&1; then
  echo "Install a .NET 10 SDK or set RSA_DOTNET to its dotnet executable." >&2
  exit 1
fi
mkdir -p "$cache_dir" "$(dirname "$source_dir")" "$publish_dir" "$build_dir"
if [ ! -d "$source_dir/.git" ]; then
  git clone --depth 1 --branch "$tag" "$upstream" "$source_dir"
fi
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]; then
  echo "Source must be pinned to $revision; no checkout/reset was attempted." >&2
  exit 1
fi
if git -C "$source_dir" apply --check "$script_dir/ryubing.patch" 2>/dev/null; then
  git -C "$source_dir" apply "$script_dir/ryubing.patch"
else
  git -C "$source_dir" apply --reverse --check "$script_dir/ryubing.patch"
fi
cp "$script_dir/RsaBridge.cs" "$source_dir/src/Ryujinx/Systems/RsaBridge.cs"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
"$sdk" publish "$source_dir/src/Ryujinx/Ryujinx.csproj" -c Release -r osx-arm64 \
  --self-contained true -m:2 -p:Version=1.3.351-rsa.3 -p:SourceRevisionId=475615f04 \
  -o "$publish_dir"

cd "$source_dir/distribution/macos"
./create_app_bundle.sh "$publish_dir" "$build_dir" "$PWD/entitlements.xml"
python3 - "$app/Contents/Info.plist" <<'PY'
import plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as file:
    info = plistlib.load(file)
info.update(CFBundleIdentifier='dev.ludens.Ryubing', CFBundleName='Ryubing',
            CFBundleDisplayName='Ryubing',
            CFBundleShortVersionString='1.3.351', CFBundleVersion='1.3.351',
            CFBundleLongVersionString='1.3.351-rsa.3-475615f04')
with open(path, 'wb') as file:
    plistlib.dump(info, file)
PY
codesign --entitlements "$PWD/entitlements.xml" --force --sign - "$app"
codesign --verify --deep --strict "$app"
echo "Built $app"
