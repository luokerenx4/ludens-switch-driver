#!/bin/bash
# Sourced by package scripts. Downloads/builds live outside the package checkout.
if [ -n "${XDG_CACHE_HOME:-}" ]; then
  cache_base="$XDG_CACHE_HOME"
elif [ "$(uname -s)" = Darwin ]; then
  cache_base="$HOME/Library/Caches"
else
  cache_base="$HOME/.cache"
fi
cache_dir="${RSA_RYUBING_CACHE:-$cache_base/ludens/ryubing}"
source_dir="${RSA_RYUBING_SOURCE:-$cache_dir/source}"
build_dir="${RSA_RYUBING_BUILD:-$cache_dir/build}"
publish_dir="${RSA_RYUBING_PUBLISH:-$cache_dir/publish}"
app="${RSA_RYUBING_APP:-$build_dir/Ryujinx.app}"
revision=475615f0431b4995b03c930c5089d20f6f3570e0
upstream=https://starforgejo.dev/archive/Ryubing.git
tag=Canary-1.3.351
sdk="${RSA_DOTNET:-dotnet}"
for configured_path in "$cache_dir" "$source_dir" "$build_dir" "$publish_dir" "$app"; do
  if [[ "$configured_path" != /* ]]; then
    echo "Ryubing cache/source/build/publish/app paths must be absolute: $configured_path" >&2
    return 1
  fi
done
