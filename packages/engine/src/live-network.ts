import { lookup } from "node:dns/promises";
import { BlockList, connect, isIP } from "node:net";
import type { Duplex } from "node:stream";

export interface NetworkRule {
  level: "packages" | "open";
  allow?: readonly string[];
  deny?: readonly string[];
}

export interface LiveConnection {
  host: string;
  port: number;
  method: string | null;
  tls?: boolean;
  target?: string;
  allowed: boolean;
  why?: string;
  address?: string;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");
const FIRST_BYTES_LIMIT = 64 * 1024;

function hostRefusal(rule: NetworkRule, host: string): string | undefined {
  if (isIP(host)) return "a raw address, not a name the box looked up";
  if (rule.level === "packages" && !rule.allow?.includes(host)) return "not a package registry";
  if (rule.level === "open" && rule.deny?.includes(host)) return "covered by a plugin's copy";
  return undefined;
}

function serverName(hello: Buffer): string | null | undefined {
  if (hello.length < 5) return undefined;
  const end = 5 + hello.readUInt16BE(3);
  if (hello.length < end) return end > FIRST_BYTES_LIMIT ? null : undefined;
  if (hello[5] !== 1) return null;
  let p = 5 + 4 + 2 + 32;
  if (p >= end) return null;
  p += 1 + hello[p]!;
  if (p + 2 > end) return null;
  p += 2 + hello.readUInt16BE(p);
  if (p >= end) return null;
  p += 1 + hello[p]!;
  if (p + 2 > end) return null;
  const extensions = Math.min(end, p + 2 + hello.readUInt16BE(p));
  p += 2;
  while (p + 4 <= extensions) {
    const type = hello.readUInt16BE(p), length = hello.readUInt16BE(p + 2);
    p += 4;
    if (type === 0 && p + 5 <= extensions && hello[p + 2] === 0) {
      const size = hello.readUInt16BE(p + 3);
      return p + 5 + size <= extensions ? hello.subarray(p + 5, p + 5 + size).toString("ascii").toLowerCase() : null;
    }
    p += length;
  }
  return null;
}

type Opening = { method: string | null; tls: boolean; target?: string; named: string | null } | undefined;

function opening(first: Buffer): Opening {
  if (first[0] === 0x16) {
    const name = serverName(first);
    return name === undefined ? undefined : { method: null, tls: true, named: name };
  }
  const head = first.indexOf("\r\n\r\n");
  if (head < 0) return first.length > FIRST_BYTES_LIMIT ? { method: null, tls: false, named: null } : undefined;
  const lines = first.subarray(0, head).toString("latin1").split("\r\n");
  const request = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
  const hosts = lines.slice(1).filter(line => /^host:/i.test(line)).map(line => line.slice(5).trim().toLowerCase().replace(/:\d+$/, ""));
  return request ? { method: request[1]!, tls: false, target: request[2]!, named: hosts.length === 1 ? hosts[0]! : null } : { method: null, tls: false, named: null };
}

export function relayLive(stream: Duplex, destination: { host: string; port: number }, rule: NetworkRule, record: (connection: LiveConnection) => void): void {
  const host = destination.host.toLowerCase();
  const refuse = (connection: Omit<LiveConnection, "host" | "port" | "allowed">) => { record({ host, port: destination.port, allowed: false, ...connection }); stream.destroy(); };
  const refusal = hostRefusal(rule, host);
  if (refusal) { refuse({ method: null, why: refusal }); return; }
  let first = Buffer.alloc(0);
  const read = (chunk: Buffer) => {
    first = Buffer.concat([first, chunk]);
    const seen = opening(first);
    if (!seen) return;
    stream.off("data", read);
    stream.pause();
    void (async () => {
      const said = { method: seen.method, tls: seen.tls, ...(seen.target ? { target: seen.target } : {}) };
      if (seen.named !== host) { refuse({ ...said, why: seen.named ? "named another host inside the connection: " + seen.named : "did not name its host inside the connection" }); return; }
      const addresses = await lookup(host, { all: true }).catch(() => []);
      const address = addresses[0]?.address;
      if (!address) { refuse({ ...said, why: "the name does not resolve" }); return; }
      if (addresses.some(a => PRIVATE.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) { refuse({ ...said, why: "resolves to a private address", address }); return; }
      record({ host, port: destination.port, allowed: true, address, ...said });
      const upstream = connect({ host: address, port: destination.port, allowHalfOpen: true });
      upstream.on("error", () => stream.destroy());
      stream.on("error", () => upstream.destroy());
      stream.on("close", () => upstream.destroy());
      upstream.on("close", () => stream.destroy());
      upstream.write(first);
      stream.pipe(upstream);
      upstream.pipe(stream);
      stream.resume();
    })();
  };
  stream.on("data", read);
  stream.on("error", () => {});
}
