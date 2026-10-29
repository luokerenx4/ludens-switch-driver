import { expect, test } from "bun:test";
import { createTouchControllers } from "../src/touch.ts";
import { call } from "./driver-fixture.ts";
import type { Bridge } from "../src/bridge.ts";

type Request = { op: string; args: (string | number)[]; id: string };
const clock = { id: "touch-test", now: () => performance.now() };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(handle?: (request: Request) => Promise<string[]>) {
  let owner: string | undefined;
  const requests: Request[] = [];
  const bridge: Pick<Bridge, "request"> = {
    request(op, args = [], id = crypto.randomUUID()) {
      const request = { op, args, id };
      requests.push(request);
      if (op === "TOUCH_INFO") return Promise.resolve(["0", "0", "319", "239"]);
      return handle?.(request) ?? Promise.resolve(["completed"]);
    },
  };
  const controllers = await createTouchControllers({ bridge, clock,
    acquire: async epoch => { owner = epoch; },
    release: async epoch => { if (owner === epoch) owner = undefined; },
    owns: epoch => owner === epoch,
  });
  await controllers[0].acquire!("owner");
  return { controllers, controller: controllers[0], requests, context: { epoch: "owner", signal: new AbortController().signal } };
}

test("touch exposes native bounds and sends only down, move and up with unique request IDs", async () => {
  const { controllers, controller, requests, context } = await fixture();
  expect(controller.tool.name).toBe("touch.down");
  expect(controller.requiresControl).toBe(true);
  expect(controller.tool.description).toContain("x=0..319, y=0..239");
  expect(controllers.map(c => c.tool)).toMatchObject([
    { name: "touch.down", inputSchema: { properties: {
      x: { type: "integer", minimum: 0, maximum: 319 }, y: { type: "integer", minimum: 0, maximum: 239 },
    }, required: ["x", "y"] } },
    { name: "touch.move", inputSchema: { properties: { x: { maximum: 319 }, y: { maximum: 239 } } } },
    { name: "touch.up", inputSchema: { properties: {}, additionalProperties: false } },
  ]);
  const down = await call(controller, { x: 0, y: 239 }, context);
  await call(controllers[1], { x: 319, y: 0 }, context);
  await call(controllers[2], {}, context);
  expect(requests.map(({ op, args }) => [op, args])).toEqual([
    ["TOUCH_INFO", []], ["TOUCH_DOWN", ["owner", 0, 239]],
    ["TOUCH_MOVE", ["owner", 319, 0]], ["TOUCH_UP", ["owner"]],
  ]);
  expect(down.id).toBe(requests[1].id);
  expect(down.result.structuredContent).toEqual({ status: "completed" });
  expect(new Set(requests.map(request => request.id)).size).toBe(4);
  for (const request of requests) expect(request.id).toMatch(uuid);
});

test("touch rejects invalid coordinates, extra arguments and stale ownership before sending input", async () => {
  const { controller, requests, context } = await fixture();
  for (const args of [
    { x: -1, y: 0 }, { x: 320, y: 0 }, { x: 0, y: 240 }, { x: 1.5, y: 0 },
    { x: "", y: 0 }, { x: 0 }, { x: 0, y: 0, extra: true },
  ]) await expect(call(controller, args, context)).rejects.toThrow();
  await expect(call(controller, { x: 0, y: 0 }, { ...context, epoch: "other" })).rejects.toThrow("STALE_EPOCH");
  await controller.release!("owner");
  await expect(call(controller, { x: 0, y: 0 }, context)).rejects.toThrow("STALE_EPOCH");
  expect(requests.map(request => request.op)).toEqual(["TOUCH_INFO"]);
});

test("touch waits for native sampling and lets native contact-state errors surface", async () => {
  let finish: ((fields: string[]) => void) | undefined;
  const { controllers, controller, context } = await fixture(({ op }) => {
    if (op === "TOUCH_DOWN") return new Promise(resolve => { finish = resolve; });
    return Promise.reject(new Error("NOT_DOWN"));
  });
  let settled = false;
  const pending = call(controller, { x: 10, y: 20 }, context)
    .then(result => { settled = true; return result; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish!(["completed"]);
  expect((await pending).status).toBe("completed");
  await expect(call(controllers[1], { x: 10, y: 20 }, context)).rejects.toThrow("NOT_DOWN");
});

test("touch cancellation targets its command ID and retains the shared owner", async () => {
  let finish: ((fields: string[]) => void) | undefined;
  const { controllers, controller, requests, context } = await fixture(({ op }) => {
    if (op === "TOUCH_DOWN") return new Promise(resolve => { finish = resolve; });
    if (op === "STOP") finish!(["interrupted"]);
    return Promise.resolve(["completed"]);
  });
  const abort = new AbortController();
  const pending = call(controller, { x: 10, y: 20 }, { ...context, signal: abort.signal });
  abort.abort();
  const result = await pending;
  expect(result.status).toBe("interrupted");
  expect(result.exitCode).toBe(130);
  const down = requests.find(request => request.op === "TOUCH_DOWN")!;
  const stop = requests.find(request => request.op === "STOP")!;
  expect(stop.args).toEqual(["owner", down.id]);
  expect(stop.id).toMatch(uuid);
  expect(stop.id).not.toBe(down.id);
  await call(controllers[2], {}, context);
  expect(requests.some(request => request.op === "DISOWN")).toBe(false);
});
