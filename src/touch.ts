import type { Clock, Controller } from "./contracts.ts";
import type { Bridge } from "./bridge.ts";
import { structuredResult, toolExecution } from "./tool-contract.ts";
import { NO_ARGUMENTS } from "./schema.ts";

/** A single native contact. Gesture composition and screen mapping belong to the caller. */
export async function createTouchControllers(options: {
  bridge: Pick<Bridge, "request">;
  clock: Clock;
  acquire(epoch: string): Promise<void>;
  release(epoch: string): Promise<void>;
  owns(epoch: string): boolean;
}): Promise<Controller[]> {
  const { bridge, clock } = options;
  const range = (await bridge.request("TOUCH_INFO", [], crypto.randomUUID())).map(Number);
  const [minX, minY, maxX, maxY] = range;
  if (range.length !== 4 || !range.every(Number.isSafeInteger) || minX > maxX || minY > maxY) {
    throw new Error("Invalid native touch coordinate range");
  }
  const coordinates = { type: "object" as const, properties: {
    x: { type: "integer", minimum: minX, maximum: maxX },
    y: { type: "integer", minimum: minY, maximum: maxY },
  }, required: ["x", "y"], additionalProperties: false };
  const description = `Single contact in native device coordinates: integer x=${minX}..${maxX}, y=${minY}..${maxY}, inclusive. Origin is top-left; +x right, +y down. No display scaling or screenshot coordinate conversion. Completion means the device sampled the new state; the contact persists between calls. Cancelling a pending command or releasing control lifts it.`;
  return (["down", "move", "up"] as const).map(command => ({
    tool: { name: `touch.${command}`,
      description: `${command === "down" ? "Start a contact; requires no existing contact." : command === "move" ? "Move the existing contact; requires a contact." : "End the contact (already up is allowed)."} ${description}`,
      inputSchema: command === "up" ? NO_ARGUMENTS : coordinates, annotations: { readOnlyHint: false } },
    requiresControl: true, acquire: options.acquire, release: options.release,
    async execute(args, { epoch, signal }) {
      signal.throwIfAborted();
      if (!epoch || !options.owns(epoch)) throw new Error("STALE_EPOCH");
      const values = command === "up" ? [] : [args.x, args.y].map((coordinate, axis) => {
        const min = axis === 0 ? minX : minY;
        const max = axis === 0 ? maxX : maxY;
        if (typeof coordinate !== "number" || !Number.isSafeInteger(coordinate) || coordinate < min || coordinate > max) {
          throw new Error(`${axis === 0 ? "x" : "y"} must be an integer from ${min} to ${max}`);
        }
        return coordinate;
      });
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      signal.throwIfAborted();
      const pending = bridge.request(`TOUCH_${command.toUpperCase()}`, [epoch, ...values], id);
      const abort = () => { void bridge.request("STOP", [epoch, id], crypto.randomUUID()).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const [outcome] = await pending;
        if (outcome !== "completed" && outcome !== "interrupted") throw new Error(`Unexpected touch outcome: ${outcome}`);
        const result = structuredResult({ status: outcome });
        if (outcome === "interrupted") result.isError = true;
        return toolExecution(clock, requestedAtMs, result, { id, status: outcome, exitCode: outcome === "completed" ? 0 : 130 });
      } finally { signal.removeEventListener("abort", abort); }
    },
  }));
}
