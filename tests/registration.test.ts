import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import registration from "../src/index.ts";

const root = join(import.meta.dir, "..");
const launcher = ["bash", join(root, "emulator/launch.sh")];
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("RSA_RYUBING_") && !["XDG_CACHE_HOME", "DOTNET_DefaultStackSize", "RSA_BRIDGE_PORT"].includes(key)));

test("package registration resolves the emulator executable and preserves its app for background startup", async () => {
  expect(registration).toMatchObject({ id: "ryubing", transport: "bridge", defaultPort: 47663,
    needsGame: true, fallbackVersion: "1.3.351-rsa.3" });
  expect(registration.launchCommand).toEqual([join(registration.launchEnv.RSA_RYUBING_APP, "Contents/MacOS/Ryujinx")]);
  for (const [overrides, expected] of [
    [{ RSA_RYUBING_APP: "/tmp/custom switch/Ryubing.app" }, "/tmp/custom switch/Ryubing.app"],
    [{ RSA_RYUBING_BUILD: "/tmp/custom build" }, "/tmp/custom build/Ryujinx.app"],
    [{ XDG_CACHE_HOME: "/tmp/custom cache" }, "/tmp/custom cache/ludens/ryubing/build/Ryujinx.app"],
  ] as const) {
    const child = Bun.spawn([process.execPath, "-e", "import driver from './src/index.ts'; console.log(JSON.stringify({env:driver.launchEnv,command:driver.launchCommand}));"],
      { cwd: root, env: { ...cleanEnv(), ...overrides }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(JSON.parse(output)).toEqual({ env: { DOTNET_DefaultStackSize: "200000", RSA_RYUBING_APP: expected },
      command: [join(expected, "Contents/MacOS/Ryujinx")] });
  }
});

test("launcher honors explicit application, port and argv outside the package directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-switch-launch-"));
  try {
    const app = join(directory, "custom app/Ryubing.app");
    const executable = join(app, "Contents/MacOS/Ryujinx");
    await mkdir(dirname(executable), { recursive: true });
    // A process fixture, not an emulator: only prints the received configuration.
    await writeFile(executable, '#!/bin/bash\nprintf "%s\\n" "$RSA_BRIDGE_PORT" "$DOTNET_DefaultStackSize" "$@"\n');
    await chmod(executable, 0o755);
    const child = Bun.spawn([...launcher, "game with spaces.nsp", "--example=$literal"], {
      cwd: directory, env: { ...cleanEnv(), RSA_RYUBING_APP: app, RSA_BRIDGE_PORT: "47763" }, stdout: "pipe", stderr: "pipe",
    });
    expect(await new Response(child.stdout).text()).toBe("47763\n200000\ngame with spaces.nsp\n--example=$literal\n");
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    const missing = Bun.spawn(launcher, { cwd: directory,
      env: { ...cleanEnv(), RSA_RYUBING_APP: join(directory, "missing.app") }, stdout: "pipe", stderr: "pipe" });
    expect(await missing.exited).toBe(1);
    expect(await new Response(missing.stderr).text()).toContain("Patched Ryubing not found");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
