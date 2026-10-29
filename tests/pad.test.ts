import { expect, test } from "bun:test";
import type { Bridge } from "../src/bridge.ts";
import { createPadPlayer } from "../src/pad.ts";

test("pad waiter cancellation leaves the native action running; control cancellation stops it and records one terminal result", async () => {
  const completed = Promise.withResolvers<string[]>();
  const requests: { op: string; fields?: string[]; id?: string }[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const bridge = { request: (op: string, fields?: string[], id?: string) => {
    requests.push({ op, fields, id });
    return op === "APPLY" ? completed.promise : Promise.resolve([]);
  } } as unknown as Bridge;
  const player = createPadPlayer({ bridge, clock: { id: "pad-test", now: () => performance.now() },
    encode: () => "1:0:0:0:0:30000", decode: ([elapsedMs]) => ({ elapsedMs: Number(elapsedMs) }) });
  const control = new AbortController();
  const context = { epoch: "epoch", signal: new AbortController().signal, controlSignal: control.signal,
    record: (type: "action_start" | "action_end", data: Record<string, unknown>) => { events.push({ type, data }); } };
  const submitted = JSON.parse((await player.execute("play", { inputs: [] }, context)).stdout);
  expect(submitted.status).toBe("running");
  expect(() => player.reset()).toThrow("BUSY");
  const waiter = new AbortController();
  const waiting = player.execute("wait", { actionId: submitted.actionId }, { ...context, signal: waiter.signal });
  waiter.abort();
  await expect(waiting).rejects.toThrow();
  expect(requests.map(r => r.op)).toEqual(["APPLY"]);
  expect(JSON.parse((await player.execute("status", { actionId: submitted.actionId }, context)).stdout).status).toBe("running");
  control.abort();
  expect(requests.at(-1)).toMatchObject({ op: "STOP", fields: ["epoch", submitted.actionId] });
  completed.resolve(["interrupted", "20", "2"]);
  await player.settle();
  const terminal = await player.execute("wait", { actionId: submitted.actionId }, context);
  expect(terminal).toMatchObject({ status: "interrupted", exitCode: 130 });
  expect(events.map(event => event.type)).toEqual(["action_start", "action_end"]);
  expect(events[1].data).toMatchObject({ actionId: submitted.actionId, status: "interrupted" });
  player.reset();
  await expect(player.execute("status", { actionId: submitted.actionId }, context)).rejects.toThrow("Unknown action");
});
