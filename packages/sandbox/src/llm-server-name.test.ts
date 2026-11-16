import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import { connect } from "node:tls";
import { serverName } from "./llm.ts";

async function helloFor(servername: string): Promise<Buffer> {
  const server = createServer();
  const first = new Promise<Buffer>(resolve => server.once("connection", socket => socket.once("data", data => { resolve(data); socket.destroy(); })));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = connect({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, servername });
  client.on("error", () => {});
  const hello = await first;
  client.destroy();
  server.close();
  return hello;
}

test("the server name is read from a real TLS client hello", async () => {
  assert.deepEqual(serverName(await helloFor("llm.example.com")), { name: "llm.example.com" });
  assert.deepEqual(serverName(await helloFor("Other.Example.org")), { name: "other.example.org" });
});

test("a connection that is not a whole TLS client hello names no server", async () => {
  assert.equal(serverName(Buffer.from("GET / HTTP/1.1\r\nHost: llm.example.com\r\n\r\n")).name, null);
  const hello = await helloFor("llm.example.com");
  const split = Buffer.from(hello.subarray(0, 64));
  split.writeUInt16BE(59, 3);
  assert.equal(serverName(split).name, null);
});
