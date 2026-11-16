import { connect } from "node:net";
import type { EngineConnection } from "./channel.ts";

export interface LlmConnection { host: string; server_name: string | null; passed: boolean; reason?: string; sent: number; received: number }

const MAX_HELLO = 5 + 16384;

export function serverName(record: Buffer): { name: string | null; reason?: string } {
  if (record[0] !== 0x16 || record.length < 9 || record[5] !== 0x01) return { name: null, reason: "the connection did not start with a TLS client hello" };
  const end = 5 + record.readUInt16BE(3);
  if (9 + record.readUIntBE(6, 3) > end) return { name: null, reason: "the TLS client hello is split over several records" };
  try {
    let p = 9 + 2 + 32;
    p += 1 + record[p]!;
    p += 2 + record.readUInt16BE(p);
    p += 1 + record[p]!;
    const extensionsEnd = p + 2 + record.readUInt16BE(p);
    if (extensionsEnd > end) return { name: null, reason: "the TLS client hello is malformed" };
    let name: string | null = null;
    for (p += 2; p + 4 <= extensionsEnd;) {
      const type = record.readUInt16BE(p), length = record.readUInt16BE(p + 2), body = record.subarray(p + 4, p + 4 + length);
      if (type === 0xfe0d || type === 0xffce) return { name: null, reason: "the TLS client hello hides its server name" };
      if (type === 0 && body.length >= 5 && body[2] === 0) name = body.subarray(5, 5 + body.readUInt16BE(3)).toString("ascii").toLowerCase();
      p += 4 + length;
    }
    return name ? { name } : { name: null, reason: "the TLS client hello names no server" };
  } catch { return { name: null, reason: "the TLS client hello is malformed" }; }
}

export function passToLlm({ destination, stream }: EngineConnection, log: LlmConnection[]): void {
  const entry: LlmConnection = { host: destination.host, server_name: null, passed: false, sent: 0, received: 0 };
  log.push(entry);
  let hello = Buffer.alloc(0);
  const refuse = (reason: string) => { clearTimeout(timer); stream.off("data", onData); entry.reason = reason; stream.destroy(); };
  const timer = setTimeout(() => refuse("no TLS client hello within 10 seconds"), 10_000);
  const onData = (chunk: Buffer) => {
    hello = Buffer.concat([hello, chunk]);
    if (hello[0] !== 0x16) return refuse("the connection did not start with a TLS client hello");
    if (hello.length > MAX_HELLO) return refuse("the TLS client hello is too large");
    if (hello.length < 5 || hello.length < 5 + hello.readUInt16BE(3)) return;
    clearTimeout(timer);
    stream.off("data", onData);
    stream.pause();
    const { name, reason } = serverName(hello);
    entry.server_name = name;
    if (name !== destination.host.toLowerCase()) return refuse(reason ?? `the TLS client hello names ${name}, not ${destination.host}`);
    entry.passed = true;
    const upstream = connect({ host: destination.host, port: 443, allowHalfOpen: true });
    upstream.write(hello);
    entry.sent += hello.length;
    stream.on("data", (data: Buffer) => { entry.sent += data.length; });
    upstream.on("data", (data: Buffer) => { entry.received += data.length; });
    stream.pipe(upstream);
    upstream.pipe(stream);
    upstream.on("error", () => stream.destroy());
    upstream.on("close", () => stream.destroy());
    stream.on("close", () => upstream.destroy());
  };
  stream.on("data", onData);
  stream.on("close", () => clearTimeout(timer));
}
