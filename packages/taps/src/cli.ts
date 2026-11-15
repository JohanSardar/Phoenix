import { CLI_STREAM, cliInvocation, decodeCliControl, encodeCliControl, type CliControl, type TerminalSize } from "@phoenix/wire";
import type { ReadStream, WriteStream } from "node:tty";
import { frame, relayInput, writeBytes, type Backend, type Stdio } from "./ports.ts";

export interface SignalSource {
  on(signal: string, listener: () => void): unknown;
  off(signal: string, listener: () => void): unknown;
}

function terminal(stream: Stdio["stdin"] | Stdio["stdout"]): TerminalSize | null {
  const tty = stream as WriteStream;
  if (!tty.isTTY) return null;
  return { columns: tty.columns ?? process.stdout.columns ?? 80, rows: tty.rows ?? process.stdout.rows ?? 24 };
}

export async function cliTap(options: { backend: Backend; connector: string; argv: string[]; cwd?: string; env?: Record<string, string | undefined>; allowEnv: readonly string[]; io?: Stdio; signals?: SignalSource }): Promise<{ code: number | null; signal: string | null }> {
  const io = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const terminals = { stdin: terminal(io.stdin), stdout: terminal(io.stdout), stderr: terminal(io.stderr) };
  const invocation = cliInvocation({ argv: options.argv, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env, terminals }, options.allowEnv);
  const link = options.backend.open({ surface: "cli", connector: options.connector, meta: invocation });
  const cleanup: (() => void)[] = [];
  let controlFailure!: (error: unknown) => void;
  const controls = new Promise<never>((_, reject) => { controlFailure = reject; });
  let pending = Promise.resolve();
  const send = (control: CliControl): void => {
    pending = pending.then(() => link.write(frame("out", CLI_STREAM.control, encodeCliControl(control), true)));
    pending.catch(controlFailure);
  };
  const signals = options.signals ?? process;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGCONT"]) {
    const listener = () => send({ type: "signal", signal });
    signals.on(signal, listener);
    cleanup.push(() => { signals.off(signal, listener); });
  }
  for (const [fd, stream] of [io.stdin, io.stdout, io.stderr].entries()) if (terminal(stream)) {
    const resize = () => send({ type: "resize", fd: fd as 0 | 1 | 2, ...terminal(stream)! });
    stream.on("resize", resize);
    cleanup.push(() => { stream.off("resize", resize); });
  }
  const tty = io.stdin as ReadStream;
  const wasRaw = tty.isRaw;
  if (terminals.stdin && tty.setRawMode) {
    tty.setRawMode(true);
    cleanup.push(() => { tty.setRawMode(wasRaw ?? false); });
  }
  const input = relayInput(io.stdin, link, bytes => [{ stream: CLI_STREAM.stdin, bytes, last: false }], () => CLI_STREAM.stdin);
  const output = (async () => {
    for await (const f of link.frames()) {
      if (f.dir !== "back") throw new Error("Backend returned an outbound CLI frame");
      if (f.stream === CLI_STREAM.stdout || f.stream === CLI_STREAM.stderr) await writeBytes(f.stream === CLI_STREAM.stdout ? io.stdout : io.stderr, f.bytes);
      else if (f.stream === CLI_STREAM.control) {
        const control = decodeCliControl(f.bytes);
        if (control.type === "exit") return { code: control.code, signal: control.signal };
        throw new Error("Backend returned a non-exit CLI control");
      } else throw new Error("Backend returned an unknown CLI stream");
    }
    throw new Error("CLI Backend closed without an exit status");
  })();
  try {
    return await Promise.race([output, controls, input.done.then(() => output)]);
  } catch (error) {
    link.abort("CLI relay aborted");
    throw error;
  } finally {
    input.stop();
    for (const close of cleanup.reverse()) close();
  }
}

export function exitLikeCommand(exit: { code: number | null; signal: string | null }): void {
  if (exit.signal) process.kill(process.pid, exit.signal as NodeJS.Signals);
  else process.exitCode = exit.code ?? 1;
}
