import { decodeCliControl, lineFragments } from "@phoenix/wire";
import { relayInput, writeBytes, type Backend, type Stdio } from "./ports.ts";

export const STDIO_STREAM = { stderr: -1, control: -2 } as const;

export async function mcpStdioTap(options: { backend: Backend; connector: string; io: Stdio; meta?: unknown }): Promise<{ code: number | null; signal: string | null } | undefined> {
  const link = options.backend.open({ surface: "mcp", connector: options.connector, meta: { transport: "stdio", details: options.meta } });
  let stream = 0;
  const input = relayInput(options.io.stdin, link, bytes => lineFragments(bytes).map(part => ({ ...part, stream: part.last ? stream++ : stream })), () => stream);
  const output = (async () => {
    let exit: { code: number | null; signal: string | null } | undefined;
    for await (const f of link.frames()) {
      if (f.dir !== "back") throw new Error("Backend returned an outbound stdio frame");
      if (f.stream === STDIO_STREAM.control) {
        const control = decodeCliControl(f.bytes);
        if (control.type !== "exit") throw new Error("Backend returned a non-exit stdio control");
        exit = { code: control.code, signal: control.signal };
      } else await writeBytes(f.stream === STDIO_STREAM.stderr ? options.io.stderr : options.io.stdout, f.bytes);
    }
    return exit;
  })();
  try {
    return await Promise.race([output, input.done.then(() => output)]);
  } catch (error) {
    link.abort("stdio relay aborted");
    throw error;
  } finally { input.stop(); }
}
