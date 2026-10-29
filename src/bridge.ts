import { connect, type Socket } from "node:net";

export class Bridge {
  private socket: Socket;
  private pending = new Map<string, { resolve: (fields: string[]) => void; reject: (error: Error) => void }>();
  private failure?: Error;
  onDisconnect?: (error: Error) => void;

  private constructor(socket: Socket) {
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const [id, status, ...fields] = buffer.slice(0, end).split("\t");
        buffer = buffer.slice(end + 1);
        const task = this.pending.get(id);
        if (!task) continue;
        this.pending.delete(id);
        if (status === "OK") task.resolve(fields);
        else task.reject(new Error(fields.join(" ")));
      }
    });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const task of this.pending.values()) task.reject(error);
      this.pending.clear();
      this.onDisconnect?.(error);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Device bridge disconnected")));
  }

  static async open(port: number): Promise<Bridge> {
    const socket = connect({ host: "127.0.0.1", port });
    const bridge = new Bridge(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return bridge;
  }

  request(op: string, args: (string | number)[] = [], id: string = crypto.randomUUID()): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure);
    if ([op, ...args].some((field) => /[\t\r\n]/.test(String(field)))) {
      return Promise.reject(new Error("Bridge fields cannot contain tabs or newlines"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write([id, op, ...args].join("\t") + "\n");
    });
  }

  close() { this.socket.destroy(); }
}
