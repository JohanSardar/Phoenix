import { Duplex, type Readable, type Writable } from "node:stream";
import { createInterface } from "node:readline";

export interface Destination { host: string; port: number }
export interface EngineConnection { destination: Destination; stream: Duplex }

export class EngineChannel implements AsyncIterable<EngineConnection> {
  readonly rawAddressReporting = false;
  readonly closed: Promise<Error>;
  readonly ready: Promise<void>;
  private connections = new Map<number, Duplex>();
  private pending: EngineConnection[] = [];
  private waiters: { resolve: (value: IteratorResult<EngineConnection>) => void; reject: (error: Error) => void }[] = [];
  private failure?: Error;
  private finish!: (error: Error) => void;
  private connected!: () => void;
  private notConnected!: (error: Error) => void;
  private output: Writable;
  private nextId = -1;

  private stream(id: number): Duplex {
    const send = (type: string, data?: string) => this.send({ type, id, ...(data === undefined ? {} : { data }) });
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) { send("data", Buffer.from(chunk).toString("base64")); callback(); },
      final(callback) { send("end"); callback(); },
      destroy(error, callback) { send("close"); callback(error); },
      allowHalfOpen: true,
    });
    stream.on("error", () => {});
    this.connections.set(id, stream);
    return stream;
  }

  connect(port: number): Duplex {
    if (this.failure) throw this.failure;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid loopback port");
    const id = this.nextId--;
    const stream = this.stream(id);
    this.send({ type: "connect", id, port });
    return stream;
  }

  constructor(input: Readable, output: Writable) {
    this.output = output;
    this.closed = new Promise((resolve) => { this.finish = resolve; });
    this.ready = new Promise((resolve, reject) => { this.connected = resolve; this.notConnected = reject; });
    const lines = createInterface({ input });
    lines.on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.type === "ready") { this.connected(); return; }
        if (!Number.isSafeInteger(m.id)) throw new Error("Invalid relay connection id");
        if (m.type === "open") {
          if (this.connections.has(m.id) || typeof m.host !== "string" || !Number.isInteger(m.port)) throw new Error("Invalid relay open");
          const stream = this.stream(m.id);
          const connection = { destination: { host: m.host, port: m.port }, stream };
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve({ done: false, value: connection });
          else this.pending.push(connection);
        } else {
          const stream = this.connections.get(m.id);
          if (!stream) return;
          if (m.type === "data" && typeof m.data === "string") stream.push(Buffer.from(m.data, "base64"));
          else if (m.type === "end") stream.push(null);
          else if (m.type === "close") { this.connections.delete(m.id); stream.destroy(); }
          else throw new Error("Invalid relay frame");
        }
      } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    });
    lines.on("close", () => this.close(new Error("Relay channel closed")));
    input.on("error", (error) => this.close(error));
    output.on("error", (error) => this.close(error));
  }

  private send(message: object): void {
    if (!this.failure) this.output.write(JSON.stringify(message) + "\n");
  }

  close(error = new Error("Engine channel closed")): void {
    if (this.failure) return;
    this.failure = error;
    this.notConnected(error);
    for (const stream of this.connections.values()) stream.destroy(error);
    this.connections.clear();
    this.pending = [];
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.output.end();
    this.finish(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineConnection> {
    return { next: () => {
      if (this.failure) return Promise.reject(this.failure);
      const value = this.pending.shift();
      if (value) return Promise.resolve({ done: false, value });
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    } };
  }
}
