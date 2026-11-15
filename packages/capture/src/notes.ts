import { readFile, access } from "node:fs/promises";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendNote } from "@phoenix/store";
import type { TraceEvent } from "@phoenix/formats";
import { sanitizeMessage, secretPolicy } from "./secrets.ts";

export async function note(options: { kind: "mark" | "task" | "correction"; text: string; root?: string; task?: string; op?: string; at?: string; oneOff?: boolean; cwd?: string }) {
  const home = process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix");
  const [run, task] = (options.root ?? process.env.PHOENIX_CAPTURE ?? "").split("#");
  let root = run;
  if (!root) throw new Error("Set PHOENIX_CAPTURE or name a capture directory");
  try { await access(join(root, "capture.json")); } catch { root = join(home, "captures", root); }
  const { capture } = JSON.parse(await readFile(join(root, "capture.json"), "utf8")) as { capture: string };
  const payload = options.kind === "task" ? JSON.stringify({ text: options.text, ...(options.cwd ? { cwd: options.cwd } : {}) }) : options.text;
  const result = await sanitizeMessage({ body: Buffer.from(payload) }, await secretPolicy(home));
  const event: TraceEvent = { v: 1, capture, stream: `note-${randomUUID()}`, seq: 0, ts: { wall: new Date().toISOString(), mono: process.hrtime.bigint().toString() }, kind: options.kind,
    ...(options.task || task ? { task: options.task ?? task } : {}), ...(options.op ? { op: options.op } : {}), ...(options.oneOff ? { op: "one-off" } : {}), body: { inline: Buffer.from(result.msg.body!).toString() }, secrets: result.changes };
  event.id = `${event.stream}:0`;
  if (options.at) Object.assign(event, { at: options.at });
  if (options.kind === "task" && options.op === "start") {
    const args = [fileURLToPath(new URL("./snapshot-worker.ts", import.meta.url)), resolve(root), home, resolve(options.cwd ?? process.env.PHOENIX_CWD ?? process.cwd()), options.task!, event.ts.wall, process.env.PHOENIX_COPY_IGNORED ?? "false"];
    const child = spawn(process.platform === "darwin" ? "taskpolicy" : process.execPath, process.platform === "darwin" ? ["-b", process.execPath, ...args] : args, { detached: true, stdio: "ignore" });
    child.on("error", () => {}); child.unref();
  }
  if (options.kind === "correction" || !process.env.PHOENIX_COLLECTOR) { await appendNote(root, event); return; }
  await new Promise<void>(resolve => {
    const socket = connect(process.env.PHOENIX_COLLECTOR!);
    let sent = false;
    const fallback = () => { if (sent) return; sent = true; clearTimeout(timeout); socket.destroy(); void appendNote(root, event).catch(() => {}).finally(resolve); };
    const timeout = setTimeout(fallback, 100);
    socket.once("error", fallback);
    socket.once("connect", () => { socket.end(JSON.stringify({ type: "note", event }) + "\n", () => { sent = true; clearTimeout(timeout); socket.destroy(); resolve(); }); });
  });
}
