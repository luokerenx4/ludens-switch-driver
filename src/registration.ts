// Minimal runtime shape a community driver must satisfy. Mirrors the host's
// DriverProvider contract; kept local so this package has no host dependency.
import type { Capabilities } from "./contracts.ts";

export interface DriverProvider {
  capabilities: Capabilities;
  version?: string;
  onDisconnect(handler: (error: Error) => void): void;
  close(): void | Promise<void>;
}
