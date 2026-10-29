import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "./driver-fixture.ts";
import { AXES, BUTTONS, createSwitchProvider, encodeSpans } from "../src/provider.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("Switch controls encode complete digital and analog states without game semantics", () => {
  expect(encodeSpans([
    { state: { A: 1, ZL: 1, LX: -1, RY: 0.5 }, durationMs: 100 },
    { state: {}, durationMs: 16 },
  ])).toBe("257:-32767:0:0:16384:100,0:0:0:0:0:16");
  const invalidStates: Record<string, number>[] = [{ JUMP: 1 }, { A: 0.5 }, { LX: 1.1 }, { RY: NaN }];
  for (const state of invalidStates) {
    expect(() => encodeSpans([{ state, durationMs: 100 }])).toThrow("Invalid channel");
  }
  expect(() => encodeSpans([{ state: {}, durationMs: 15 }])).toThrow(">= 16");
});

test("Switch accepts long actions and sequences while rejecting invalid or unsafe durations", () => {
  expect(encodeSpans([{ state: { A: 1 }, durationMs: 30_000 }])).toBe("1:0:0:0:0:30000");
  expect(encodeSpans([
    { state: { A: 1 }, durationMs: 5_000 },
    { state: {}, durationMs: 25_000 },
  ])).toBe("1:0:0:0:0:5000,0:0:0:0:0:25000");
  for (const durationMs of [NaN, Infinity, 16.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => encodeSpans([{ state: {}, durationMs }])).toThrow();
  }
  expect(() => encodeSpans([
    { state: {}, durationMs: Number.MAX_SAFE_INTEGER },
    { state: {}, durationMs: 16 },
  ])).toThrow();
});

async function withSwitchBridge(run: (provider: Awaited<ReturnType<typeof createSwitchProvider>>,
  captures: { path: string; atMs: number }[], requests: string[], typed: string[]) => Promise<void>, surface = "screen") {
  const directory = await mkdtemp(join(tmpdir(), "rsa-switch-capture-"));
  const captures: { path: string; atMs: number }[] = [];
  const requests: string[] = [];
  const typed: string[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const [id, op, path, command, encoded] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        requests.push(op);
        if (op === "HELLO") socket.write(`${id}\tOK\tryubing-rsa-3\n`);
        else if (op === "OWN" || op === "DISOWN") socket.write(`${id}\tOK\n`);
        else if (op === "TOUCH_INFO") socket.write(`${id}\tOK\t0\t0\t1279\t719\n`);
        else if (op === "KEYBOARD" && command === "type") {
          typed.push(Buffer.from(encoded, "base64").toString());
          socket.write(`${id}\tOK\n`);
        }
        else if (op === "CAPTURE") {
          captures.push({ path, atMs: performance.now() });
          void writeFile(path, png).then(() => socket.write(`${id}\tOK\t${captures.length}\t${surface}\n`));
        } else socket.write(`${id}\tERROR\tUnexpected operation: ${op}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createSwitchProvider({ port: (server.address() as AddressInfo).port,
    clock: { id: "test", now: () => performance.now() } });
  try { await run(provider, captures, requests, typed); }
  finally {
    provider.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true });
  }
}

test("Switch capture defaults to zero delay and includes a requested delay in its sampling interval", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.controllers.find(c => c.tool.name === "screen.capture")!;
    expect(screen.tool).toMatchObject({ name: "screen.capture", inputSchema: {
      properties: { delayMs: { type: "integer", minimum: 0, maximum: 2_147_483_647, default: 0 } },
    } });
    const signal = new AbortController().signal;
    const first = (await call(screen, {}, { signal })).observations![0];
    const second = (await call(screen, { delayMs: 0 }, { signal })).observations![0];
    const delayed = (await call(screen, { delayMs: 40 }, { signal })).observations![0];
    expect(captures).toHaveLength(3);
    expect([first.path, second.path, delayed.path]).toEqual([undefined, undefined, undefined]);
    for (const capture of captures) await expect(access(capture.path)).rejects.toThrow();
    expect(first.sourceSequence).toBe(1);
    expect(second.sourceSequence).toBe(2);
    expect(delayed.sourceSequence).toBe(3);
    expect(captures[2].atMs - delayed.timing.requestedAtMs).toBeGreaterThanOrEqual(35);
    expect(delayed.timing.receivedAtMs).toBeGreaterThanOrEqual(captures[2].atMs);
  });
});

test("Switch keyboard capture preserves its surface without inventing a game-frame sequence", async () => {
  await withSwitchBridge(async provider => {
    const screen = provider.capabilities.controllers.find(c => c.tool.name === "screen.capture")!;
    const capture = await call(screen, {}, { signal: new AbortController().signal });
    expect(capture.result.structuredContent).toEqual({ source: "keyboard", timing: capture.timing });
    expect(capture.observations![0].sourceSequence).toBeUndefined();
    expect(capture.result.content[capture.observations![0].contentIndex!]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
  }, "keyboard");
});

test("Switch capture rejects invalid delay arguments before contacting the bridge", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.controllers.find(c => c.tool.name === "screen.capture")!;
    const signal = new AbortController().signal;
    for (const delayMs of [-1, 1.5, NaN, Infinity, 2147483648, "", " ", "40"]) {
      await expect(call(screen, { delayMs }, { signal })).rejects.toThrow();
    }
    await expect(call(screen, { unknown: 1 }, { signal })).rejects.toThrow();
    expect(captures).toHaveLength(0);
  });
});

test("Switch capture cancellation during the delay never sends CAPTURE", async () => {
  await withSwitchBridge(async (provider, captures) => {
    const screen = provider.capabilities.controllers.find(c => c.tool.name === "screen.capture")!;
    const abort = new AbortController();
    const pending = call(screen, { delayMs: 80 }, { signal: abort.signal }).catch(error => error);
    await Bun.sleep(10);
    expect(captures).toHaveLength(0);
    abort.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    await Bun.sleep(90);
    expect(captures).toHaveLength(0);
    await expect(call(screen, {}, { signal: abort.signal })).rejects.toThrow();
    expect(captures).toHaveLength(0);
  });
});


test("Switch touch and pad share one owner acquisition and release", async () => {
  await withSwitchBridge(async (provider, _captures, requests) => {
    const pad = provider.capabilities.controllers.find(c => c.tool.name === "pad.play")!;
    const touch = provider.capabilities.controllers.find(c => c.tool.name === "touch.down")!;
    await pad.acquire!("epoch");
    await touch.acquire!("epoch");
    await touch.release!("epoch");
    await pad.release!("epoch");
    expect(requests.filter(op => op === "OWN")).toHaveLength(1);
    expect(requests.filter(op => op === "DISOWN")).toHaveLength(1);
    expect(touch.tool.description).toContain("x=0..1279, y=0..719");
    expect(touch.tool.inputSchema).toMatchObject({
      properties: { x: { maximum: 1279 }, y: { maximum: 719 } },
    });
  });
});

test("Switch tools describe actual pad channels and software keyboard keys", async () => {
  await withSwitchBridge(async (provider, _captures, _requests, typed) => {
    const pad = provider.capabilities.controllers.find(c => c.tool.name === "pad.play")!;
    const state = { type: "object", additionalProperties: false, properties: {
      ...Object.fromEntries(BUTTONS.map(key => [key, { type: "integer", enum: [0, 1] }])),
      ...Object.fromEntries(AXES.map(key => [key, { type: "number", minimum: -1, maximum: 1 }])),
    } };
    expect(provider.capabilities.controllers.filter(c => c.tool.name.startsWith("pad.")).map(c => c.tool.name)).toEqual(["pad.state", "pad.play", "pad.status", "pad.wait", "pad.cancel", "pad.release"]);
    expect(pad.tool.inputSchema).toMatchObject({ required: ["inputs"], additionalProperties: false, properties: {
      inputs: { type: "array", items: { properties: { state, durationMs: { minimum: 1 }, atMs: { minimum: 0 } }, required: ["atMs", "durationMs", "state"] } },
      wait: { type: "boolean", default: false },
    } });
    const keyboard = provider.capabilities.controllers.find(c => c.tool.name === "keyboard.type")!;
    expect(provider.capabilities.controllers.filter(c => c.tool.name.startsWith("keyboard.")).map(c => c.tool)).toMatchObject([
      { name: "keyboard.type", inputSchema: { properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "keyboard.press", inputSchema: { properties: { key: { enum: ["ENTER", "ESCAPE", "BACKSPACE", "CTRL+A"] } }, required: ["key"] } },
    ]);
    await keyboard.acquire!("epoch");
    await call(keyboard, { text: "--help 文本" }, { epoch: "epoch", signal: new AbortController().signal });
    expect(typed).toEqual(["--help 文本"]);
    await keyboard.release!("epoch");
  });
});

test("Switch release waits for a late action result before reporting release or reacquiring", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baseware-release-order-"));
  let owner: string | undefined;
  let finishAction: (() => void) | undefined;
  let acknowledged = Promise.withResolvers<void>();
  const server = createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const [id, op, epoch] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        const ok = (...fields: string[]) => socket.write([id, "OK", ...fields].join("\t") + "\n");
        if (op === "HELLO") ok("ryubing-rsa-3");
        else if (op === "TOUCH_INFO") ok("0", "0", "1279", "719");
        else if (op === "OWN") {
          if (owner) socket.write(`${id}\tERROR\tOWNED\n`);
          else { owner = epoch; ok(); }
        } else if (op === "APPLY") finishAction = () => { ok("interrupted", "10", "2"); finishAction = undefined; };
        else if (op === "STOP" || op === "DISOWN") {
          if (op === "DISOWN") owner = undefined;
          ok(); // Ryubing schedules the APPLY completion asynchronously, after this acknowledgement.
          acknowledged.resolve();
        } else if (op === "CAPTURE") void writeFile(epoch, png).then(() => ok("1"));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createSwitchProvider({ port: (server.address() as AddressInfo).port,
    clock: { id: "release-order", now: () => performance.now() } });
  const tool = (name: string) => provider.capabilities.controllers.find(c => c.tool.name === name)!;
  const pad = tool("pad.play");
  const screen = provider.capabilities.controllers.find(c => c.tool.name === "screen.capture")!;
  const context = {epoch: "old", signal: new AbortController().signal};
  try {
    await pad.acquire!(context.epoch);
    for (const disown of [false, true]) {
      acknowledged = Promise.withResolvers<void>();
      const action = JSON.parse((await call(pad, { inputs: [{ atMs: 0, durationMs: 30000, state: { A: 1 } }] }, context)).stdout);
      let released = false;
      const releasing = (disown ? pad.release!(context.epoch) : call(tool("pad.release"), {}, context)).then(() => { released = true; });
      await acknowledged.promise;
      // This later response on the same socket proves the STOP/DISOWN reply was consumed,
      // without sleeps or depending on thread scheduling for the delayed action result.
      await call(screen, {}, {signal: context.signal});
      expect(released).toBe(false);
      finishAction!();
      await releasing;
      if (!disown) expect(JSON.parse((await call(tool("pad.wait"), { actionId: action.actionId }, context)).stdout).status).toBe("interrupted");
    }
    await pad.acquire!("new");
    expect(owner).toBe("new");
    await pad.release!("new");
  } finally {
    finishAction?.();
    provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});
