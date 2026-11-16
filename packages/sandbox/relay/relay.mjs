import net from "node:net";
import dgram from "node:dgram";
import fs from "node:fs";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";

const path = "/run/phoenix/engine.sock";
if (process.argv[2] === "bridge") {
  const socket = net.connect(path);
  socket.on("error", () => process.exit(1));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("close", () => process.exit(0));
} else {
  fs.mkdirSync("/run/phoenix", { recursive: true, mode: 0o700 });
  let engine;
  let id = 0;
  let address = 1;
  const names = new Map();
  const hosts = new Map();
  const sockets = new Map();
  const send = (message) => engine?.write(JSON.stringify(message) + "\n");
  const direct = new Set(JSON.parse(process.env.PHOENIX_DIRECT_HOSTS ?? "[]").map((host) => host.toLowerCase()));
  const allowed = new Set();
  let upstream;
  if (direct.size) {
    const servers = fs.readFileSync("/etc/resolv.conf", "utf8").split("\n").flatMap((line) => /^nameserver\s+(\d+\.\d+\.\d+\.\d+)\s*$/.exec(line)?.[1] ?? []);
    if (!servers.length) throw new Error("No IPv4 nameserver for direct hosts");
    upstream = new Resolver({ timeout: 3000, tries: 2 });
    upstream.setServers(servers);
    const rule = (...args) => execFileSync("iptables", args, { stdio: "ignore" });
    rule("-N", "PHOENIX_DIRECT");
    rule("-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT");
    rule("-A", "OUTPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT");
    for (const server of servers) for (const protocol of ["udp", "tcp"]) rule("-A", "OUTPUT", "-d", server, "-p", protocol, "--dport", "53", "-j", "ACCEPT");
    rule("-A", "OUTPUT", "-j", "PHOENIX_DIRECT");
    rule("-P", "OUTPUT", "DROP");
    try { execFileSync("ip6tables", ["-P", "OUTPUT", "DROP"], { stdio: "ignore" }); } catch {}
  }
  const allow = (ip) => {
    if (allowed.has(ip)) return;
    execFileSync("iptables", ["-A", "PHOENIX_DIRECT", "-d", ip, "-p", "tcp", "--dport", "443", "-j", "ACCEPT"], { stdio: "ignore" });
    allowed.add(ip);
  };
  const forward = (socket, key) => {
    sockets.set(key, socket);
    socket.on("data", (data) => send({ type: "data", id: key, data: data.toString("base64") }));
    socket.on("end", () => send({ type: "end", id: key }));
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(key); send({ type: "close", id: key }); });
  };
  const control = net.createServer((socket) => {
    if (engine) return socket.destroy();
    engine = socket;
    send({ type: "ready" });
    readline.createInterface({ input: socket }).on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.type === "connect") {
          if (!Number.isSafeInteger(m.id) || m.id >= 0 || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535 || sockets.has(m.id)) throw new Error("Invalid loopback connection");
          forward(net.connect({ host: "127.0.0.1", port: m.port, allowHalfOpen: true }), m.id);
          return;
        }
        const peer = sockets.get(m.id);
        if (m.type === "data") peer?.write(Buffer.from(m.data, "base64"));
        else if (m.type === "end") peer?.end();
        else if (m.type === "close") peer?.destroy();
      } catch { socket.destroy(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => process.exit(1));
  });
  control.listen(path);
  const dns = dgram.createSocket("udp4");
  dns.on("message", async (query, peer) => {
    try {
      if (query.length < 17 || query.readUInt16BE(4) !== 1) return;
      let p = 12;
      const labels = [];
      while (query[p]) {
        const length = query[p++];
        if (length > 63 || p + length >= query.length) return;
        labels.push(query.subarray(p, p + length).toString("ascii"));
        p += length;
      }
      p++;
      if (p + 4 > query.length) return;
      const type = query.readUInt16BE(p);
      const host = labels.join(".").toLowerCase();
      const header = Buffer.from(query.subarray(0, 12));
      header.writeUInt16BE(0x8180, 2);
      header.writeUInt16BE(type === 1 ? 1 : 0, 6);
      header.writeUInt32BE(0, 8);
      const question = query.subarray(12, p + 4);
      let answer = Buffer.alloc(0);
      if (direct.has(host)) {
        if (type === 1) {
          const ips = (await upstream.resolve4(host)).slice(0, 8);
          for (const ip of ips) allow(ip);
          header.writeUInt16BE(ips.length, 6);
          answer = Buffer.concat(ips.map((ip) => Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, ...ip.split(".").map(Number)])));
        }
      } else if (type === 1) {
        if (!names.has(host)) {
          if (address >= 0xfffffe) return;
          const ip = `127.${address >> 16}.${(address >> 8) & 255}.${address & 255}`;
          address++;
          names.set(host, ip);
          hosts.set(ip, host);
        }
        answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, ...names.get(host).split(".").map(Number)]);
      }
      dns.send(Buffer.concat([header, question, answer]), peer.port, peer.address);
    } catch {}
  });
  dns.bind(53, "127.0.0.1");
  const ports = JSON.parse(process.env.PHOENIX_RELAY_PORTS ?? "[80,443,8080]");
  for (const port of ports) {
    net.createServer({ allowHalfOpen: true }, (socket) => {
      if (!engine) return socket.destroy();
      const key = ++id;
      send({ type: "open", id: key, host: hosts.get(socket.localAddress) ?? socket.localAddress, port });
      forward(socket, key);
    }).listen(port, "0.0.0.0");
  }
}
