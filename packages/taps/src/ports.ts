import type { Surface } from "@phoenix/wire";
import type { Readable, Writable } from "node:stream";

export interface Frame {
  dir: "out" | "back";
  stream: number;
  bytes: Uint8Array;
  last: boolean;
  at: bigint;
}
export interface Link {
  write(frame: Frame): Promise<void>;
  frames(): AsyncIterable<Frame>;
  abort(why: string): void;
}
export interface Backend {
  open(connection: { surface: Surface; connector: string; meta: unknown }): Link;
}
export interface Stdio {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

export function frame(dir: Frame["dir"], stream: number, bytes: Uint8Array, last: boolean): Frame {
  return { dir, stream, bytes, last, at: process.hrtime.bigint() };
}

export function writeBytes(output: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
}

export function relayInput(input: Readable, link: Link, fragments: (bytes: Uint8Array) => { stream: number; bytes: Uint8Array; last: boolean }[], eofStream: () => number): { done: Promise<void>; stop(): void } {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const data = (bytes: Buffer): void => {
    input.pause();
    pending = pending.then(async () => {
      if (stopped) return;
      for (const part of fragments(bytes)) await link.write(frame("out", part.stream, part.bytes, part.last));
      if (!stopped) input.resume();
    });
    pending.catch(error => fail(error));
  };
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const end = (): void => { pending.then(() => stopped ? undefined : link.write(frame("out", eofStream(), new Uint8Array(), true))).then(finish, fail); };
  const error = (error: Error): void => fail(error);
  const stop = (): void => {
    stopped = true;
    input.pause();
    input.off("data", data).off("end", end).off("error", error);
    finish();
  };
  input.on("data", data).once("end", end).once("error", error);
  if (input.readableEnded) end();
  return { done, stop };
}
