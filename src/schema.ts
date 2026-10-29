import type { JsonSchema, ToolDefinition } from "./contracts.ts";

export const MIN_POLL_DURATION_MS = 16;
export const MAX_CAPTURE_DELAY_MS = 2_147_483_647;
export const NO_ARGUMENTS = { type: "object" as const, properties: {}, additionalProperties: false };
export const POLLED_TIMING = "Wall-clock milliseconds sampled at input polls, starting at the first input poll. Compiled state changes must be at least 16 ms apart, including initial gaps and the final span; no duration is silently stretched.";

export function padTools(buttons: readonly string[], axes: readonly string[], timing: string): ToolDefinition[] {
  const state: JsonSchema = { type: "object", additionalProperties: false,
    description: "Only the declared channels are affected during this interval; other entries can control other channels.",
    properties: {
      ...Object.fromEntries(buttons.map(key => [key, { type: "integer", enum: [0, 1], description: "0=released, 1=pressed." }])),
      ...Object.fromEntries(axes.map(key => [key, { type: "number", minimum: -1, maximum: 1 }])),
    } };
  const inputs: JsonSchema = { type: "array", minItems: 1,
    description: `Distinct channels may overlap; overlapping intervals on one channel are rejected. Adjacent intervals preserve held controls. All pad controls return to zero at completion or cancellation. atMs + durationMs must be a safe integer. ${timing}`,
    items: { type: "object", properties: { state,
      atMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Offset from actual execution start, in milliseconds." },
      durationMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      required: ["atMs", "durationMs", "state"], additionalProperties: false } };
  const action = (name: string, description: string, readOnlyHint: boolean): ToolDefinition => ({
    name: `pad.${name}`, description,
    inputSchema: { type: "object", properties: { actionId: { type: "string", minLength: 1,
      description: "ID returned by pad.play in this ownership epoch; only the latest 64 results are retained." } },
      required: ["actionId"], additionalProperties: false }, annotations: { readOnlyHint },
  });
  return [
    { name: "pad.state", description: "Read the bridge's applied controls and active action ID, never game memory. Requires device ownership.",
      inputSchema: NO_ARGUMENTS, annotations: { readOnlyHint: true } },
    { name: "pad.play", description: "Submit independently timed pad channels. Returns an action ID immediately; wait=true waits for the actual terminal result. Only one pad action runs at a time (BUSY otherwise). Closing a submitter or waiter does not cancel an action; human takeover releases all input. Status results retain the latest 64 actions in the current ownership epoch; full results remain in the event log.",
      inputSchema: { type: "object", properties: { inputs,
        wait: { type: "boolean", default: false, description: "Wait for the action to complete after submission." } },
        required: ["inputs"], additionalProperties: false }, annotations: { readOnlyHint: false } },
    action("status", "Read an action's current status without waiting. Requires its ownership epoch.", true),
    action("wait", "Wait for an action's terminal result. Cancelling this wait does not cancel the action. Requires its ownership epoch.", true),
    action("cancel", "Cancel the identified pad action and release its pad input; wait for its terminal result.", false),
    { name: "pad.release", description: "Interrupt all current device input, including any touch contact, and return pad channels to zero while retaining ownership.",
      inputSchema: NO_ARGUMENTS, annotations: { readOnlyHint: false } },
  ];
}
