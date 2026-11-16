import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { parse } from "yaml";
import { validate, type RecipeDescriptor } from "@phoenix/formats";
import type { SessionAnswer } from "./session.ts";

export interface ComposedMoment { session: string; at?: number; fromBeginning?: boolean; answers: SessionAnswer[]; timezone?: string }

const said = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

export async function composeMadeUp(o: { from: string; recipe: { directory: string; descriptor: RecipeDescriptor }; out: string }): Promise<ComposedMoment> {
  const resume = o.recipe.descriptor.resume;
  if (!resume?.compose) throw new Error(`The ${o.recipe.descriptor.name} recipe cannot write a made-up session`);
  const checked = validate("made-up", parse(await readFile(join(o.from, "moment.yaml"), "utf8")));
  if (!checked.ok) throw new Error(`Invalid made-up moment: ${checked.errors.join("; ")}`);
  const made = checked.value;
  const tools = (made.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, connector: tool.service, op: tool.op ?? tool.name }));
  const [command, ...args] = resume.compose;
  const child = spawn(command!, args, { cwd: o.recipe.directory, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ time: made.time, cwd: made.cwd ?? "/work", llm: made.llm, tools, messages: made.messages ?? [], prompt: made.prompt }));
  const [session, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), new Promise<number | null>(done => child.once("close", done))]);
  if (code !== 0) throw new Error(`The ${o.recipe.descriptor.name} recipe could not write the made-up session: ${stderr.trim().split("\n").at(-1) ?? code}`);
  await mkdir(o.out, { recursive: true, mode: 0o700 });
  const file = join(o.out, "session.jsonl");
  await writeFile(file, session, { mode: 0o600 });
  const answers: SessionAnswer[] = (made.world ?? []).map((entry, index) => {
    const [connector, ...op] = entry.tool.split(".");
    return {
      id: `world-${index + 1}`, connector: connector!, op: op.join("."), args: entry.args ?? {}, result: { content: [{ type: "text", text: said(entry.answer) }], isError: !!entry.error },
      observed_at: made.time, before_cut: false, world: entry.args ? "exact" : "any-args",
    };
  });
  const last = session.split("\n").filter(Boolean).length;
  return { session: file, ...(resume.from_beginning_only ? { fromBeginning: true } : { at: last }), answers, ...(made.timezone ? { timezone: made.timezone } : {}) };
}
