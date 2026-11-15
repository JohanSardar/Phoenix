import { CLI_STREAM, decodeCliControl, decodeCliInvocation, type CliInvocation } from "@phoenix/wire";
import type { TraceEvent } from "@phoenix/formats";

export interface CliReplayFrame {
  dir: "out" | "back";
  stream: number;
  bytes: string;
  last: boolean;
}

export const cliShape = (invocation: CliInvocation): { op: string; args: CliInvocation } => ({ op: invocation.argv[0] ?? "", args: invocation });

export async function cliRecording(events: readonly TraceEvent[], body: (e: TraceEvent) => Promise<Uint8Array>): Promise<{
  call: TraceEvent; result: TraceEvent; invocation: CliInvocation; frames: CliReplayFrame[];
} | undefined> {
  const open = events.find(e => e.op === "open") ?? events.find(e => e.kind === "call" && !e.op?.startsWith("frame:") && !e.op?.startsWith("fragment:"));
  const exit = events.find(e => e.kind === "result" && e.op === `frame:back:${CLI_STREAM.control}`);
  if (!open || !exit || events.some(e => e.partial)) return undefined;
  const bytes = await body(open);
  const value = JSON.parse(new TextDecoder().decode(bytes));
  const invocation = decodeCliInvocation(new TextEncoder().encode(JSON.stringify(open.op === "open" ? value.meta : value)));
  if (decodeCliControl(await body(exit)).type !== "exit") return undefined;
  const timed: { at: bigint; order: number; frame: CliReplayFrame }[] = [];
  for (const e of events) {
    const matched = /^(frame|fragment):(out|back):([0-3])$/.exec(e.op ?? "");
    if (!matched || e.kind === "meta" && (e.body || matched[1] === "fragment")) continue;
    const bytes = e.body ? await body(e) : new Uint8Array();
    const chunks = e.chunks?.length ? e.chunks : [{ offset: 0, at: e.ts.mono ?? "0" }];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      timed.push({ at: BigInt(chunk.at), order: timed.length, frame: {
        dir: matched[2] as "out" | "back", stream: Number(matched[3]),
        bytes: Buffer.from(bytes.subarray(chunk.offset, chunks[i + 1]?.offset ?? bytes.length)).toString("base64"),
        last: matched[1] === "frame" && i === chunks.length - 1,
      } });
    }
  }
  timed.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order);
  return { call: open, result: exit, invocation, frames: timed.map(e => e.frame) };
}
