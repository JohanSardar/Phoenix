import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { Backend, Frame } from "@phoenix/taps";

export type Connection = Parameters<Backend["open"]>[0];
export interface Copy {
  type: "open" | "frame" | "close";
  stream: string;
  seq: number;
  wall: string;
  mono: string;
  connection?: Connection;
  frame?: { dir: Frame["dir"]; stream: number; bytes: string; last: boolean; first: boolean; partial: boolean };
  dropped?: { from: number; to: number; bytes: number };
  aborted?: boolean;
}

export function recordingSink(connection: Connection, options: { socket: string; bound?: number }) {
  const stream = randomUUID(), bound = options.bound ?? 1024 * 1024;
  let seq = 0, queuedBytes = 0, disabled = false, ended = false;
  let socket: Socket | undefined, timer: NodeJS.Timeout | undefined;
  let dropped: Copy["dropped"];
  const queue: { copy: Copy; size: number }[] = [];
  const messages = new Map<string, { first: boolean; partial: boolean }>();
  const lost = (copy: Copy, size: number) => {
    dropped = { from: dropped?.from ?? copy.seq, to: copy.seq, bytes: (dropped?.bytes ?? 0) + size };
  };
  const stamp = (type: Copy["type"]): Copy => ({ type, stream, seq: seq++, wall: new Date().toISOString(), mono: process.hrtime.bigint().toString() });
  const flush = () => {
    if (!socket || socket.connecting || socket.destroyed) return;
    while (queue.length) {
      const item = queue.shift()!;
      queuedBytes -= item.size;
      if (!socket.write(JSON.stringify(item.copy) + "\n")) break;
    }
    if (ended && !queue.length) socket.end();
  };
  const offer = (copy: Copy, size: number) => {
    if (disabled) return;
    if (queuedBytes + (socket?.writableLength ?? 0) + size > bound) { lost(copy, size); return; }
    if (dropped) { copy.dropped = dropped; dropped = undefined; }
    queue.push({ copy, size }); queuedBytes += size;
    setImmediate(() => { try { flush(); } catch { disabled = true; socket?.destroy(); } }).unref();
  };
  let opening = stamp("open"); opening.connection = connection;
  const reconnect = () => {
    if (disabled || ended) return;
    socket = connect(options.socket);
    socket.unref();
    socket.on("error", () => {});
    socket.on("drain", () => { try { flush(); } catch { disabled = true; socket?.destroy(); } });
    socket.once("connect", () => {
      try {
        if (dropped) { opening.dropped = dropped; dropped = undefined; }
        socket!.write(JSON.stringify(opening) + "\n");
        flush();
      } catch { disabled = true; socket?.destroy(); }
    });
    socket.once("close", () => {
      for (const item of queue.splice(0)) lost(item.copy, item.size);
      queuedBytes = 0;
      opening = stamp("open"); opening.connection = connection;
      if (!disabled && !ended) { timer = setTimeout(reconnect, 100); timer.unref(); }
    });
  };
  reconnect();
  return {
    frame(f: Frame) {
      if (disabled) return;
      try {
        const copy = stamp("frame"), size = f.bytes.length * 4 / 3 + 512, key = `${f.dir}:${f.stream}`;
        const message = messages.get(key) ?? { first: true, partial: false };
        if (queuedBytes + (socket?.writableLength ?? 0) + size > bound) {
          lost(copy, f.bytes.length); message.first = false; message.partial = true;
          if (f.last) messages.delete(key); else messages.set(key, message);
          return;
        }
        copy.frame = { dir: f.dir, stream: f.stream, bytes: Buffer.from(f.bytes).toString("base64"), last: f.last, first: message.first, partial: message.partial };
        message.first = false;
        if (f.last) messages.delete(key); else messages.set(key, message);
        offer(copy, size);
      } catch { disabled = true; socket?.destroy(); }
    },
    close(aborted: boolean) {
      if (ended) return;
      try { const copy = stamp("close"); copy.aborted = aborted; offer(copy, 512); ended = true; flush(); } catch {}
      if (timer) clearTimeout(timer);
    },
  };
}

export function tee(upstream: Backend, options: { socket: string; bound?: number }): Backend {
  return { open(connection) {
    const link = upstream.open(connection);
    let sink: ReturnType<typeof recordingSink> | undefined;
    try { sink = recordingSink(connection, options); } catch {}
    return {
      async write(f) { await link.write(f); sink?.frame(f); },
      async *frames() {
        let aborted = false;
        try {
          for await (const f of link.frames()) { try { yield f; } finally { sink?.frame(f); } }
        } catch (error) { aborted = true; throw error;
        } finally { sink?.close(aborted); }
      },
      abort(why) { link.abort(why); sink?.close(true); },
    };
  } };
}
