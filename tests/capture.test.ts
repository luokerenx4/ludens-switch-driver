import { expect, test } from "bun:test";
import { access, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { dirname } from "node:path";
import { createSwitchProvider } from "../src/provider.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

for (const driver of ["ryubing"] as const) {
  test(`${driver} capture transfers bytes and releases temporary files on success, failure and cancellation`, async () => {
    let mode: "success" | "failure" | "missing" | "cancel" = "success";
    let control = new AbortController();
    const captures: string[] = [];
    const server = createServer(socket => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const [id, op, ...args] = buffer.slice(0, end).split("\t");
          buffer = buffer.slice(end + 1);
          const reply = (status: string, ...fields: string[]) => socket.write([id, status, ...fields].join("\t") + "\n");
          if (op === "HELLO") {
            reply("OK", "ryubing-rsa-3");
          } else if (op === "TOUCH_INFO") reply("OK", "0", "0", "319", "239");
          else if (op === "CAPTURE") {
            const path = args[0];
            captures.push(path);
            void (async () => {
              if (mode !== "missing") await writeFile(path, png);
              if (mode === "cancel") control.abort();
              reply(mode === "failure" ? "ERROR" : "OK", mode === "failure" ? "fixture capture failed" : "1");
            })();
          } else reply("ERROR", `Unexpected ${op}`);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = await createSwitchProvider({ port: (server.address() as AddressInfo).port,
      clock: { id: "fixture", now: () => performance.now() } });
    try {
      const capture = provider.capabilities.controllers.find(controller => controller.tool.name ===
        "screen.capture")!;
      for (const next of ["success", "success", "failure", "missing", "cancel", "success"] as const) {
        mode = next;
        control = new AbortController();
        const pending = capture.execute({}, { signal: control.signal });
        if (mode === "success") {
          const result = await pending;
          expect(result.result.content[0]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
          expect(result.observations![0].path).toBeUndefined();
        } else await expect(pending).rejects.toThrow();
        await expect(access(dirname(captures.at(-1)!))).rejects.toThrow();
      }
      expect(captures).toHaveLength(6);
      expect(new Set(captures).size).toBe(6);
    } finally {
      provider.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

for (const driver of ["ryubing"] as const) {
  test(`${driver} zero-delay burst captures keep sequence monotonic and clean temporary files`, async () => {
    let frame = 0;
    let surface = "screen";
    const paths: string[] = [];
    const server = createServer(socket => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const [id, op, ...args] = buffer.slice(0, end).split("\t");
          buffer = buffer.slice(end + 1);
          const reply = (status: string, ...fields: string[]) => socket.write([id, status, ...fields].join("\t") + "\n");
          if (op === "HELLO") reply("OK", "ryubing-rsa-3");
          else if (op === "TOUCH_INFO") reply("OK", "0", "0", "319", "239");
          else if (op === "CAPTURE") {
            paths.push(args[0]);
            void (async () => {
              await writeFile(args[0], png);
              reply("OK", surface === "keyboard" ? "0" : String(++frame), surface);
            })();
          } else reply("ERROR", `Unexpected ${op}`);
        }
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    const provider = await createSwitchProvider({ port: (server.address() as AddressInfo).port,
      clock: { id: "fixture", now: () => performance.now() } });
    try {
      const capture = provider.capabilities.controllers.find(controller => controller.tool.name ===
        "screen.capture")!;
      let gameFrames = 0;
      for (let index = 0; index < 20; index++) {
        surface = index === 10 ? "keyboard" : "screen";
        const result = await capture.execute({}, { signal: new AbortController().signal });
        const output = result.result.structuredContent as Record<string, unknown>;
        if (surface === "keyboard") {
          expect(output.source).toBe("keyboard");
          expect(output).not.toHaveProperty("sourceSequence");
        } else {
          gameFrames++;
          expect(output.source).toBe("screen");
          expect(output.sourceSequence).toBe(gameFrames);
        }
        expect(result.result.content[0]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
        await expect(access(dirname(paths.at(-1)!))).rejects.toThrow();
      }
      expect(gameFrames).toBe(19);
      expect(frame).toBe(19);
      expect(paths).toHaveLength(20);
    } finally {
      provider.close();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
  });
}
