import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Native bridges need a file; callers receive its bytes before this scope ends. */
export async function withCaptureFile<T>(capture: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ludens-capture-"));
  try { return await capture(join(directory, "capture.png")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
