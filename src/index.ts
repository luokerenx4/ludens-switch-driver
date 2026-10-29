import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Clock } from "./contracts.ts";
import type { DriverProvider } from "./registration.ts";
import { createSwitchProvider } from "./provider.ts";

export { createSwitchProvider };
export type { DriverProvider };

const cacheBase = process.env.XDG_CACHE_HOME || (process.platform === "darwin"
  ? join(homedir(), "Library/Caches") : join(homedir(), ".cache"));
const cache = process.env.RSA_RYUBING_CACHE || join(cacheBase, "ludens/ryubing");
const build = process.env.RSA_RYUBING_BUILD || join(cache, "build");
// launchd does not inherit the shell environment. Freeze the chosen application
// in the manifest so discovery/startup carry the same path to the background process.
const app = resolve(process.env.RSA_RYUBING_APP || join(build, "Ryujinx.app"));

/** Importing the package describes the driver; it never starts an emulator. */
const registration = {
  id: "ryubing",
  transport: "bridge",
  defaultPort: 47663,
  needsGame: true,
  fallbackVersion: "1.3.351-rsa.3",
  launchHint: "Build the patched Ryubing with emulator:build, or set RSA_RYUBING_APP to an existing patched .app; select the desired game.",
  launchCommand: [join(app, "Contents/MacOS/Ryujinx")],
  launchEnv: { DOTNET_DefaultStackSize: "200000", RSA_RYUBING_APP: app },
  load: async (options: { port?: number; clock: Clock }): Promise<DriverProvider> =>
    createSwitchProvider({ port: options.port ?? 47663, clock: options.clock }),
};

export default registration;
