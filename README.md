# @ludens-community/driver-ryubing

Optional Nintendo Switch driver for Ludens Baseware. This package owns the
Ryubing provider, its native C# bridge, upstream patch and macOS build/launch
scripts. It has no runtime import from the Ludens host repository.

The default export is a `DriverRegistration` with ID `ryubing`, bridge transport,
default port `47663`, and an explicitly resolved emulator launch command. Importing it does not
connect to a device or start an emulator. The emulator itself, games, firmware,
keys and saves are not included.

## Install in Ludens

Use a reviewed commit as `<revision>` below. Installing/discovering the driver
does not build or install the emulator.

```sh
baseware driver discover --package 'github:luokerenx4/ludens-switch-driver#<revision>'
rsa init --driver ryubing \
  --driver-package 'github:luokerenx4/ludens-switch-driver#<revision>' \
  --game /absolute/path/to/game.nsp
rsa up --dry-run
rsa up
```

For local development, use `--driver-package file:/absolute/path/to/ludens-switch-driver`.
Omit `--game` to connect to an already prepared patched emulator instead of
asking RSA to launch one. Each bridge accepts a single Baseware connection.

An existing patched application can be selected without copying it:

```sh
RSA_RYUBING_APP=/Applications/Ryubing.app rsa up --dry-run
RSA_RYUBING_APP=/Applications/Ryubing.app rsa up
```

The registration resolves that path and includes it in `launchEnv`, so the
background launcher receives it even though launchd does not inherit arbitrary
shell environment variables. Set the same override when discovering or starting
the driver; changing it does not move an already running emulator.

## Build the patched emulator

The build is pinned to [Ryubing](https://starforgejo.dev/archive/Ryubing), tag
`Canary-1.3.351`, commit `475615f0431b4995b03c930c5089d20f6f3570e0`. The bridge
handshake and local version remain `ryubing-rsa-3` and `1.3.351-rsa.3`.

The supplied build supports Apple Silicon macOS. Prepare Git, a .NET 10 SDK,
Python 3 and Xcode Command Line Tools (including `codesign`). The source project
previously used SDK `10.0.402`; this extraction did not rebuild it.

```sh
bun install --frozen-lockfile
RSA_DOTNET=/absolute/path/to/dotnet bun run emulator:build
```

`emulator/build.sh` checks the pinned commit, applies `ryubing.patch`, injects
`RsaBridge.cs`, publishes the app and signs it ad hoc with the upstream JIT
entitlements. The patch also replaces the LibHac NuGet feed with
`https://nuget.ryulynx.org/v3/index.json`. Building downloads upstream source and
NuGet dependencies. An existing source directory at a different commit is
rejected; the script never resets or changes its branch.

Build state lives outside the package checkout. Defaults use
`$XDG_CACHE_HOME/ludens/ryubing` when set, otherwise
`~/Library/Caches/ludens/ryubing` on macOS (`~/.cache/ludens/ryubing` elsewhere).
All configured directory/application paths must be absolute.

| Variable | Meaning / default |
| --- | --- |
| `RSA_DOTNET` | SDK executable; `dotnet` on `PATH` |
| `RSA_RYUBING_CACHE` | Override the cache root |
| `RSA_RYUBING_SOURCE` | Pinned source checkout; `<cache>/source` |
| `RSA_RYUBING_PUBLISH` | .NET publish output; `<cache>/publish` |
| `RSA_RYUBING_BUILD` | Application bundle output; `<cache>/build` |
| `RSA_RYUBING_APP` | App to launch only; `<build>/Ryujinx.app` |
| `RSA_BRIDGE_PORT` | Direct launch bridge port; `47663` |

The default build does not install into `/Applications`. If manually installing,
exit the old emulator first, then copy the generated `Ryujinx.app` as
`/Applications/Ryubing.app`. Finder displays **Ryubing**; the executable and
process name remain **Ryujinx**. Builds always write to
`$RSA_RYUBING_BUILD/Ryujinx.app` (or its default); setting `RSA_RYUBING_APP` never
changes the build destination or installs over an existing application.

```sh
RSA_RYUBING_APP=/Applications/Ryubing.app bun run emulator:launch /path/to/game.nsp
```

The launch script injects `RSA_BRIDGE_PORT` and the required
`DOTNET_DefaultStackSize=200000`; launching the app directly from Finder does not
enable the bridge. It forwards all arguments without shell re-parsing. The
bridge starts only after a game is loaded. Firmware, keys, settings and saves
use the emulator's existing data directory: do not run two instances sharing
that directory concurrently. A distinct bridge port alone does not isolate data.

## Device capabilities

- `pad.play/state/status/wait/cancel/release`: player-one button and analog-stick
  timelines. X positive is right; Y positive is up. Ownership controls action
  lifetime, while cancelling a waiter leaves the action running.
- `screen.capture`: the next presented game framebuffer, or the visible Switch
  system text-entry dialog. It does not capture the desktop or read game memory.
  Optional `delayMs` is a fixed delay, not a scene-settlement detector.
- `touch.down/move/up`: native `x=0..1279`, `y=0..719` touch coordinates.
- `keyboard.type/press`: only the visible Switch software-keyboard dialog;
  supported keys are `ENTER`, `ESCAPE`, `BACKSPACE`, `CTRL+A`. Missing dialogs
  fail with `NO_TEXT_INPUT`. Enter respects the dialog's length/input constraints.

The native patch suppresses human pad/touch input while owned and restores it
when control ends. It also supports text-dialog input/capture while game-frame
presentation is paused. These are device operations, not game strategies or
automatic save/load logic.

## Development and verification

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run scripts:check
RSA_RYUBING_SOURCE=/absolute/path/to/pinned/source bun run emulator:patch-check
```

`test` runs the migrated provider/encoding, screenshot cleanup, touch and
timeline tests, plus package-launch and pad-lifecycle regression tests. Network
tests use temporary loopback fake bridges and launch tests use a temporary
process fixture. They do not connect to a real emulator or send game input.

`emulator:patch-check` is read-only: it validates the source commit and checks
that the patch either applies or is already applied and reverses cleanly. It
does not fetch, modify source, compile, install or launch an emulator.

Extraction verification covers TypeScript type checking, the offline tests,
shell syntax, and reverse-apply validation against the pinned checkout. The
native bridge and upstream patch were copied unchanged from the host at
`804c336`. No full emulator build or real-device smoke test was performed for
this standalone package; fake-bridge success is not evidence of renderer,
keyboard UI, game compatibility or application-signing success. Host-coupled
Switch runtime tests remain in the Ludens repository and require explicit
external-driver configuration and a safe prepared game screen.

The local `bridge`, `pad`, `touch`, `timeline`, `schema`, `capture`, contracts and
tool-contract kit files were extracted from Baseware. Contracts include their
own video-reference shape, with no imports into the host's shared directories.
