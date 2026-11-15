import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { ContainerSandbox, writeClockFile } from "../src/index.ts";

test("the faked clock preserves the caller's captured timezone", async () => {
  const directory = await mkdtemp(join(import.meta.dirname, "scratch-s1-"));
  let process;
  try {
    const time = "2001-02-03T04:05:06.000Z";
    const clockFile = join(directory, "clock");
    await writeClockFile(clockFile, time);
    const sandbox = new ContainerSandbox();
    ({ process } = await sandbox.start({
      image: "phoenix-sandbox:proof",
      argv: ["node", "-e", "console.log(JSON.stringify({ now: new Date().toISOString(), offset: new Date().getTimezoneOffset(), timezone: process.env.TZ }))"],
      env: { TZ: "America/Chicago" },
      mounts: [],
      clockFile,
    }));
    process.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      text(process.stdout), text(process.stderr), process.exited,
    ]);
    assert.equal(exit.code, 0, stderr);
    const observed = JSON.parse(stdout);
    console.log("sandbox clock:", observed);
    assert.match(observed.now, /^2001-02-03T04:05:/);
    assert.equal(observed.offset, 360, "February in America/Chicago is UTC-06:00, not UTC");
  } finally {
    await process?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
