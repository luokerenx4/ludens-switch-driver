import { expect, test } from "bun:test";
import { compileTimeline } from "../src/timeline.ts";
import { padTools, POLLED_TIMING } from "../src/schema.ts";
import { argumentValidator } from "../src/tool-contract.ts";

const buttons = ["LEFT", "B"];
const axes = ["LX"];
const compile = (inputs: unknown, minSpanMs?: number) => compileTimeline(inputs, buttons, axes, minSpanMs);

test("independently timed keys combine and release without dropping the longer hold", () => {
  expect(compile([
    { atMs: 0, durationMs: 500, state: { LEFT: 1 } },
    { atMs: 0, durationMs: 300, state: { B: 1 } },
  ])).toEqual([
    { durationMs: 300, state: { LEFT: 1, B: 1, LX: 0 } },
    { durationMs: 200, state: { LEFT: 1, B: 0, LX: 0 } },
  ]);
});

test("offsets, simultaneous boundary updates and analog channels share one ordered timeline", () => {
  expect(compile([
    { atMs: 200, durationMs: 100, state: { B: 1, LX: -0.5 } },
    { atMs: 100, durationMs: 100, state: { LEFT: 1 } },
    { atMs: 200, durationMs: 200, state: { LEFT: 1 } },
  ])).toEqual([
    { durationMs: 100, state: { LEFT: 0, B: 0, LX: 0 } },
    { durationMs: 100, state: { LEFT: 1, B: 0, LX: 0 } },
    { durationMs: 100, state: { LEFT: 1, B: 1, LX: -0.5 } },
    { durationMs: 100, state: { LEFT: 1, B: 0, LX: 0 } },
  ]);
  expect(compile([
    { atMs: 0, durationMs: 10, state: { LEFT: 1 } },
    { atMs: 10, durationMs: 30, state: { LEFT: 1 } },
  ])).toEqual([{ durationMs: 40, state: { LEFT: 1, B: 0, LX: 0 } }]);
});

test("same-channel overlaps are rejected, including zero values and equal values", () => {
  for (const values of [[1, 1], [1, 0], [0, 0]]) {
    expect(() => compile([
      { atMs: 100, durationMs: 100, state: { LEFT: values[0] } },
      { atMs: 0, durationMs: 150, state: { LEFT: values[1] } },
    ])).toThrow("Overlapping inputs for channel LEFT");
  }
});

test("short pulses or offsets are rejected rather than changing their timing", () => {
  for (const inputs of [
    [{ atMs: 0, durationMs: 15, state: { B: 1 } }],
    [{ atMs: 15, durationMs: 100, state: { B: 1 } }],
    [{ atMs: 0, durationMs: 500, state: { LEFT: 1 } }, { atMs: 0, durationMs: 490, state: { B: 1 } }],
  ]) expect(() => compile(inputs)).toThrow("at least 16 ms apart");
  expect(compile([{ atMs: 0, durationMs: 1, state: { B: 1 } }], 1)).toEqual([
    { durationMs: 1, state: { LEFT: 0, B: 1, LX: 0 } },
  ]);
  expect(compile([{ atMs: 0, durationMs: 100, state: {} }])).toEqual([
    { durationMs: 100, state: { LEFT: 0, B: 0, LX: 0 } },
  ]);
});

test("timeline validation rejects ambiguous input and unsafe time arithmetic", () => {
  const valid = { atMs: 0, durationMs: 100, state: { B: 1 } };
  for (const inputs of [null, {}, [], [null], [[valid]],
    [{ ...valid, typo: true }], [{ state: { B: 1 }, durationMs: 100 }],
    [{ ...valid, atMs: -1 }], [{ ...valid, atMs: "0" }], [{ ...valid, atMs: 1.5 }],
    [{ ...valid, durationMs: 0 }], [{ ...valid, durationMs: Infinity }], [{ ...valid, durationMs: "100" }],
    [{ ...valid, atMs: Number.MAX_SAFE_INTEGER }],
    [{ ...valid, durationMs: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...valid, state: [] }], [{ ...valid, state: { A: 1 } }],
    [{ ...valid, state: { B: true } }], [{ ...valid, state: { B: 0.5 } }],
    [{ ...valid, state: { LX: NaN } }], [{ ...valid, state: { LX: 1.1 } }],
  ]) expect(() => compile(inputs)).toThrow();
});

test("pad tools expose independent lifecycle schemas with native object arguments", () => {
  const tools = padTools(buttons, axes, POLLED_TIMING);
  expect(tools.map(tool => tool.name)).toEqual(["pad.state", "pad.play", "pad.status", "pad.wait", "pad.cancel", "pad.release"]);
  const play = tools.find(tool => tool.name === "pad.play")!;
  expect(play.inputSchema).toMatchObject({ required: ["inputs"], additionalProperties: false,
    properties: { inputs: { items: { required: ["atMs", "durationMs", "state"], additionalProperties: false } },
      wait: { type: "boolean", default: false } } });
  const inputs = [{ atMs: 0, durationMs: 500, state: { LEFT: 1 } }];
  const validate = argumentValidator(play);
  expect(validate({ inputs, wait: true })).toEqual({ inputs, wait: true });
  for (const args of [{}, { inputs, wait: "true" }, { inputs: JSON.stringify(inputs) }, { inputs, file: "/unused" }]) {
    expect(() => validate(args)).toThrow();
  }
  for (const name of ["status", "wait", "cancel"]) {
    expect(tools.find(tool => tool.name === `pad.${name}`)).toMatchObject({
      inputSchema: { required: ["actionId"], additionalProperties: false },
    });
  }
});
