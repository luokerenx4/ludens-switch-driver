import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Capabilities, Clock, Controller } from "./contracts.ts";
import { Bridge } from "./bridge.ts";
import { withCaptureFile } from "./capture.ts";
import { structuredResult, toolExecution } from "./tool-contract.ts";
import { createPadPlayer } from "./pad.ts";
import { compileTimeline } from "./timeline.ts";
import { createTouchControllers } from "./touch.ts";
import { MAX_CAPTURE_DELAY_MS, MIN_POLL_DURATION_MS, padTools, POLLED_TIMING } from "./schema.ts";

// Order matches the physical bits in Ryubing's ControllerKeys, not game actions.
export const BUTTONS = ["A", "B", "X", "Y", "LSTICK", "RSTICK", "L", "R", "ZL", "ZR", "PLUS", "MINUS", "LEFT", "UP", "RIGHT", "DOWN"];
export const AXES = ["LX", "LY", "RX", "RY"];
const KEYBOARD_KEYS = ["ENTER", "ESCAPE", "BACKSPACE", "CTRL+A"];
type Span = { state: Record<string, number>; durationMs: number };

export function encodeSpans(spans: Span[]): string {
  if (!Array.isArray(spans) || !spans.length) throw new Error("Expected a non-empty state sequence");
  let elapsed = 0;
  return spans.map(({ state, durationMs }) => {
    if (!Number.isSafeInteger(durationMs) || durationMs < MIN_POLL_DURATION_MS) throw new Error(`durationMs must be a safe integer >= ${MIN_POLL_DURATION_MS}`);
    elapsed += durationMs;
    if (!Number.isSafeInteger(elapsed)) throw new Error("Sequence duration must be a safe integer");
    if (!state || Array.isArray(state) || typeof state !== "object") throw new Error("state must be an object");
    let mask = 0;
    const axes = [0, 0, 0, 0];
    for (const [key, value] of Object.entries(state)) {
      const button = BUTTONS.indexOf(key);
      const axis = AXES.indexOf(key);
      if (button >= 0 && (value === 0 || value === 1)) mask |= value << button;
      else if (axis >= 0 && Number.isFinite(value) && Math.abs(value) <= 1) axes[axis] = Math.round(value * 32767);
      else throw new Error(`Invalid channel/value: ${key}=${value}`);
    }
    return [mask, ...axes, durationMs].join(":");
  }).join(",");
}

const PAD_DESCRIPTION = "Native controller, player 1. Axes are in [-1,1]; X positive=right, Y positive=up, 0=center.";

export async function createSwitchProvider(options: { port: number; clock: Clock }) {
  const { clock } = options;
  const bridge = await Bridge.open(options.port);
  try {
    const [version] = await bridge.request("HELLO");
    if (version !== "ryubing-rsa-3") throw new Error(`Unexpected bridge: ${version}`);
  } catch (error) { bridge.close(); throw error; }
  const player = createPadPlayer({ bridge, clock,
    encode: inputs => encodeSpans(compileTimeline(inputs, BUTTONS, AXES, MIN_POLL_DURATION_MS)),
    decode: ([elapsedMs, polls]) => ({ elapsedMs: Number(elapsedMs), inputPolls: Number(polls) }),
  });
  let owner: string | undefined;
  async function acquire(epoch: string) {
    if (owner === epoch) return;
    player.reset(); await bridge.request("OWN", [epoch]); owner = epoch;
  }
  async function release(epoch: string) {
    if (owner !== epoch) return;
    owner = undefined;
    await bridge.request("DISOWN", [epoch]);
    await player.settle();
  }
  const screen: Controller = {
    tool: { name: "screen.capture", description: "Capture the next presented game frame, or visible system text-entry dialog, as PNG after an optional fixed delay. Delay does not detect scene settlement. The sample interval includes delay. sourceSequence is a game presentation sequence and is omitted for a dialog; no desktop content.",
      inputSchema: { type: "object", properties: { delayMs: { type: "integer", minimum: 0, maximum: MAX_CAPTURE_DELAY_MS, default: 0 } }, additionalProperties: false },
      annotations: { readOnlyHint: true } }, requiresControl: false, mediaTypes: ["image/png"],
    async execute(args, { signal }) {
      const delayMs = args.delayMs ?? 0;
      if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_CAPTURE_DELAY_MS) {
        throw new Error("delayMs must be an integer from 0 to 2147483647");
      }
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      if (delayMs > 0) await delay(delayMs, undefined, { signal });
      signal.throwIfAborted();
      const { frame, surface, data } = await withCaptureFile(async path => {
        const [frame, surface] = await bridge.request("CAPTURE", [path]);
        return { frame, surface, data: await readFile(path) };
      });
      signal.throwIfAborted();
      const timing = { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() };
      const sequence = surface === "keyboard" ? {} : { sourceSequence: Number(frame) };
      const output = { source: surface === "keyboard" ? "keyboard" : "screen", ...sequence, timing };
      const result = structuredResult(output);
      result.content.unshift({ type: "image", mimeType: "image/png", data: data.toString("base64") });
      return { ...toolExecution(clock, requestedAtMs, result), timing,
        observations: [{ id, controllerId: "screen.capture", mediaType: "image/png", timing, ...sequence, contentIndex: 0 }] };
    },
  };
  const pads: Controller[] = padTools(BUTTONS, AXES, POLLED_TIMING).map(tool => ({
    tool: { ...tool, description: `${PAD_DESCRIPTION} ${tool.description}` }, requiresControl: true, acquire, release,
    async execute(args, context) {
      const { epoch, signal } = context;
      signal.throwIfAborted();
      if (!epoch || owner !== epoch) throw new Error("STALE_EPOCH");
      const command = tool.name.slice("pad.".length);
      if (command !== "state" && command !== "release") return player.execute(command, args, context);
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      let output: Record<string, unknown>;
      if (command === "state") {
        const [mask, lx, ly, rx, ry, actionId] = await bridge.request("STATE", [epoch], id);
        output = { state: { ...Object.fromEntries(BUTTONS.map((key, i) => [key, (Number(mask) >> i) & 1])),
          ...Object.fromEntries(AXES.map((key, i) => [key, Number([lx, ly, rx, ry][i]) / 32767])) }, actionId: actionId === "-" ? null : actionId };
      } else {
        await bridge.request("STOP", [epoch], id);
        await player.settle();
        output = { released: true };
      }
      return toolExecution(clock, requestedAtMs, structuredResult(output), { id, readOnly: command === "state" });
    },
  }));
  const keyboards: Controller[] = (["type", "press"] as const).map((command): Controller => ({
    tool: { name: `keyboard.${command}`,
      description: `${command === "type" ? "Insert text at the caret, replacing selected text." : "Press ENTER (primary button when constraints are satisfied), ESCAPE (close), BACKSPACE, or CTRL+A (select all)."} Only the visible Switch system text-entry dialog is affected; not desktop applications. Fails NO_TEXT_INPUT if absent. Observe screen.capture to see the dialog.`,
      inputSchema: command === "type" ? { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }
        : { type: "object", properties: { key: { type: "string", enum: KEYBOARD_KEYS } }, required: ["key"], additionalProperties: false },
      annotations: { readOnlyHint: false } }, requiresControl: true, acquire, release,
    async execute(args, { epoch, signal }) {
      signal.throwIfAborted();
      if (!epoch || owner !== epoch) throw new Error("STALE_EPOCH");
      const value = command === "type" ? args.text : args.key;
      if (typeof value !== "string") throw new Error(`Missing ${command === "type" ? "text" : "key"}`);
      if (command === "press" && !KEYBOARD_KEYS.includes(value)) throw new Error("Unknown keyboard key");
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      await bridge.request("KEYBOARD", [epoch, command, Buffer.from(value).toString("base64")], id);
      return toolExecution(clock, requestedAtMs, structuredResult({}), { id });
    },
  }));
  let touch: Controller[];
  try { touch = await createTouchControllers({ bridge, clock, acquire, release, owns: epoch => owner === epoch }); }
  catch (error) { bridge.close(); throw error; }
  return {
    capabilities: { controllers: [...pads, ...keyboards, ...touch, screen] } satisfies Capabilities,
    onDisconnect(handler: (error: Error) => void) { bridge.onDisconnect = handler; },
    close() { bridge.close(); },
  };
}
